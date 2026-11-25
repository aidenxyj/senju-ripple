// Live check: the real Swarm with the model in .env answering every call,
// against the swarm engine's echo MCP server (same setup as app/test/smoke.mjs, minus the fake model).
// Run: node --env-file=.env harness/live-smoke.mjs [--no-guard]
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeStack, makeSwarm } from './index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const echo = { command: process.execPath, args: [path.join(here, '../app/test/echo-server.mjs')], app: 'Finder' };

const calls = [];
const guardEvents = [];
const noGuard = process.argv.includes('--no-guard');
const llm = await makeStack({ guard: !noGuard, onCall: (c) => calls.push(c), onGuard: (e) => guardEvents.push(e) });

const events = [];
const swarm = await makeSwarm({
  stack: llm,
  config: { maxSteps: 12, servers: { echo } },
  workspace: '/tmp',
  emit: (e) => {
    events.push(e);
    if (['spawn', 'board', 'done', 'error'].includes(e.type)) console.log(`[${e.type}]`, e.agent?.name ?? e.note ?? e.summary ?? e.message ?? '');
  },
});

const t0 = Date.now();
await swarm.run('Use two workers in parallel. One shouts the word "hello" with the echo tool, the other shouts "world". Each worker posts its shouted result on the shared board. Then report both results.');
await swarm.shutdown();

const done = events.find((e) => e.type === 'done');
console.log(`\n${calls.length} model calls in ${((Date.now() - t0) / 1000).toFixed(1)} s`, JSON.stringify(calls));
// Plumbing (adapter/sched): must always hold.
assert.ok(!events.some((e) => e.type === 'error'), 'no errors');
assert.ok(done, 'swarm finished');
assert.ok(calls.length > 0 && calls.every((c) => ['end_turn', 'tool_use'].includes(c.stop)), 'every call came back clean');
// Behaviour (the model following the goal): reported, not enforced. guard/ and shell/ exist to raise this.
const notes = events.filter((e) => e.type === 'board').map((e) => e.note).join(' ');
const behaviour = {
  spawnedTwo: events.filter((e) => e.type === 'spawn').length >= 2,
  usedEcho: events.some((e) => e.type === 'agent' && e.status === 'acting' && e.server === 'echo'),
  postedBoth: /HELLO/.test(notes) && /WORLD/.test(notes),
  summaryBoth: /HELLO/i.test(done.summary) && /WORLD/i.test(done.summary),
};
const score = Object.values(behaviour).filter(Boolean).length;
console.log(`behaviour ${score}/4 guard=${!noGuard} nudges=${guardEvents.length}`, JSON.stringify(behaviour));
console.log('live smoke passed (plumbing)');
