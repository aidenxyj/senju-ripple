// Paying for hosted sessions.
//
// A person either saves their own model settings (free) or runs on the server's model (LLM_* settings). That needs
// an active subscription. Each paid invoice adds the plan's credits to their balance, they can buy
// more, and every hosted session they start is charged for the tokens it used. A session stops
// when its owner's balance reaches zero, so the server's model never runs unpaid.
//
// Money is counted in micro-dollars (1,000,000 = $1.00) so that small token costs are not rounded away.
// Stripe is called over plain HTTPS with no library: three calls and one signature check.
import crypto from 'node:crypto';

export const MICRO = 1_000_000;
const num = (v, fallback) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : fallback);

// What we charge is what the model costs us, times a markup. Rates are dollars per million tokens, set from env
// (SENJU_RATE_INPUT, SENJU_RATE_OUTPUT, SENJU_RATE_CACHE_READ, SENJU_RATE_CACHE_WRITE). The defaults ($0.10 in,
// $0.30 out) are placeholders: set them to your provider's price list, or, for a server you rent by the hour,
// from that hourly cost and your traffic.
export function pricing(env = process.env) {
  return {
    input: num(env.SENJU_RATE_INPUT, 0.1),
    output: num(env.SENJU_RATE_OUTPUT, 0.3),
    cacheRead: num(env.SENJU_RATE_CACHE_READ, 0.1),
    cacheWrite: num(env.SENJU_RATE_CACHE_WRITE, 0.1),
    markup: num(env.SENJU_MARKUP, 1.3),
    planUsd: num(env.SENJU_PLAN_USD, 20),                  // the monthly price
    planCreditsUsd: num(env.SENJU_PLAN_CREDITS_USD, 20),   // credits added by each paid month
    topups: String(env.SENJU_TOPUPS_USD ?? '10,25,50').split(',').map(Number).filter((n) => n > 0),
    minStartMicro: num(env.SENJU_MIN_START_USD, 0.5) * MICRO,   // a session needs at least this much to start
  };
}

// The price of a session so far, in micro-dollars. `usage` is the running total the swarm reports.
export function costMicro(usage, p) {
  const dollars = ((usage.input ?? 0) * p.input + (usage.output ?? 0) * p.output + (usage.cacheRead ?? 0) * p.cacheRead + (usage.cacheWrite ?? 0) * p.cacheWrite) / 1e6;
  return Math.ceil(dollars * p.markup * MICRO);
}

export const dollars = (micro) => `$${(micro / MICRO).toFixed(2)}`;
export const isActive = (status) => status === 'active' || status === 'trialing';

// ---- Stripe ------------------------------------------------------------------------------------

// Stripe takes form fields, with nesting written as a[b][0][c]=v.
export function formEncode(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') formEncode(v, key, out); else out.append(key, String(v));
  }
  return out;
}

// A webhook is genuine if its signature is an HMAC of "<time>.<body>" under our endpoint secret,
// and it is recent. Returns the parsed event, or throws.
export function verifyWebhook(rawBody, header, secret, { tolerance = 300, now = Date.now() / 1000 } = {}) {
  const parts = Object.fromEntries(String(header ?? '').split(',').map((kv) => kv.trim().split('=')).filter((p) => p.length === 2).map(([k, v]) => [k, v]));
  const given = String(header ?? '').split(',').map((kv) => kv.trim()).filter((kv) => kv.startsWith('v1=')).map((kv) => kv.slice(3));
  if (!parts.t || given.length === 0) throw new Error('No signature.');
  if (Math.abs(now - Number(parts.t)) > tolerance) throw new Error('The signature is too old.');
  const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest('hex');
  const match = given.some((sig) => sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)));
  if (!match) throw new Error('The signature does not match.');
  return JSON.parse(rawBody);
}

export class Billing {
  constructor({ store, env = process.env, fetchImpl = fetch, log = () => {} }) {
    this.store = store;
    this.p = pricing(env);
    this.secretKey = env.STRIPE_SECRET_KEY || '';
    this.webhookSecret = env.STRIPE_WEBHOOK_SECRET || '';
    this.api = (env.STRIPE_API_BASE || 'https://api.stripe.com').replace(/\/+$/, '');
    this.fetch = fetchImpl;
    this.log = log;
  }

  get enabled() { return Boolean(this.secretKey); }

  async stripe(path, params) {
    if (!this.enabled) throw new Error('Payments are not set up on this server.');
    const res = await this.fetch(`${this.api}/v1/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.secretKey}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: formEncode(params).toString(),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error?.message ?? `Stripe answered ${res.status}.`);
    return body;
  }

  // What the web app shows.
  async summary(userId, { hasOwnModel = false, hosted = false } = {}) {
    const b = await this.store.getBilling(userId);
    return {
      hosted, payments: this.enabled, hasOwnModel,
      status: b.status ?? 'none', active: isActive(b.status), periodEnd: b.periodEnd ?? null,
      credits: b.credits, creditsText: dollars(b.credits),
      plan: { usd: this.p.planUsd, creditsUsd: this.p.planCreditsUsd }, topups: this.p.topups, markup: this.p.markup,
    };
  }

  // Each person is one Stripe customer, created the first time they pay. Having it before checkout
  // means every later event can be matched to them, whatever order Stripe sends events in.
  async customerFor(user) {
    const b = await this.store.getBilling(user.id);
    if (b.customerId) return b.customerId;
    const customer = await this.stripe('customers', { email: user.email, name: user.name, metadata: { user_id: user.id } });
    await this.store.setBilling(user.id, { customerId: customer.id });
    return customer.id;
  }

  // Returns a Stripe-hosted page to send the person to.
  async checkout(user, { kind, amount }, origin) {
    const b = await this.store.getBilling(user.id);
    const common = {
      customer: await this.customerFor(user), client_reference_id: user.id,
      success_url: `${origin}/?billing=done`, cancel_url: `${origin}/?billing=cancelled`,
    };
    if (kind === 'subscribe') {
      if (isActive(b.status)) throw new Error('You already have a subscription.');
      const session = await this.stripe('checkout/sessions', {
        ...common, mode: 'subscription',
        line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: Math.round(this.p.planUsd * 100), recurring: { interval: 'month' }, product_data: { name: 'Senju team plan', description: `Hosted sessions. Each month adds ${dollars(this.p.planCreditsUsd * MICRO)} of credits.` } } }],
        metadata: { kind: 'subscribe', user_id: user.id }, subscription_data: { metadata: { user_id: user.id } },
      });
      return session.url;
    }
    if (kind === 'topup') {
      if (!isActive(b.status)) throw new Error('Subscribe first. Extra credits are for subscribers.');
      const usd = Number(amount);
      if (!this.p.topups.includes(usd)) throw new Error(`Choose one of: ${this.p.topups.map((n) => `$${n}`).join(', ')}.`);
      const session = await this.stripe('checkout/sessions', {
        ...common, mode: 'payment',
        line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: usd * 100, product_data: { name: `Senju credits, $${usd}` } } }],
        metadata: { kind: 'topup', user_id: user.id, credit_cents: usd * 100 },
      });
      return session.url;
    }
    throw new Error('Unknown purchase.');
  }

  // Stripe's own page for changing the card or cancelling.
  async portal(user, origin) {
    const b = await this.store.getBilling(user.id);
    if (!b.customerId) throw new Error('There is nothing to manage yet.');
    return (await this.stripe('billing_portal/sessions', { customer: b.customerId, return_url: `${origin}/` })).url;
  }

  // One Stripe event. Safe to receive twice: credits are keyed by the event's id.
  async handleEvent(event) {
    const o = event?.data?.object ?? {};
    const userOf = async () => (o.customer ? await this.store.userByCustomer(o.customer) : null) ?? o.metadata?.user_id ?? o.client_reference_id ?? null;
    switch (event.type) {
      case 'checkout.session.completed': {
        if (o.mode !== 'payment' || o.metadata?.kind !== 'topup' || o.payment_status !== 'paid') return 'ignored';
        const user = await userOf();
        const cents = Number(o.metadata.credit_cents);
        // The amount credited is what we asked Stripe to charge, and Stripe must agree it was charged.
        if (!user || !(cents > 0) || Number(o.amount_subtotal) !== cents) { this.log('billing: top-up did not add up', event.id); return 'rejected'; }
        await this.store.applyCredit({ userId: user, deltaMicro: cents * 10_000, kind: 'topup', eventId: event.id, note: `Bought $${(cents / 100).toFixed(2)} of credits` });
        return 'credited';
      }
      case 'invoice.paid': {
        // The first invoice and every renewal. Each adds the month's credits; unused credits carry over.
        const user = await userOf();
        if (!user) { this.log('billing: invoice for an unknown customer', event.id); return 'rejected'; }
        if (!(Number(o.amount_paid) > 0)) return 'ignored';
        const periodEnd = o.lines?.data?.[0]?.period?.end;
        await this.store.setBilling(user, { status: 'active', ...(periodEnd ? { periodEnd: new Date(periodEnd * 1000).toISOString() } : {}) });
        await this.store.applyCredit({ userId: user, deltaMicro: Math.round(this.p.planCreditsUsd * MICRO), kind: 'plan', eventId: event.id, note: 'Monthly credits' });
        return 'credited';
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const user = await userOf();
        if (!user) return 'rejected';
        await this.store.setBilling(user, { status: event.type.endsWith('deleted') ? 'canceled' : o.status, subscriptionId: o.id });
        return 'updated';
      }
      default: return 'ignored';
    }
  }
}
