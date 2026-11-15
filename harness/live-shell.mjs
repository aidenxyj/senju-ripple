// Live check: Ripple workers drive a real (headless) browser through the senju shell.
// Runs eval tasks through makeRippleSwarm({ shell: true }) and auto-answers the person's prompts.
// Run: node --env-file=.env harness/live-shell.mjs [--task web-form] [--suite core|hard|games] [--decline] [--no-guard] [--headed] [--verbose]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeRippleStack, makeRippleSwarm } from './index.js';
import { loadTasks } from '../evals/run.mjs';
import { pickServers } from '../evals/lib/servers.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const only = (arg('--task', 'web-form') || '').split(',').filter(Boolean);
const decline = process.argv.includes('--decline');
const headed = process.argv.includes('--headed');
// --headed: show the Chrome windows so you can watch the agents work.
const serversFor = (names) => {
  const out = pickServers(names);
  if (headed) for (const k of Object.keys(out)) out[k] = { ...out[k], args: (out[k].args ?? []).filter((a) => a !== '--headless') };
  return out;
};
const tasks = await loadTasks(only, arg('--suite'));
if (!tasks.length) throw new Error(`no task matched ${only.join(',')}`);

let failed = 0;
for (const task of tasks) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), `senju-${task.id}-`));
  const ctx = { workspace };
  await task.setup?.(ctx);
  const goalText = typeof task.goal === 'function' ? task.goal(ctx) : task.goal;
const goal = goalText.replace(/\{(\w+)\}/g, (m, k) => (ctx[k] ?? m));
  const calls = [], guardEvents = [], asks = [], sh = [];
  const verbose = process.argv.includes('--verbose');
  const { rippleFromEnv } = await import('../adapter/index.js');
  const base = rippleFromEnv();
  const llm = !verbose ? base : { async create(params, opts) {
    const res = await base.create(params, opts);
    const who = params.tools?.some((t) => t.name === 'spawn_agent') ? 'lead' : 'worker';
    const last = params.messages.at(-1);
    const result = Array.isArray(last?.content) ? last.content.filter((b) => b.type === 'tool_result').map((b) => (typeof b.content === 'string' ? b.content : (b.content ?? []).map((c) => c.text ?? '').join(''))).join(' | ') : String(last?.content ?? '');
    console.log(`  <- ${who}: ${result.replace(/\s+/g, ' ').slice(0, 220)}`);
    for (const b of res.content) console.log(`  -> ${who}: ${b.type === 'text' ? 'say ' + JSON.stringify(b.text.slice(0, 160)) : b.name + ' ' + JSON.stringify(b.input).slice(0, 200)}`);
    return res;
  } };
  const stack = await makeRippleStack({ llm, guard: !process.argv.includes('--no-guard'), onCall: (c) => calls.push(c), onGuard: (e) => { guardEvents.push(e); if (verbose) console.log('  [guard]', JSON.stringify(e).slice(0, 300)); } });
  let swarm;
  const t0 = Date.now();
  swarm = await makeRippleSwarm({
    stack, shell: true, workspace,
    config: { maxSteps: 40, servers: serversFor(task.servers ?? []) },
    emit: (e) => {
      if (e.type === 'ask') {
        // Stand in for the person: approve (or decline with --decline) every prompt.
        const reply = decline ? 'Decline' : (e.options?.[0] ?? 'Yes, go ahead');
        asks.push(`${e.question ?? e.kind} -> ${reply}`);
        setTimeout(() => swarm.answer(e.qid, reply), 50);
      }
      if (e.type === 'agent' && e.status === 'acting') sh.push(e.label);
      if (e.type === 'error') console.log('  [error]', e.message);
    },
  });
  await Promise.race([swarm.run(goal), new Promise((r) => setTimeout(r, (task.timeout ?? 240) * 1000))]);
  await swarm.shutdown();
  const verdict = await task.check(ctx);
  await task.teardown?.(ctx);
  fs.rmSync(workspace, { recursive: true, force: true });
  if (!verdict.pass) failed++;
  const shCalls = calls.flatMap((c) => c.tools).filter((t) => t.endsWith('__sh')).length;
  console.log(`${verdict.pass ? 'PASS' : 'FAIL'}  ${task.id}  calls=${calls.length} sh=${shCalls} nudges=${guardEvents.length} ${((Date.now() - t0) / 1000).toFixed(1)}s  (${verdict.detail})`);
  for (const a of asks) console.log(`  ask: ${a}`);
}
process.exit(failed ? 1 : 0);
