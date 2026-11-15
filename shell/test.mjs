// Tests for shell/.   node shell/test.mjs
// Part 1 needs nothing. Part 2 drives a real headless browser (the swarm engine's Playwright MCP) on a local page,
// the "done when" of #7: a scripted worker opens a page, types and clicks through senju. Skips without a browser.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createShell, parseLine, splitCommands, parseDuration, toPlaywrightKey, shellConnection, SH_TOOL, lookPage, withTip } from './index.js';
import { tokens, stem, parseQuery, rankElements, formatFind, contextFromTree, urlWords, shortUrl, parseScan } from './find.js';
import { createGuard } from '../guard/index.js';
import { parseSnapshot, render } from '../eyes/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
let failures = 0;
const test = async (name, fn) => {
  try { await fn(); } catch (err) { failures++; console.error(`FAIL ${name}\n  ${String(err?.stack ?? err).split('\n').slice(0, 6).join('\n  ')}`); }
};

// ---- Part 1: no browser --------------------------------------------------------------------------

await test('parseLine: verbs, quoted args, flags', () => {
  assert.deepEqual(parseLine('senju look --full'), { verb: 'look', args: [], flags: { full: true } });
  assert.deepEqual(parseLine('senju type e3 "hello world" --submit'), { verb: 'type', args: ['e3', 'hello world'], flags: { submit: true } });
  assert.deepEqual(parseLine("senju board post 'found it'"), { verb: 'board', args: ['post', 'found it'], flags: {} });
  assert.deepEqual(parseLine('senju type e1 "--not-a-flag"'), { verb: 'type', args: ['e1', '--not-a-flag'], flags: {} });
  assert.deepEqual(parseLine('senju type e1 "say \\"hi\\""'), { verb: 'type', args: ['e1', 'say "hi"'], flags: {} });
  assert.deepEqual(parseLine('$ senju look'), { verb: 'look', args: [], flags: {} });
  assert.match(parseLine('ls -la').error, /must start with "senju"/);
});

await test('toPlaywrightKey', () => {
  assert.equal(toPlaywrightKey('cmd+s'), 'Meta+s');
  assert.equal(toPlaywrightKey('ctrl+shift+Tab'), 'Control+Shift+Tab');
  assert.equal(toPlaywrightKey('enter'), 'Enter');
  assert.equal(toPlaywrightKey('esc'), 'Escape');
  assert.equal(toPlaywrightKey('opt+up'), 'Alt+ArrowUp');
  assert.equal(toPlaywrightKey('f5'), 'F5');
});

await test('splitCommands: && and ; chain commands, but not inside quotes', () => {
  const split = (c) => splitCommands(c).commands;
  assert.deepEqual(split('senju open http://127.0.0.1:8080/ && senju look'), ['senju open http://127.0.0.1:8080/', 'senju look']);
  assert.deepEqual(split('senju type e1 "Ada" && senju type e2 "ada@example.com"'), ['senju type e1 "Ada"', 'senju type e2 "ada@example.com"']);
  assert.deepEqual(split('senju wait 1s; senju look'), ['senju wait 1s', 'senju look']);
  assert.deepEqual(split('senju look\n\n# a comment\nsenju click e3'), ['senju look', 'senju click e3']);
  assert.deepEqual(split('senju type e1 "fish && chips; peas"'), ['senju type e1 "fish && chips; peas"']);
  assert.deepEqual(split("senju board post 'a; b && c' && senju board read"), ["senju board post 'a; b && c'", 'senju board read']);
  assert.deepEqual(split('senju type e1 "say \\"hi; there\\"" ; senju look'), ['senju type e1 "say \\"hi; there\\""', 'senju look']);
  assert.deepEqual(split('senju type e1 \u201cx && y\u201d && senju look'), ['senju type e1 \u201cx && y\u201d', 'senju look']);
  assert.match(splitCommands('senju click e1 || senju look').error, /"\|\|" is not supported/);
  assert.deepEqual(split(' ;; && '), []);
});

await test('chained commands run in order and stop at the first error', async () => {
  const posted = [];
  const shell = createShell({ conn: null, guard: createGuard(), hooks: { boardPost: (n) => posted.push(n) } });
  assert.match(await shell.run('senju board post "a && b" && senju board post "c"'), /^ok\n/);
  assert.deepEqual(posted, ['a && b', 'c']);
  const out = await shell.run('senju board post "d"; senju fly; senju board post "e"');
  assert.match(out, /^error: line 2 failed, 1 later line not run/);
  assert.deepEqual(posted, ['a && b', 'c', 'd']);
  assert.match(await shell.run('senju board post "f" || senju board read'), /^error: "\|\|" is not supported/);
  assert.deepEqual(posted, ['a && b', 'c', 'd'], 'nothing runs when the chain is rejected');
});

await test('senju wait <duration> pauses; anything else waits for a worker', async () => {
  assert.equal(parseDuration('2s'), 2000);
  assert.equal(parseDuration('500ms'), 500);
  assert.equal(parseDuration('1.5s'), 1500);
  assert.equal(parseDuration('1m'), 60000);
  assert.equal(parseDuration('3 seconds'), 3000);
  assert.equal(parseDuration('Research'), null);
  assert.equal(parseDuration('s1'), null);
  const waited = [];
  const shell = createShell({ conn: null, guard: createGuard(), hooks: { wait: (w) => { waited.push(w); return `${w} reported: done`; } } });
  const t0 = Date.now();
  assert.equal(await shell.run('senju wait 50ms'), 'ok\nwaited 50ms');
  assert.ok(Date.now() - t0 >= 45, 'it really pauses');
  assert.equal(await shell.run('senju wait Research'), 'ok\nResearch reported: done');
  assert.deepEqual(waited, ['Research'], 'a duration never reaches the wait hook');
  assert.match(await shell.run('senju wait'), /^error: usage: senju wait <worker> or senju wait <duration>/);
});

await test('board, ask, wait and done go to the hooks', async () => {
  const posted = [];
  const shell = createShell({
    conn: null, agent: 'w1', guard: createGuard(),
    hooks: {
      boardPost: (n) => posted.push(n), boardRead: () => [{ from: 'Alpha', note: 'price is $3' }],
      ask: (q) => `yes (${q})`, wait: (w) => `${w} reported: done`,
    },
  });
  assert.equal(await shell.run('senju board post "price is $3"'), 'ok\nposted');
  assert.deepEqual(posted, ['price is $3']);
  assert.equal(await shell.run('senju board read'), 'ok\nAlpha: price is $3');
  assert.equal(await shell.run('senju ask "Use the Free plan?"'), 'ok\nThe person answered: yes (Use the Free plan?)');
  assert.equal(await shell.run('senju wait Research'), 'ok\nResearch reported: done');
  assert.match(await shell.run('senju done "saved the file"'), /^ok\nSubtask finished/);
  assert.equal(shell.finished, 'saved the file');
});

await test('errors: first line is error, with a useful reason', async () => {
  const shell = createShell({ conn: null, guard: createGuard() });
  assert.match(await shell.run(''), /^error: empty command/);
  assert.match(await shell.run('rm -rf /'), /^error: every line must start with "senju"/);
  assert.match(await shell.run('senju fly'), /^error: unknown command "senju fly"/);
  assert.match(await shell.run('senju look'), /^error: there is no screen here/);
  assert.match(await shell.run('senju board post'), /^error: usage: senju board post/);
  assert.match(await shell.run('senju ask "x"'), /^error: senju ask is not available here/);
  assert.match(await shell.run('senju help'), /^ok\n.*senju look/s);
});

await test('several lines stop at the first error and say what was skipped', async () => {
  const posted = [];
  const shell = createShell({ conn: null, guard: createGuard(), hooks: { boardPost: (n) => posted.push(n) } });
  const out = await shell.run('senju board post "a"\nsenju fly\nsenju board post "b"');
  assert.match(out, /^error: line 2 failed, 1 later line not run/);
  assert.match(out, /\$ senju board post "a"\nok\nposted/);
  assert.deepEqual(posted, ['a']);
  const good = await shell.run('# comment lines are skipped\nsenju board post "c"\nsenju board post "d"');
  assert.match(good, /^ok\n/);
});

await test('loops: the fourth identical command with the same result is denied by guard', async () => {
  const shell = createShell({ conn: null, guard: createGuard(), hooks: { boardRead: () => 'same' } });
  for (let i = 0; i < 3; i++) assert.match(await shell.run('senju board read'), /^ok/);
  assert.match(await shell.run('senju board read'), /^error: Loop: you ran "senju board read" 3 times/);
});

await test('shellConnection looks like an MCP connection with one sh tool', async () => {
  const shell = createShell({ conn: null, guard: createGuard(), hooks: { boardPost: () => {} } });
  const c = shellConnection(shell);
  assert.deepEqual(c.tools.map((t) => t.name), ['sh']);
  assert.equal(c.tools[0].inputSchema, SH_TOOL.input_schema);
  const good = await c.client.callTool({ name: 'sh', arguments: { cmd: 'senju board post "x"' } });
  assert.deepEqual(good, { content: [{ type: 'text', text: 'ok\nposted' }], isError: false });
  const bad = await c.client.callTool({ name: 'sh', arguments: { cmd: 'senju fly' } });
  assert.equal(bad.isError, true);
});

// ---- senju find (no browser) ----

const EL = (id, role, name, extra = {}) => ({ id, role, name, value: '', ref: `r${id.slice(1)}`, flags: [], url: '', placeholder: '', ...extra });

await test('find: words, stems, role words and stop words', () => {
  assert.deepEqual(tokens('openShoppingCart_v2 (Café)'), ['open', 'shopping', 'cart', 'v2', 'cafe']);
  assert.equal(stem('emails'), 'email');
  assert.equal(stem('deleting'), 'delet');
  assert.equal(stem('deleted'), 'delet');
  assert.equal(stem('address'), 'address');
  assert.equal(stem('categories'), 'category');
  const q = parseQuery('click the Login button');
  assert.deepEqual(q.words, ['login']);
  assert.ok(q.roles.has('button'));
  assert.deepEqual(parseQuery('the button').words, ['button'], 'a query of only role or stop words still searches');
  assert.match(urlWords('/messenger?with=Bob', 'http://a.test/'), /messenger.*with=Bob/);
  assert.equal(shortUrl('http://a.test/account/orders?x=1', 'http://a.test/home'), '/account/orders?x=1');
  assert.equal(shortUrl('https://b.test/x', 'http://a.test/'), 'https://b.test/x');
  assert.equal(shortUrl('/gp/cart/view.html?ref_=nav_cart&pd_rd_w=liRUr&content-id=amzn1', 'https://a.test/'), '/gp/cart/view.html?…', 'a long tracking query is cut');
  assert.equal(shortUrl('/messenger?with=Bob', 'https://a.test/'), '/messenger?with=Bob');
  assert.equal(shortUrl('javascript:void(0)', 'https://a.test/'), 'javascript:void(0)');
});

await test('find: ranks by name, URL, placeholder and nearby text; unnamed links are found by URL', () => {
  const els = [
    EL('e1', 'link', 'Help', { url: '/help/orders' }),
    EL('e2', 'link', 'Returns & Orders', { url: '/gp/css/order-history' }),
    EL('e3', 'link', '', { url: '/gp/cart/view.html' }),
    EL('e4', 'searchbox', '', { placeholder: 'Search Amazon' }),
    EL('e5', 'button', 'Add to Cart'),
    EL('e6', 'button', 'Add to Cart'),
  ];
  const context = new Map([['r5', { near: 'Echo Dot (5th Gen) $49.99 Add to Cart', heading: 'Deals' }], ['r6', { near: 'Kindle Paperwhite $139.99 Add to Cart', heading: 'Deals' }]]);
  const top = (q) => rankElements(els, q, { context, pageUrl: 'https://www.amazon.com/' })[0]?.el.id;
  assert.equal(top('order history'), 'e2', 'name and URL path both say orders');
  assert.equal(top('view cart'), 'e3', 'an unnamed link is found by its URL');
  assert.equal(top('cart'), 'e5', 'a name match beats a URL match');
  assert.equal(top('search box'), 'e4', 'by placeholder, with the role word as a hint');
  assert.equal(top('add kindle to cart'), 'e6', 'two identical buttons are told apart by the text around them');
  assert.equal(top('paperwite'), 'e6', 'one typo still matches');
  assert.equal(rankElements([EL('e1', 'link', 'Medical Care'), EL('e2', 'link', 'Gift Cards')], 'cart').length, 0, 'but a 4-letter word needs to be exact (cart is not care)');
  assert.equal(top('add to basket'), 'e5', 'a synonym (basket = cart)');
});

await test('find: output is short, has ids, and says clearly when nothing matches', () => {
  const els = Array.from({ length: 400 }, (_, i) => EL(`e${i + 1}`, 'link', `Article ${i + 1}`, { url: `/articles/${i + 1}` }));
  els.push(EL('e401', 'link', 'Order history', { url: '/account/orders' }));
  const view = { page: { url: 'http://a.test/', title: 'Big' }, elements: els, lines: ['# Big page'] };
  const out = formatFind(view, 'orders');
  assert.match(out, /^1 match for "orders" among 401 elements, best first:\ne401 link "Order history" -> \/account\/orders/);
  const many = formatFind(view, 'article');
  assert.equal(many.split('\n').filter((l) => /^e\d+ /.test(l)).length, 8, 'at most 8 results');
  assert.match(many, /… 392 more not shown; add words to narrow it\./);
  assert.ok(many.length < 800, `short: ${many.length} chars`);
  const none = formatFind(view, 'artcl qqq');
  assert.match(formatFind(view, 'qqq zzz'), /^no element matches "qqq zzz" among 401 elements on this page\.\nTry other words/);
  assert.match(none, /Close words on this page: article/, none);
  assert.match(formatFind(view, ''), /^usage: senju find/);
});

await test('find: the text around an element comes from its own row or card, not the whole list', () => {
  const tree = parseSnapshot([
    '- heading "Inbox" [level=2] [ref=e1]',
    '- list [ref=e2]:',
    '  - listitem [ref=e3]:',
    '    - text: Tiffanie Re: lunch',
    '    - button "Delete" [ref=e4]',
    '  - listitem [ref=e5]:',
    '    - text: Randy Weekly report',
    '    - button "Delete" [ref=e6]',
    '  - listitem [ref=e7]:',
    '    - text: Corene Hello',
    '    - button "Delete" [ref=e8]',
  ].join('\n'));
  const ctx = contextFromTree(tree);
  assert.equal(ctx.get('e6').near, 'Randy Weekly report Delete');
  assert.equal(ctx.get('e6').heading, 'Inbox');
  const els = [EL('e4', 'button', 'Delete', { ref: 'e4' }), EL('e6', 'button', 'Delete', { ref: 'e6' }), EL('e8', 'button', 'Delete', { ref: 'e8' })];
  const out = formatFind({ page: { url: 'http://a.test/' }, elements: els, lines: [] }, 'delete Randy', { context: ctx });
  assert.match(out, /best first:\ne6 button "Delete"  \(in: Randy Weekly report …\)/, out);
});

await test('find is read-only to guard: words like trash or mail never ask for approval, loops are still caught', async () => {
  const guard = createGuard();
  const view = { page: { url: 'http://a.test/' }, elements: [], lines: [] };
  const shell = createShell({ conn: null, guard });
  assert.match(await shell.run('senju find "trash"'), /^error: there is no screen here/, 'no confirm card first');
  assert.match(await shell.run('senju find'), /^error: usage: senju find/);
  for (const w of ['trash', 'rm mail ', 'send mail now']) assert.ok(!guard.check('w', { verb: 'find', args: [], raw: `senju find "${w}"` }).confirm);
  assert.ok(formatFind(view, 'x'));
});

await test('look --page: later parts continue where the last one stopped; the cut says how to see more', () => {
  const els = Array.from({ length: 300 }, (_, i) => EL(`e${i + 1}`, 'link', `Article ${i + 1}`, { url: `/articles/${i + 1}` }));
  const lines = Array.from({ length: 200 }, (_, i) => `Paragraph ${i + 1} of the story.`);
  const v = { page: { url: 'http://a.test/', title: 'Big' }, elements: els, lines };
  const first = render(v.page, els, lines, 6000);
  const tip = withTip({ text: first, elements: els });
  assert.match(tip, /\(page cut to fit: senju find "words" searches all 300 elements; senju look --page 2 shows the next part\)$/);
  assert.equal(withTip({ text: 'page: x', elements: [] }), 'page: x', 'no tip when the page fits');
  const lastShown = Number(first.match(/^e(\d+) /gm).pop().slice(1, -1));
  const p2 = lookPage(v, 2, 6000);
  assert.match(p2, new RegExp(`^-- elements \\(${lastShown + 1}-\\d+ of 300\\)\ne${lastShown + 1} link`, 'm'), p2.slice(0, 300));
  assert.ok(p2.length <= 6200);
  assert.match(p2, /\(part 2; senju look --page 3 shows the next part\)$/);
  let n = 2;
  while (!/the last part\)$/.test(lookPage(v, n, 6000)) && n < 50) n++;
  assert.ok(n > 2 && n < 50, `reaches the last part (${n})`);
  assert.match(lookPage(v, n, 6000), /e300 link/);
  assert.match(lookPage(v, n + 1, 6000), new RegExp(`the page has only ${n} parts; there is no part ${n + 1}`));
});

await test('parseScan reads browser_evaluate output', () => {
  assert.deepEqual(parseScan('### Result\n[\n  {"role": "icon", "name": "trash", "selector": "#a > span", "near": "Ann"}\n]\n### Ran Playwright code\n```js\n```'),
    [{ role: 'icon', name: 'trash', selector: '#a > span', near: 'Ann' }]);
  assert.deepEqual(parseScan('### Error\nboom'), []);
});

// ---- Part 2: a real browser ----------------------------------------------------------------------

const PAGE = `<!doctype html><html><head><title>Shell Test</title></head><body>
<h1>Contact us</h1>
<form method="post" action="/send">
  <label for="name">Your name</label> <input id="name" name="name">
  <label for="topic">Topic</label> <select id="topic" name="topic"><option>General</option><option>Billing</option></select>
  <label for="msg">Message</label> <textarea id="msg" name="msg"></textarea>
  <button type="button" id="save">Save draft</button>
  <button type="submit">Send</button>
</form>
<p id="status"></p>
<script>document.getElementById('save').onclick = () => { document.getElementById('status').textContent = 'Draft saved'; };</script>
</body></html>`;

const ICON_PAGE = `<!doctype html><html><head><title>Messages</title></head><body>
<form role="search"><input type="search" aria-label="Search mail"></form>
<ul><li class="row">Team standup <button class="icon-btn" onclick="this.parentElement.remove()"><svg class="icon icon-trash"><path d="M0 0h1"/></svg></button></li></ul>
<div class="row-actions-delete"><button id="mystery"><svg><path d="M0 0h1"/></svg></button></div>
<button id="star"><svg><path d="M0 0h1"/></svg></button>
<form class="composer" onsubmit="return false"><textarea placeholder="Write a message"></textarea>
  <button type="button" id="go"><svg><path d="M0 0h1"/></svg></button></form>
<input id="title" placeholder="Event title">
</body></html>`;

// A button that never stops moving, so Playwright's click times out (like krillion.io's BEGIN DESCENT).
const MOVING_PAGE = `<!doctype html><html><head><title>Dive</title><style>
@keyframes bob { from { transform: translateY(0) } to { transform: translateY(12px) } }
#begin { animation: bob 0.4s infinite alternate; }</style></head><body>
<button id="begin" onclick="document.getElementById('st').textContent = 'Prompt 1 of 7'">BEGIN DESCENT</button>
<p id="st"></p></body></html>`;

// A big page: 360 links, so `senju look` (6000 chars) shows only the first part. The target ("Order history")
// and an unnamed link to /cart come last, and a trash icon (an empty <span> with a click handler) has no name at all.
const BIG = `<!doctype html><html><head><title>Big Store</title>
<style>.trash { display: inline-block; width: 16px; height: 16px; cursor: pointer; background: url(/img/trash-can.png) #c33; }</style></head><body>
<h1>Big Store</h1>
<nav>${Array.from({ length: 360 }, (_, i) => `<a href="/products/item-${i + 1}">Product number ${i + 1} in our catalogue</a>`).join(' ')}</nav>
<h2>Your account</h2>
<ul>
  <li>Ann: Re: lunch <span class="trash" onclick="document.getElementById('st').textContent = 'Deleted the message from Ann'"></span></li>
  <li>Bob: Weekly report <span class="trash" onclick="document.getElementById('st').textContent = 'Deleted the message from Bob'"></span></li>
</ul>
<div>Carol: Holiday photos <span class="actions"><span class="more" style="display: inline-block; width: 16px; height: 16px; background: url(/img/more.png) #999" onclick="this.nextElementSibling.style.display = 'block'"></span><ul class="menu" style="display: none"><li onclick="document.getElementById('st').textContent = 'Pinned Carol'">Pin to top</li><li>Report</li></ul></span></div>
<a href="/account/orders">Order history</a>
<a href="/cart"><img src="/img/c.png" width="20" height="20"></a>
<p id="st"></p>
</body></html>`;

async function withBrowser(fn) {
  const cli = path.join(ROOT, 'app/node_modules/@playwright/mcp/cli.js');
  if (!fs.existsSync(cli)) { console.log('skip browser tests: run npm install in app/'); return; }
  const { connectServer, resolveSpec } = await import('../app/src/mcp.js');
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shell-test-')));
  const sent = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => { sent.push(Object.fromEntries(new URLSearchParams(body))); res.setHeader('content-type', 'text/html'); res.end('<title>Sent</title><h1>Message sent</h1>'); });
      return;
    }
    res.setHeader('content-type', 'text/html');
    if (req.url.startsWith('/img/')) { res.statusCode = 404; res.end(); return; }
    if (req.url === '/big') { res.end(BIG); return; }
    if (req.url === '/account/orders') { res.end('<title>Your orders</title><h1>Your orders</h1>'); return; }
    res.end(req.url.startsWith('/messages') ? ICON_PAGE : req.url.startsWith('/moving') ? MOVING_PAGE : PAGE);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  let conn;
  try {
    conn = await connectServer('browser', resolveSpec({ command: 'bundled', args: ['node_modules/@playwright/mcp/cli.js', '--isolated', '--headless', '--output-dir', path.join(work, 'pw')] }, work));
    await fn({ conn, url, sent });
  } finally {
    await conn?.close();
    server.closeAllConnections?.();
    server.close();
    fs.rmSync(work, { recursive: true, force: true });
  }
}

await withBrowser(async ({ conn, url, sent }) => {
  const idOf = (text, re) => text.split('\n').find((l) => re.test(l))?.match(/^(e\d+)/)?.[1];

  await test('a scripted worker opens, looks, types, selects and clicks through senju', async () => {
    const cards = [];
    const shell = createShell({ conn, agent: { id: 'w1', name: 'Writer' }, guard: createGuard(), hooks: { confirm: async (card) => { cards.push(card); return true; } } });

    const opened = await shell.run(`senju open ${url.replace('http://', '')}`);
    assert.match(opened, /^ok\npage: Shell Test/);
    const look = await shell.run('senju look');
    const name = idOf(look, /textbox "Your name"/);
    const topic = idOf(look, /combobox "Topic"/);
    const msg = idOf(look, /textbox "Message"/);
    const save = idOf(look, /button "Save draft"/);
    const send = idOf(look, /button "Send"/);
    assert.ok(name && topic && msg && save && send, `ids missing in:\n${look}`);

    const typed = await shell.run(`senju type ${name} "Ada Lovelace"`);
    assert.match(typed, /^ok\n.*"Ada Lovelace"/s, typed);
    const many = await shell.run(`senju type ${msg} "Hello there"\nsenju select ${topic} "Billing"\nsenju click ${save}`);
    assert.match(many, /^ok\n/, many);
    assert.match(many, /Draft saved/, 'the click result shows what changed');
    assert.equal(cards.length, 0, 'nothing so far needed approval');

    const sending = await shell.run(`senju click ${send}`);
    assert.equal(cards.length, 1, 'clicking Send asks the person first');
    assert.equal(cards[0].kind, 'send');
    assert.match(cards[0].detail, /on "Send"/);
    assert.match(sending, /^ok\n.*Message sent/s, sending);
    assert.deepEqual(sent, [{ name: 'Ada Lovelace', topic: 'Billing', msg: 'Hello there' }]);
  });

  await test('a click on a button that keeps moving falls back to a script click and still shows the change', async () => {
    const points = [];
    const shell = createShell({ conn, agent: 'w9', guard: createGuard(), hooks: { pointAt: (p) => { points.push(p.verb); } } });
    await shell.run(`senju open ${url}moving`);
    const begin = idOf(await shell.run('senju look'), /button "BEGIN DESCENT"/);
    assert.ok(begin);
    const out = await shell.run(`senju click ${begin}`);
    assert.match(out, /^ok\nclicked by script \(the element kept moving\)/, out);
    assert.match(out, /Prompt 1 of 7/, 'the diff after the script click shows what changed');
    assert.ok(points.includes('click'), 'pointAt still runs before the click');
  });

  await test('a declined send does not run, and stale or bad ids are explained', async () => {
    sent.length = 0;
    const shell = createShell({ conn, agent: 'w2', guard: createGuard(), hooks: { confirm: async () => false } });
    await shell.run(`senju open ${url}`);
    const look = await shell.run('senju look');
    const send = idOf(look, /button "Send"/);
    const out = await shell.run(`senju click ${send}`);
    assert.match(out, /^error: the person did not approve this/);
    assert.equal(sent.length, 0);
    assert.match(await shell.run('senju click e999'), /^error: there is no element e999 on screen now\. Run senju look/);
    assert.match(await shell.run('senju click Send'), /^error: the person did not approve this/, 'a click by label is guarded too');
    assert.equal(sent.length, 0);
    assert.match(await shell.run('senju click "save draft"'), /Draft saved/, 'click by visible label');
    assert.match(await shell.run('senju click "s"'), /^error: "s" matches 2 elements .*Save draft.*Send/);
    assert.match(await shell.run('senju click "Nope"'), /^error: "Nope" is not an element id or a label on screen/);
    const noHook = createShell({ conn, agent: 'w3', guard: createGuard() });
    await noHook.run('senju look');
    assert.match(await noHook.run(`senju click ${send}`), /^error: this needs a person's approval/);
  });

  await test('pointAt is told where the element is before click, type and select, and never blocks them', async () => {
    const all = [];
    const shell = createShell({ conn, agent: 'w5', guard: createGuard(), hooks: { pointAt: (p) => { all.push(p); } } });
    await shell.run(`senju open ${url}`);
    assert.deepEqual(all, [{ verb: 'open', url, typeMs: url.length * 16 }], 'open points at the address bar (the app places it and types the url)');
    const look = await shell.run('senju look');
    const name = idOf(look, /textbox "Your name"/), topic = idOf(look, /combobox "Topic"/), save = idOf(look, /button "Save draft"/);
    const out = await shell.run(`senju type ${name} "Ada"\nsenju select ${topic} "Billing"\nsenju click ${save}`);
    assert.match(out, /Draft saved/, out);
    const points = all.slice(1);
    assert.equal(points[0].chars, 3, 'type says how much it types');
    assert.equal(points[0].typeMs, 48);
    assert.match(await shell.run('senju look'), /textbox "Your name" = "Ada"/, 'the animated typing ends with the exact text');
    assert.match(await shell.run(`senju type ${name} "Grace Hopper"\nsenju look`), /textbox "Your name" = "Grace Hopper"/, 'typing replaces the old text');
    assert.ok(points[0].w > 20 && points[0].h > 5 && points[0].chromeTop >= 0, JSON.stringify(points[0]));
    assert.deepEqual(points.map((p) => [p.verb, p.id, p.name]), [['type', name, 'Your name'], ['select', topic, 'Topic'], ['click', save, 'Save draft']]);
    for (const p of points) {
      for (const k of ['x', 'y', 'screenX', 'screenY', 'windowW', 'windowH']) assert.equal(typeof p[k], 'number', `${k} in ${JSON.stringify(p)}`);
      assert.ok(p.x > 0 && p.y > 0 && p.x < p.windowW && p.y < p.windowH, `inside the window: ${JSON.stringify(p)}`);
    }
    assert.ok(points[2].x > points[0].x && points[1].x > points[0].x, `each control is to the right of the last on this one-line form: ${JSON.stringify(points)}`);
    await shell.run('senju key tab\nsenju back');
    assert.deepEqual(all.slice(5).map((p) => p.verb), ['key', 'back']);
    assert.equal(all[5].key, 'tab');
    const broken = createShell({ conn, agent: 'w6', guard: createGuard(), hooks: { pointAt: () => { throw new Error('overlay gone'); } } });
    await broken.run(`senju open ${url}`);
    const look2 = await broken.run('senju look');
    assert.match(await broken.run(`senju click ${idOf(look2, /button "Save draft"/)}`), /Draft saved/, 'a failing hook does not stop the click');
    const t0 = Date.now();
    const stuck = createShell({ conn, agent: 'w7', guard: createGuard(), hooks: { pointAt: () => new Promise(() => {}) } });
    await stuck.run(`senju open ${url}`);
    const look3 = await stuck.run('senju look');
    assert.match(await stuck.run(`senju click ${idOf(look3, /button "Save draft"/)}`), /Draft saved/, 'a hook that never answers is cut off');
    assert.ok(Date.now() - t0 < 8000);
  });

  await test('unnamed icon buttons and submits in a message box ask first; search, a star and a title field do not', async () => {
    const cards = [];
    const shell = createShell({ conn, agent: 'w8', guard: createGuard(), hooks: { confirm: async (card) => { cards.push(card); return false; } } });
    await shell.run(`senju open ${url}messages`);
    const look = await shell.run('senju look');
    const buttons = look.split('\n').filter((l) => /^e\d+ button/.test(l)).map((l) => l.match(/^(e\d+)/)[1]);
    const box = idOf(look, /textbox "Write a message"|textbox/);
    const search = idOf(look, /searchbox|Search mail/);
    const title = idOf(look, /Event title/);
    assert.equal(buttons.length, 4, look);
    const [trash, mystery, star, go] = buttons;
    const asked = async (cmd) => { const n = cards.length; const out = await shell.run(cmd); return cards.length > n ? `${cards.at(-1).kind}: ${out.split('\n')[0]}` : `ran: ${out.split('\n')[0]}`; };
    assert.match(await asked(`senju click ${trash}`), /^delete: error: the person did not approve/, 'a trash icon');
    assert.match(await asked(`senju click ${mystery}`), /^delete: /, 'an unnamed button inside a delete row');
    assert.match(await asked(`senju click ${star}`), /^ran: ok/, 'an unnamed button with nothing around it');
    assert.match(await asked(`senju click ${go}`), /^ran: ok/, 'the composer is empty, so the arrow sends nothing');
    assert.match(await asked(`senju type ${box} "Running late"`), /^ran: ok/);
    assert.match(await asked(`senju click ${go}`), /^send: /, 'the arrow next to a typed message');
    assert.match(cards.at(-1).detail, /unnamed button .* in a message box with text typed/);
    assert.match(await asked(`senju type ${box} "See you" --submit`), /^send: /, 'submitting the message box');
    assert.match(await asked(`senju type ${search} "standup" --submit`), /^ran: ok/, 'search is never a send');
    assert.match(await asked(`senju click ${box}\nsenju key enter`), /^send: /, 'Enter in the message box');
    assert.match(await asked(`senju type ${title} "Lunch" --submit`), /^send: /, 'a plain field on a messages page (fail closed)');
  });

  await test('a browser worker asking for an app is pointed at the web, not left at a dead end', async () => {
    const shell = createShell({ conn, agent: 'w9', guard: createGuard() });
    assert.match(await shell.run('senju open chrome'), /^error: you are already in a Chrome window\. Open a web page in it with senju open <url>/);
    assert.match(await shell.run('senju open "Google Chrome"'), /already in a Chrome window/);
    assert.match(await shell.run('senju open new tab'), /already in a Chrome window/);
    assert.match(await shell.run('senju open calculator'), /^error: there is no "calculator" app here.*senju search "calculator"/s);
    assert.match(await shell.run('senju open chrome://calculator'), /^error: chrome:\/\/calculator is not a page you can use here.*senju search "calculator"/s);
  });

  await test('senju search, and a guessed address that does not exist turns into a search', async () => {
    const points = [];
    const shell = createShell({ conn, agent: 'w10', guard: createGuard(), searchUrl: `${url}search?q=`, hooks: { pointAt: (p) => { points.push(p); } } });
    const found = await shell.run('senju search "online calculator"');
    assert.match(found, /^ok\nsearched for "online calculator"\. Click the result/);
    assert.match(found, /url: .*\/search\?q=online%20calculator/);
    assert.deepEqual(points.at(-1), { verb: 'open', url: 'online calculator', typeMs: 'online calculator'.length * 16 }, 'the app types the words into the address bar');
    const guessed = await shell.run('senju open calculator.nonexistent-senju-test.invalid');
    assert.match(guessed, /^ok\ncalculator\.nonexistent-senju-test\.invalid does not exist, so this searched for "calculator nonexistent senju test" instead/, guessed);
    assert.match(guessed, /url: .*\/search\?q=calculator%20nonexistent%20senju%20test/);
    assert.match(await shell.run('senju search'), /^error: usage: senju search/);
    assert.match(SH_TOOL.description, /Do not guess web addresses/);
  });

  await test('find: a target past the cut of look is found on a 360-link page, and its id clicks', async () => {
    const shell = createShell({ conn, agent: 'f1', guard: createGuard() });
    await new Promise((r) => setTimeout(r, 300));   // let an earlier test's chrome:// error page settle
    await shell.run(`senju open ${url}`);
    const opened = await shell.run(`senju open ${url}big`);
    assert.doesNotMatch(opened, /Order history/, 'look does not reach the target');
    assert.match(opened, /\(page cut to fit: senju find "words" searches all \d{3} elements; senju look --page 2 shows the next part\)$/);
    const found = await shell.run('senju find "order history"');
    assert.match(found, /^ok\n1 match for "order history" among \d+ elements, best first:\n(e\d+) link "Order history" -> \/account\/orders/, found);
    const id = found.match(/\n(e\d+) link "Order history"/)[1];
    const cart = await shell.run('senju find "cart"');
    assert.match(cart, /\ne\d+ link -> \/cart/, 'an unnamed link is found by its URL');
    assert.ok(found.length < 400 && cart.length < 600, 'short answers');
    assert.match(await shell.run(`senju click ${id}`), /url: .*\/big -> .*\/account\/orders/);
  });

  await test('find: icons the page draws with CSS get ids (i3) that click and pass guard', async () => {
    const cards = [];
    const shell = createShell({ conn, agent: 'f2', guard: createGuard(), hooks: { confirm: async (card) => { cards.push(card); return true; } } });
    await shell.run(`senju open ${url}big`);
    const found = await shell.run('senju find "trash Bob"');
    const m = found.match(/^ok\n\d+ match(?:es)? for "trash Bob" among \d+ elements, best first:\n(i\d+) icon "trash can"  \(in: Bob: Weekly report\)/);
    assert.ok(m, found);
    const out = await shell.run(`senju click ${m[1]}`);
    assert.match(out, /Deleted the message from Bob/, out);
    assert.equal(cards.length, 1, 'clicking a trash icon is a delete, so it asks first');
    assert.match(await shell.run('senju click i999'), /^error: there is no icon i999 now/);
    assert.match(await shell.run('senju click "nothing like this"'), /Try senju find "nothing like this"/);
  });

  await test('find: an entry of a closed menu says which icon opens it', async () => {
    const shell = createShell({ conn, agent: 'f4', guard: createGuard() });
    await shell.run(`senju open ${url}big`);
    const found = await shell.run('senju find "pin Carol to top"');
    const m = found.match(/\n(i\d+) menu item "Pin to top" \[in a closed menu: click (i\d+) first\]/);
    assert.ok(m, found);
    assert.match(await shell.run(`senju click ${m[1]}`), new RegExp(`^error: ${m[1]} "Pin to top" is in a closed menu\\. Click ${m[2]} first`));
    assert.match(await shell.run(`senju click ${m[2]}\nsenju click ${m[1]}`), /Pinned Carol/);
  });

  await test('open /path stays on the current site; look --page 2 continues the page', async () => {
    const shell = createShell({ conn, agent: 'f3', guard: createGuard() });
    assert.match(await shell.run('senju open /account/orders'), /^error: "\/account\/orders" is a path; open a full URL first/);
    await shell.run(`senju open ${url}big`);
    assert.match(await shell.run('senju open /account/orders'), /^ok\npage: Your orders\nurl: http:\/\/127\.0\.0\.1:\d+\/account\/orders/);
    await shell.run('senju back');
    const p2 = await shell.run('senju look --page 2');
    assert.match(p2, /^ok\npage: Big Store\n.*\n-- elements \(\d+-\d+ of \d+\)\ne\d+ link "Product number \d+/, p2.slice(0, 300));
    assert.match(await shell.run('senju look --page x'), /^error: usage: senju look --page 2/);
  });

  await test('key and back', async () => {
    const shell = createShell({ conn, agent: 'w4', guard: createGuard() });
    await shell.run(`senju open ${url}`);
    const look = await shell.run('senju look');
    const name = idOf(look, /textbox "Your name"/);
    assert.match(await shell.run(`senju click ${name}\nsenju key cmd+a\nsenju key tab`), /^ok\n/);
    assert.match(await shell.run(`senju open ${url}#second`), /^ok/);
    assert.match(await shell.run('senju back'), /^ok/);
  });
});

if (failures) { console.error(`${failures} shell test(s) failed`); process.exit(1); }
console.log('shell tests passed');
