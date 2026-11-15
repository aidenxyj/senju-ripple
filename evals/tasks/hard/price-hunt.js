// Parallel: three shops on three ports. Buy three items from the one shop with the lowest total including
// shipping. Traps: the shop with the cheapest items is not the cheapest after shipping, and the cheapest shop
// only wins because of a free-shipping rule you see in its cart. Near-miss products (1 m cable, 4-in-1 hub) sit nearby.
import { serve, page, esc, money } from '../../lib/site.mjs';

const WANT = ['laptop stand', 'usb-c hub', 'hdmi cable'];
const SHOPS = [
  { key: 'a', name: 'Gadget Barn', shipping: 7.50, freeOver: null, items: [
    ['a1', 'Laptop stand, aluminium', 34.99, 'stand'], ['a2', 'USB-C hub, 7-in-1', 39.99, 'hub'], ['a3', 'HDMI cable, 2 m', 9.99, 'cable'],
    ['a4', 'HDMI cable, 1 m', 6.99], ['a5', 'USB-C hub, 4-in-1', 24.99], ['a6', 'Laptop sleeve, 14 inch', 19.99], ['a7', 'Mouse pad, XL', 12.00] ] },
  { key: 'b', name: 'Volt & Co', shipping: 4.95, freeOver: null, items: [
    ['b1', 'Wireless mouse', 21.00], ['b2', 'Aluminium Laptop Stand', 29.99, 'stand'], ['b3', 'HDMI 2.1 cable (3 m)', 15.49],
    ['b4', '7-in-1 USB-C Hub', 44.50, 'hub'], ['b5', 'HDMI 2.1 cable (2 m)', 12.49, 'cable'], ['b6', 'Webcam 1080p', 49.00] ] },
  { key: 'c', name: 'Deskwise', shipping: 9.00, freeOver: 80, items: [
    ['c1', 'Ergo laptop stand (aluminium)', 38.00, 'stand'], ['c2', 'Monitor arm', 79.00], ['c3', 'Hub: USB-C, 7 ports in 1', 36.00, 'hub'],
    ['c4', 'Cable, HDMI, 2 metre', 11.00, 'cable'], ['c5', 'Cable, HDMI, 50 cm', 5.00], ['c6', 'Desk lamp', 27.50] ] },
];
// Totals with shipping: Gadget Barn 92.47, Volt & Co 91.93, Deskwise 85.00 (free shipping over $80). Deskwise wins.
const BEST = 'c';

const totals = (shop, cart) => {
  const sub = cart.reduce((s, id) => s + shop.items.find((i) => i[0] === id)[2], 0);
  const ship = cart.length === 0 ? 0 : shop.freeOver != null && sub >= shop.freeOver ? 0 : shop.shipping;
  return { sub, ship, total: sub + ship };
};

function app(shop, state) {
  const carts = new Map();
  return async ({ method, path: p, body, cookies }) => {
    let sid = cookies.sid;
    let cookie;
    if (!sid || !carts.has(sid)) { sid = Math.random().toString(36).slice(2); carts.set(sid, []); cookie = `sid=${sid}; Path=/`; }
    const cart = carts.get(sid);
    const wrap = (out) => ({ ...out, cookie });
    const banner = shop.freeOver != null ? `<p><strong>Free shipping on orders of ${money(shop.freeOver)} or more.</strong></p>` : `<p>Flat shipping ${money(shop.shipping)} per order.</p>`;
    if (p === '/' && method === 'GET') {
      const rows = shop.items.map(([id, name, price]) => `<li>${esc(name)}: ${money(price)}
        <form method="post" action="/cart/add" style="display:inline"><input type="hidden" name="id" value="${id}"><button>Add ${esc(name)} to cart</button></form></li>`).join('');
      return wrap({ html: page(shop.name, `<h1>${esc(shop.name)}</h1>${banner}<p><a href="/cart">Cart (${cart.length})</a></p><ul>${rows}</ul>`) });
    }
    if (p === '/cart/add' && method === 'POST') {
      if (shop.items.some((i) => i[0] === body.id)) cart.push(body.id);
      return wrap({ redirect: '/' });
    }
    if (p === '/cart/remove' && method === 'POST') {
      const i = cart.indexOf(body.id);
      if (i >= 0) cart.splice(i, 1);
      return wrap({ redirect: '/cart' });
    }
    if (p === '/cart' && method === 'GET') {
      const t = totals(shop, cart);
      const lines = cart.map((id) => { const it = shop.items.find((i) => i[0] === id);
        return `<li>${esc(it[1])}: ${money(it[2])} <form method="post" action="/cart/remove" style="display:inline"><input type="hidden" name="id" value="${id}"><button>Remove ${esc(it[1])}</button></form></li>`; }).join('');
      return wrap({ html: page(`${shop.name}: cart`, `<h1>Your cart</h1><p><a href="/">Keep shopping</a></p><ul>${lines || '<li>Empty</li>'}</ul>
        <p>Subtotal: ${money(t.sub)}<br>Shipping: ${t.ship === 0 && cart.length ? 'FREE' : money(t.ship)}<br><strong>Total: ${money(t.total)}</strong></p>
        <form method="post" action="/checkout"><label for="name">Ship to (name)</label> <input id="name" name="name"><br>
        <label for="address">Address</label> <input id="address" name="address"><br><button>Place order</button></form>`) });
    }
    if (p === '/checkout' && method === 'POST') {
      if (!cart.length) return wrap({ html: page('Error', '<p>Your cart is empty.</p>') });
      if (!body.name?.trim() || !body.address?.trim()) return wrap({ html: page('Error', '<p>Name and address are required. <a href="/cart">Back</a></p>') });
      const t = totals(shop, cart);
      state.orders.push({ shop: shop.key, items: [...cart], name: body.name.trim(), address: body.address.trim(), total: Math.round(t.total * 100) / 100 });
      cart.length = 0;
      return wrap({ html: page('Order placed', `<h1>Thank you!</h1><p>Order total ${money(t.total)}.</p>`) });
    }
    return null;
  };
}

// Partial credit for evals' autoresearch loop, in task order. Does not change pass.
// The shops' request logs (ctx.sites) show where the agent looked and what it put in a cart.
function milestones({ state, sites = [] }) {
  const exact = (o) => { const shop = SHOPS.find((s) => s.key === o.shop);
    return o.items.map((id) => shop.items.find((i) => i[0] === id)?.[3] ?? '?').sort().join(',') === 'cable,hub,stand'; };
  const added = SHOPS.map((shop, i) => new Set((sites[i]?.requests ?? []).filter((r) => r.path === '/cart/add')
    .map((r) => shop.items.find((it) => it[0] === r.body.id)?.[3]).filter(Boolean)));
  const { orders } = state;
  return [
    { name: 'visited_all_shops', ok: sites.length === SHOPS.length && sites.every((s) => s.requests.some((r) => r.method === 'GET' && r.path === '/')) },
    { name: 'cart_had_all_three_somewhere', ok: added.some((kinds) => kinds.size === 3) || orders.some(exact) },
    { name: 'ordered_once', ok: orders.length === 1 },
    { name: 'ordered_right_items', ok: orders.some(exact) },
    { name: 'ordered_at_cheapest', ok: orders.some((o) => o.shop === BEST && exact(o)) },
  ];
}

// Pass or fail, all or nothing.
function judge({ state }) {
  const { orders } = state;
  if (orders.length === 0) return { pass: false, detail: 'no order was placed' };
  if (orders.length > 1) return { pass: false, detail: `${orders.length} orders placed: ${orders.map((o) => o.shop).join(', ')}` };
  const o = orders[0];
  const shop = SHOPS.find((s) => s.key === o.shop);
  const kinds = o.items.map((id) => shop.items.find((i) => i[0] === id)[3] ?? `wrong item ${id}`).sort();
  if (kinds.join(',') !== 'cable,hub,stand') return { pass: false, detail: `${shop.name} order has ${kinds.join(', ')}` };
  if (!/ada lovelace/i.test(o.name)) return { pass: false, detail: `shipped to ${o.name}` };
  if (o.shop !== BEST) return { pass: false, detail: `ordered at ${shop.name} for ${money(o.total)}; Deskwise was ${money(85)}` };
  return { pass: true, detail: `ordered at Deskwise for ${money(o.total)}` };
}

export default {
  id: 'price-hunt',
  goal: 'Three online shops sell desk gear: Gadget Barn at {urlA}, Volt & Co at {urlB} and Deskwise at {urlC}. '
    + 'Buy one aluminium laptop stand, one 7-in-1 USB-C hub and one 2 m HDMI cable, all from the same shop: the shop where the order total including shipping is lowest. '
    + 'Ship to Ada Lovelace, 12 St James\'s Square, London. Place exactly one order in total, and do not order anything else.',
  servers: ['browser'],
  timeout: 600,
  maxSteps: 150,
  async setup(ctx) {
    ctx.state = { orders: [] };
    ctx.sites = await Promise.all(SHOPS.map((s) => serve(app(s, ctx.state))));
    [ctx.urlA, ctx.urlB, ctx.urlC] = ctx.sites.map((s) => s.url);
  },
  check: (ctx) => ({ ...judge(ctx), milestones: milestones(ctx) }),
  teardown: ({ sites }) => Promise.all((sites ?? []).map((s) => s.close())),
  SHOPS, WANT,
  stub: [
    ({ ctx }) => ({ name: 'browser__browser_navigate', input: { url: ctx.urlC } }),
    { name: 'browser__browser_run_code_unsafe', input: { code: `async (page) => {
      for (const n of ['Ergo laptop stand (aluminium)', 'Hub: USB-C, 7 ports in 1', 'Cable, HDMI, 2 metre'])
        await page.getByRole('button', { name: 'Add ' + n + ' to cart' }).click();
      await page.getByRole('link', { name: /Cart/ }).click();
      await page.getByLabel('Ship to (name)').fill('Ada Lovelace');
      await page.getByLabel('Address').fill("12 St James's Square, London");
      await page.getByRole('button', { name: 'Place order' }).click();
      return await page.title(); }` } },
  ],
};
