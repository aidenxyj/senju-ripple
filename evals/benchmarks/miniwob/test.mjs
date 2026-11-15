// Near misses for the MiniWoB++ checker, in a real headless browser:   node evals/benchmarks/miniwob/test.mjs
// A wrong click fails, a reload after it does not give a second try, and a right answer passes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { miniwobTask } from './task.mjs';
import { solveMiniwob } from './solver.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
if (!fs.existsSync(path.join(ROOT, 'prototype/node_modules/@playwright/mcp/cli.js'))) {
  console.log('skip: run npm install in prototype/ first');
  process.exit(0);
}
const { connectServer, resolveSpec } = await import('../../../prototype/src/mcp.js');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'miniwob-test-'));
const conn = await connectServer('browser', resolveSpec({ command: 'bundled', args: ['node_modules/@playwright/mcp/cli.js', '--isolated', '--headless', '--output-dir', path.join(work, 'pw')] }, work));
const run = (fn) => conn.client.callTool({ name: 'browser_evaluate', arguments: { function: fn } });
const go = (url) => conn.client.callTool({ name: 'browser_navigate', arguments: { url } });
const settle = () => new Promise((r) => setTimeout(r, 400));

async function episode(name, act, { seed } = {}) {
  const task = miniwobTask(name);
  const ctx = { workspace: work, ...(seed === undefined ? {} : { seed }) };
  await task.setup(ctx);
  try {
    await act(ctx);
    await settle();
    return { verdict: await task.check(ctx), goal: task.goal(ctx) };
  } finally { await task.teardown(ctx); }
}

let failures = 0;
const test = async (name, fn) => { try { await fn(); } catch (err) { failures++; console.error(`FAIL ${name}\n  ${err.message}`); } };

try {
  await test('wrong button fails with reward -1', async () => {
    const { verdict } = await episode('click-button', async ({ url }) => {
      await go(url);
      await run(`() => { const q = document.getElementById('query').textContent; const b = [...document.querySelectorAll('#area button')].find((x) => !q.includes('"' + x.textContent + '"')); b.click(); }`);
    });
    assert.equal(verdict.pass, false);
    assert.match(verdict.detail, /reward -1/);
  });
  await test('reloading after a wrong answer does not give a second try', async () => {
    const { verdict } = await episode('enter-text', async ({ url }) => {
      await go(url);
      await run(`() => { document.getElementById('tt').value = 'wrong'; document.getElementById('subbtn').click(); }`);
      await settle();
      await go(url);
      await run(`async () => (${solveMiniwob.toString()})('enter-text')`);
    });
    assert.equal(verdict.pass, false);
    assert.match(verdict.detail, /reward -1.*2 episodes; the first counts/);
  });
  await test('opened but never finished', async () => {
    const { verdict } = await episode('login-user', async ({ url }) => { await go(url); });
    assert.equal(verdict.pass, false);
    assert.match(verdict.detail, /never finished/);
  });
  await test('partly right checkboxes: graded like MiniWoB, raw reward must be above 0', async () => {
    const { verdict } = await episode('click-checkboxes', async ({ url }) => {
      await go(url);
      await run(`() => { const boxes = [...document.querySelectorAll('#boxes input')]; boxes.forEach((b) => b.click()); document.getElementById('subbtn').click(); }`);
    });
    assert.equal(verdict.pass, false, verdict.detail);   // seed 42 asks for nothing, so ticking everything scores -1
  });
  await test('another seed: a different instance, solved, and the goal points at the page', async () => {
    const { verdict, goal } = await episode('search-engine', async ({ url }) => {
      await go(url);
      await run(`async () => (${solveMiniwob.toString()})('search-engine')`);
    }, { seed: 7 });
    assert.equal(verdict.pass, true, verdict.detail);
    assert.match(goal, /instruction is shown at the top of the page/);
  });
} finally {
  await conn.close();
  fs.rmSync(work, { recursive: true, force: true });
}
if (failures) { console.error(`${failures} miniwob test(s) failed`); process.exit(1); }
console.log('miniwob tests passed');
