// Billing test: prices, Stripe's signature, what each Stripe event does, and a hub that charges
// hosted sessions and stops them when the money runs out. Stripe is a local stand-in; no network.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import WebSocket from 'ws';
import { Billing, costMicro, formEncode, pricing, verifyWebhook, MICRO } from '../server/billing.js';
import { Hub } from '../server/hub.js';
import { MemoryStore } from '../server/store-memory.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, what, ms = 8000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(20); } };

// ---- prices ----------------------------------------------------------------------------------
const p = pricing({});
assert.equal(costMicro({ input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 1e6 }, p), 780_000);   // (0.1 + 0.3 + 0.1 + 0.1) x 1.3
assert.equal(costMicro({ input: 1, output: 0 }, p), 1);                                                 // rounds up, never to zero
assert.equal(pricing({ SENJU_MARKUP: '2', SENJU_PLAN_USD: '30' }).markup, 2);
assert.equal(formEncode({ a: 1, b: { c: [{ d: 'x y' }] }, skip: undefined }).toString(), 'a=1&b%5Bc%5D%5B0%5D%5Bd%5D=x+y');

// ---- Stripe's signature ----------------------------------------------------------------------
const SECRET = 'whsec_test';
const sign = (body, t = Math.floor(Date.now() / 1000), secret = SECRET) => `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
const body = JSON.stringify({ id: 'evt_1', type: 'ping' });
assert.equal(verifyWebhook(body, sign(body), SECRET).id, 'evt_1');
assert.throws(() => verifyWebhook(body.replace('ping', 'pong'), sign(body), SECRET), /does not match/);
assert.throws(() => verifyWebhook(body, sign(body, undefined, 'whsec_other'), SECRET), /does not match/);
assert.throws(() => verifyWebhook(body, sign(body, Math.floor(Date.now() / 1000) - 3600), SECRET), /too old/);
assert.throws(() => verifyWebhook(body, '', SECRET), /No signature/);

// ---- a stand-in for Stripe's API ---------------------------------------------------------------
const calls = [];
const stripe = http.createServer((req, res) => {
  let data = '';
  req.on('data', (c) => (data += c));
  req.on('end', () => {
    const form = Object.fromEntries(new URLSearchParams(data));
    calls.push({ path: req.url, auth: req.headers.authorization, form });
    const reply = req.url === '/v1/customers' ? { id: `cus_${calls.filter((c) => c.path === '/v1/customers').length}` }
      : req.url === '/v1/checkout/sessions' ? { id: 'cs_1', url: `https://pay.example/${form.mode}` }
      : req.url === '/v1/billing_portal/sessions' ? { url: 'https://pay.example/portal' } : null;
    res.writeHead(reply ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply ?? { error: { message: 'No such route' } }));
  });
});
await new Promise((r) => stripe.listen(0, r));

const store = new MemoryStore();
store.addTeam('t1', 'Robotics');
const tokens = { james: store.addUser('james', 'James', 't1'), linda: store.addUser('linda', 'Linda', 't1'), mona: store.addUser('mona', 'Mona', 't1') };
const user = (id) => store.users.get(id);
const billing = new Billing({ store, env: { SENJU_RATE_INPUT: '2', SENJU_RATE_OUTPUT: '10', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: SECRET, STRIPE_API_BASE: `http://127.0.0.1:${stripe.address().port}` } });
const origin = 'https://hub.example';

// Buying credits needs a subscription first.
await assert.rejects(billing.checkout(user('linda'), { kind: 'topup', amount: 10 }, origin), /Subscribe first/);
assert.equal(await billing.checkout(user('linda'), { kind: 'subscribe' }, origin), 'https://pay.example/subscription');
const sub = calls.at(-1).form;
assert.equal(calls.at(-1).auth, 'Bearer sk_test_x');
assert.equal(sub.customer, 'cus_1');
assert.equal(sub['line_items[0][price_data][unit_amount]'], '2000');
assert.equal(sub['line_items[0][price_data][recurring][interval]'], 'month');
assert.equal(sub.success_url, 'https://hub.example/?billing=done');
assert.equal((await store.getBilling('linda')).customerId, 'cus_1');

// The invoice is paid: the subscription is active and the month's credits arrive. Once, even if told twice.
const paid = { id: 'evt_inv_1', type: 'invoice.paid', data: { object: { customer: 'cus_1', amount_paid: 2000, lines: { data: [{ period: { end: 1800000000 } }] } } } };
assert.equal(await billing.handleEvent(paid), 'credited');
assert.equal(await billing.handleEvent(paid), 'credited');
let linda = await store.getBilling('linda');
assert.equal(linda.status, 'active');
assert.equal(linda.credits, 20 * MICRO);
assert.equal(store.ledger.length, 1);
await assert.rejects(billing.checkout(user('linda'), { kind: 'subscribe' }, origin), /already have/);

// A top-up: only the amounts on offer, and only credited when Stripe says that amount was paid.
await assert.rejects(billing.checkout(user('linda'), { kind: 'topup', amount: 7 }, origin), /Choose one of/);
assert.equal(await billing.checkout(user('linda'), { kind: 'topup', amount: 10 }, origin), 'https://pay.example/payment');
assert.equal(calls.filter((c) => c.path === '/v1/customers').length, 1);   // the same customer, not a new one
const top = (id, over = {}) => ({ id, type: 'checkout.session.completed', data: { object: { mode: 'payment', payment_status: 'paid', customer: 'cus_1', amount_subtotal: 1000, metadata: { kind: 'topup', user_id: 'linda', credit_cents: '1000' }, ...over } } });
assert.equal(await billing.handleEvent(top('evt_top_1')), 'credited');
assert.equal((await store.getBilling('linda')).credits, 30 * MICRO);
assert.equal(await billing.handleEvent(top('evt_top_2', { amount_subtotal: 100 })), 'rejected');     // paid $1, asked for $10 of credits
assert.equal(await billing.handleEvent(top('evt_top_3', { payment_status: 'unpaid' })), 'ignored');
assert.equal(await billing.handleEvent({ id: 'evt_x', type: 'invoice.paid', data: { object: { customer: 'cus_unknown', amount_paid: 2000 } } }), 'rejected');
assert.equal((await store.getBilling('linda')).credits, 30 * MICRO);
assert.equal(await billing.portal(user('linda'), origin), 'https://pay.example/portal');
const summary = await billing.summary('linda', { hosted: true });
assert.deepEqual([summary.active, summary.creditsText, summary.topups], [true, '$30.00', [10, 25, 50]]);

// ---- the hub charges hosted sessions -------------------------------------------------------------
// Every model call here reports 100k input and 20k output tokens. Rates are pinned above ($2 in, $10 out per M) so
// the amounts stay round: (0.2 + 0.2) x 1.3 = $0.52.
const PER_CALL = 520_000;
const seen = { keys: [], calls: 0 };
let endless = false;
const makeLlm = (key) => ({
  async create(params, { signal } = {}) {
    await sleep(10);
    if (signal?.aborted) throw new Error('aborted');
    seen.keys.push(key); seen.calls++;
    const usage = { input_tokens: 100000, output_tokens: 20000 };
    const isLead = params.tools?.[0]?.name === 'spawn_agent';
    const last = params.messages.at(-1);
    const lastText = typeof last.content === 'string' ? last.content : last.content.map((b) => b.text ?? (typeof b.content === 'string' ? b.content : '')).join('\n');
    if (isLead && /retrospective/.test(lastText)) return { content: [{ type: 'text', text: 'Nothing worth saving.' }], stop_reason: 'end_turn', usage };
    if (isLead && endless) return { content: [{ type: 'tool_use', id: `t${seen.calls}`, name: 'board_read', input: {} }], stop_reason: 'tool_use', usage };
    return { content: [{ type: 'text', text: 'All done.' }], stop_reason: 'end_turn', usage };
  },
});
const config = { model: 'm', plannerModel: 'm', maxAgents: 2, maxSteps: 50, tokenBudget: 1e9, context: { enabled: false } };
const server = http.createServer();
const hub = new Hub({ store, makeLlm, config, hostedKey: 'sk-hosted', pricing: billing.p });
hub.listen(server);
await new Promise((r) => server.listen(0, r));
const connect = async (who) => {
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
  const c = { got: [], say: (m) => ws.send(JSON.stringify(m)), ws };
  ws.on('message', (d) => c.got.push(JSON.parse(d)));
  await new Promise((r) => ws.on('open', r));
  c.say({ t: 'hello', token: tokens[who], role: 'device', device: { id: `d-${who}`, name: `${who} Mac`, platform: 'darwin' } });   // sessions start from the desktop app
  await until(() => c.got.find((m) => m.t === 'welcome'), `${who} welcome`);
  return c;
};
const error = (c) => c.got.find((m) => m.t === 'error');
const idle = () => until(() => !hub.teams.get('t1')?.session && [...store.sessions.values()].every((s) => s.status !== 'running'), 'the session to end');
const jamesWeb = await connect('james'), lindaWeb = await connect('linda'), monaWeb = await connect('mona');

// Mona has neither a key nor a plan.
monaWeb.say({ t: 'start', goal: 'tidy the notes' });
assert.equal((await until(() => error(monaWeb), 'no plan')).code, 'no_plan');
// A plan but too little left to begin.
await store.setBilling('mona', { status: 'active' });
await store.applyCredit({ userId: 'mona', deltaMicro: 200_000, kind: 'adjust' });
monaWeb.got.length = 0;
monaWeb.say({ t: 'start', goal: 'tidy the notes' });
assert.equal((await until(() => error(monaWeb), 'no credits')).code, 'no_credits');
assert.equal(seen.calls, 0);

// Linda subscribes, so her session runs on the server's key and comes off her balance.
lindaWeb.say({ t: 'start', goal: 'summarise the meeting' });
await until(() => store.sessions.size === 1, 'linda session');
await idle();
await sleep(300);   // the retrospective is charged just after
assert.ok(seen.keys.length >= 1 && seen.keys.every((k) => k === 'sk-hosted'));
linda = await store.getBilling('linda');
assert.equal(linda.credits, 30 * MICRO - seen.calls * PER_CALL);
const charges = store.ledger.filter((l) => l.kind === 'usage');
assert.ok(charges.length >= 1 && charges.every((l) => l.userId === 'linda' && l.deltaMicro < 0 && l.sessionId));
const [lindaSession] = [...store.sessions.values()];
assert.equal(lindaSession.billing, 'hosted');
assert.ok(lindaSession.costMicro >= PER_CALL);
// Her balance is shown to her and to nobody else.
assert.ok(lindaWeb.got.some((m) => m.event?.type === 'credits' && m.event.balance === linda.credits));
assert.ok(!jamesWeb.got.some((m) => m.event?.type === 'credits') && !monaWeb.got.some((m) => m.event?.type === 'credits'));

// James saved his own key: it is used, and nothing is charged even though the server sells credits.
await store.setKey('james', 'sk-james');
const before = { calls: seen.calls, ledger: store.ledger.length };
jamesWeb.say({ t: 'start', goal: 'check the calendar' });
await until(() => store.sessions.size === 2, 'james session');
await idle();
await sleep(300);
assert.ok(seen.keys.slice(before.calls).every((k) => k === 'sk-james'));
assert.equal(store.ledger.length, before.ledger);
assert.equal((await store.getBilling('james')).credits, 0);
assert.equal([...store.sessions.values()][1].billing, 'own_key');

// Mona has $0.60. A job that would never end is stopped when that is gone, a call or two later.
await store.applyCredit({ userId: 'mona', deltaMicro: 400_000, kind: 'adjust' });
endless = true;
const at = seen.calls;
monaWeb.got.length = 0;
monaWeb.say({ t: 'start', goal: 'keep reading the board forever' });
await until(() => store.sessions.size === 3, 'mona session');
await until(() => monaWeb.got.some((m) => m.event?.type === 'notice' && /out of credits/.test(m.event.message)), 'out of credits notice');
endless = false;
await idle();
await sleep(300);
assert.ok(seen.calls - at <= 6, `stopped after ${seen.calls - at} calls`);
assert.ok((await store.getBilling('mona')).credits <= 0);
assert.equal([...store.sessions.values()][2].status, 'stopped');
// And she cannot start another until she adds credits.
monaWeb.got.length = 0;
monaWeb.say({ t: 'start', goal: 'again' });
assert.equal((await until(() => error(monaWeb), 'blocked')).code, 'no_credits');

for (const c of [jamesWeb, lindaWeb, monaWeb]) c.ws.close();
server.close(); stripe.close();
console.log('billing test passed');
setTimeout(() => process.exit(0), 100);
