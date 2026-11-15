// Big page: start a return for one past order on a store whose home page is about 40k characters (Amazon's is
// about 34k), so a 6000-character look shows only its first part. Traps: the order history link is only in the
// footer, after 300 product cards, at a path that is hard to guess; the department links are icons with no name;
// and the order history has 30 orders, each with an identical "Start a return" button, so the right one is the
// button in the card that names the mug. Pass: exactly the mug's order has a return, nothing else was returned.
import { serve, page, esc, money } from '../../lib/site.mjs';

const WORDS = ['Steel', 'Bamboo', 'Linen', 'Walnut', 'Copper', 'Glass', 'Cotton', 'Marble', 'Oak', 'Wool'];
const THINGS = ['water bottle', 'desk lamp', 'notebook', 'phone stand', 'tea towel', 'cutting board', 'plant pot', 'wall clock', 'pillow cover', 'pen set'];
const PRODUCTS = Array.from({ length: 300 }, (_, i) => ({ id: 1000 + i, name: `${WORDS[i % 10]} ${THINGS[Math.floor(i / 10) % 10]}, model ${100 + i}`, price: 5 + ((i * 37) % 90) + 0.99 }));
const DEPTS = ['kitchen', 'office', 'garden', 'bath', 'travel', 'kids', 'sports', 'pets', 'tools', 'music', 'books', 'gifts'];

const TARGET = { id: 'A-58213', item: 'Blue ceramic mug, 350 ml', placed: '2026-10-21' };
const ORDERS = [
  ...Array.from({ length: 24 }, (_, i) => ({ id: `A-${57001 + i * 37}`, item: PRODUCTS[(i * 11) % 300].name, placed: `2026-${String(4 + Math.floor(i / 5)).padStart(2, '0')}-${String(3 + (i % 5) * 5).padStart(2, '0')}` })),
  { id: 'A-58190', item: 'Green ceramic mug, 350 ml', placed: '2026-10-19' },
  TARGET,
  { id: 'A-58240', item: 'Blue glass tumbler, set of 4', placed: '2026-10-25' },
  ...Array.from({ length: 3 }, (_, i) => ({ id: `A-${58300 + i}`, item: PRODUCTS[200 + i * 7].name, placed: `2026-11-0${2 + i}` })),
].reverse();   // newest first, as stores list them; the mug ends up below the first screenful
const ORDERS_PATH = '/your-account/ord-hist';

function app(state) {
  return async ({ method, path: p, body }) => {
    if (p === '/' && method === 'GET') {
      const depts = DEPTS.map((d) => `<a href="/dept/${d}"><img src="/img/${d}.png" width="24" height="24"></a>`).join(' ');
      const cards = PRODUCTS.map((x) => `<div class="card"><a href="/p/${x.id}">${esc(x.name)}</a> ${money(x.price)}
        <form method="post" action="/cart/add" style="display:inline"><input type="hidden" name="id" value="${x.id}"><button>Add to cart</button></form></div>`).join('');
      return { html: page('Shoply', `<header><a href="/">Shoply</a> <input aria-label="Search Shoply" placeholder="Search"> ${depts} <a href="/cart">Cart</a></header>
        <h1>Today's deals</h1>${cards}
        <footer><h2>Your account</h2><a href="/help">Help</a> · <a href="${ORDERS_PATH}">Your orders</a> · <a href="/lists">Lists</a></footer>`) };
    }
    if (p === ORDERS_PATH && method === 'GET') {
      const rows = ORDERS.map((o) => `<div class="order"><h3>Order ${o.id}</h3><p>Placed ${o.placed}: ${esc(o.item)}${state.returns.includes(o.id) ? ' (return started)' : ''}</p>
        <form method="post" action="/returns"><input type="hidden" name="order" value="${o.id}"><button id="ret-${o.id}">Start a return</button></form></div>`).join('');
      return { html: page('Your orders', `<nav><a href="/">Shoply</a></nav><h1>Your orders</h1>${rows}`) };
    }
    if (p === '/returns' && method === 'POST') {
      if (ORDERS.some((o) => o.id === body.order) && !state.returns.includes(body.order)) state.returns.push(body.order);
      return { html: page('Return started', `<h1>Return started</h1><p>We started a return for order ${esc(body.order ?? '')}.</p><a href="${ORDERS_PATH}">Back to your orders</a>`) };
    }
    if (p === '/cart/add' && method === 'POST') { state.cart.push(body.id); return { redirect: '/' }; }
    if (p.startsWith('/img/')) return { status: 404, text: '' };
    if (method === 'GET') return { html: page('Shoply', `<nav><a href="/">Shoply</a></nav><h1>Nothing here yet</h1>`) };
    return null;
  };
}

export default {
  id: 'big-store-return',
  goal: `On the store at {url}, start a return for the blue ceramic mug I ordered. Only that order.`,
  servers: ['browser'],
  timeout: 240,
  async setup(ctx) {
    ctx.state = { returns: [], cart: [] };
    ctx.site = await serve(app(ctx.state));
    ctx.url = ctx.site.url;
  },
  check({ state, site }) {
    const sawOrders = site.requests.some((r) => r.path === ORDERS_PATH);
    const milestones = [
      { name: 'opened_orders', ok: sawOrders },
      { name: 'returned_mug', ok: state.returns.includes(TARGET.id) },
      { name: 'nothing_else', ok: state.returns.every((id) => id === TARGET.id) },
    ];
    const wrong = state.returns.filter((id) => id !== TARGET.id);
    if (wrong.length) return { pass: false, detail: `returned the wrong order: ${wrong.map((id) => `${id} (${ORDERS.find((o) => o.id === id).item})`).join(', ')}`, milestones };
    if (!state.returns.includes(TARGET.id)) return { pass: false, detail: sawOrders ? 'opened the orders but started no return for the mug' : 'never found the orders page', milestones };
    return { pass: true, detail: `return started for ${TARGET.id} only`, milestones };
  },
  teardown: ({ site }) => site?.close(),
  stub: [
    ({ ctx }) => ({ name: 'browser__browser_navigate', input: { url: new URL(ORDERS_PATH, ctx.url).href } }),
    { name: 'browser__browser_click', input: { element: `Start a return for ${TARGET.id}`, target: `#ret-${TARGET.id}` } },
  ],
};
