// Integration: observe() and diff() on a local page in a fresh --isolated headless browser,
// launched through the swarm engine's own MCP plumbing. Skips if the swarm engine's dependencies
// (npm install in app/) or Chrome are missing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { observe, diff, resolve } from '../index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const PW_CLI = path.join(ROOT, 'app/node_modules/@playwright/mcp/cli.js');

async function setup(t) {
  if (!fs.existsSync(PW_CLI)) { t.skip('run `npm install` in app/ first'); return null; }
  const { connectServer, resolveSpec } = await import('../../app/src/mcp.js');
  // Playwright MCP writes .playwright-mcp/ into its working directory; keep it out of the repo.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'eyes-test-'));
  process.chdir(work);

  const html = fs.readFileSync(path.join(HERE, 'fixtures/form.html'));
  const server = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(html); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;

  let conn;
  try {
    const spec = resolveSpec({ command: 'bundled', args: ['node_modules/@playwright/mcp/cli.js', '--isolated', '--headless'] }, work);
    conn = await connectServer('browser', spec);
    const nav = await conn.client.callTool({ name: 'browser_navigate', arguments: { url } });
    if (nav.isError) throw new Error(nav.content?.[0]?.text ?? 'navigate failed');
  } catch (err) {
    server.close();
    await conn?.close();
    if (/browser|chrome|executable|install/i.test(String(err?.message))) { t.skip(`no browser: ${err.message}`); return null; }
    throw err;
  }
  t.after(async () => { await conn.close(); server.close(); fs.rmSync(work, { recursive: true, force: true }); });
  return { conn, url };
}

async function act(conn, tool, args) {
  const res = await conn.client.callTool({ name: tool, arguments: args });
  assert.ok(!res.isError, `${tool}: ${res.content?.[0]?.text}`);
}

test('observe and diff on a local page in a fresh browser', { timeout: 120000 }, async (t) => {
  const env = await setup(t);
  if (!env) return;
  const { conn, url } = env;

  const a = await observe(conn, undefined, { maxChars: 2000 });
  assert.ok(a.text.length <= 2000);
  assert.match(a.text, /^page: Eyes Test Page\nurl: http:\/\/127\.0\.0\.1:\d+\//);
  assert.match(a.text, /-- elements \(7\)\ne\d+ textbox "Email" = ""/);
  assert.match(a.text, /-- text \(2\)\n# Signup\nFill in the form below\./);
  assert.ok(a.text.indexOf('button "Submit"') < a.text.indexOf('# Signup'), 'elements come first');
  assert.ok(!/image|base64/i.test(a.text));

  const again = await observe(conn, undefined, { maxChars: 2000 });
  assert.equal(again.hash, a.hash);
  assert.equal(diff(a, again), 'no change');

  // Act through shell-style id resolution.
  const id = (v, name) => v.elements.find((e) => e.name === name).id;
  const email = resolve(conn, undefined, id(a, 'Email'));
  assert.equal(email.role, 'textbox');
  await act(conn, 'browser_type', { element: email.name, target: email.ref, text: 'a@b.c' });
  for (const name of ['Agree to terms', 'Play', 'Submit']) {
    const r = resolve(conn, undefined, id(a, name));
    await act(conn, 'browser_click', { element: r.name, target: r.ref });
  }

  const b = await observe(conn, 'current', { maxChars: 2000 });
  for (const name of ['Email', 'Agree to terms', 'Plan', 'Submit', 'Link A']) assert.equal(id(b, name), id(a, name), `${name} keeps its id`);
  assert.equal(id(b, 'Pause'), id(a, 'Play'), 'renamed button keeps its id');
  assert.notEqual(b.hash, a.hash);

  const d = diff(a, b);
  assert.match(d, new RegExp(`^- ${id(a, 'Link B')} link "Link B"`, 'm'));
  assert.match(d, /^\+ e\d+ button "Start over"$/m);
  assert.match(d, /~ e\d+ textbox "Email": value "" -> "a@b.c"/);
  assert.match(d, /~ e\d+ checkbox "Agree to terms": value "unchecked" -> "checked"/);
  assert.match(d, /name "Play" -> "Pause"/);
  assert.match(d, /^\+ text: Thanks, a@b\.c$/m);
  assert.doesNotMatch(d, /Signup|Link A|"Plan"/);
  assert.ok(!a.elements.some((e) => e.id === id(b, 'Start over')), 'fresh id for the new button');

  // Targets: by tab index and by URL substring.
  const c = await observe(conn, 0);
  const c2 = await observe(conn, '127.0.0.1');
  assert.equal(c.page.url, url);
  assert.equal(c2.page.url, url);
  await assert.rejects(observe(conn, 'no-such-tab'), /no tab matches/);
  t.diagnostic(`first observe:\n${a.text}\n\ndiff:\n${d}`);
});
