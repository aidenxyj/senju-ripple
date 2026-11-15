// Serve one eval task's local pages for the desktop app (app/), print the goal to paste into the bar,
// and check the result when you press Ctrl+C.
// Run: npm run demo:serve -- <task-id>      e.g. drafts-cleanup, minesweeper-swarm, bomb-defusal, web-form
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadTasks } from '../evals/run.mjs';

const id = process.argv[2];
const task = id ? (await loadTasks([id]).catch(() => []))[0] : null;
if (!task) {
  const all = (await loadTasks([], 'all')).map((t) => t.id);
  console.log(`usage: npm run demo:serve -- <task>\ntasks: ${all.join(', ')}`);
  process.exit(1);
}

// Files the task needs go in a folder of its own inside the app's workspace (~/Senju).
const workspace = path.join(os.homedir(), 'Senju', `demo-${task.id}`);
fs.mkdirSync(workspace, { recursive: true });
const ctx = { workspace };
await task.setup?.(ctx);
const goalText = typeof task.goal === 'function' ? task.goal(ctx) : task.goal;
const goal = goalText.replace(/\{(\w+)\}/g, (m, k) => (k in ctx ? String(ctx[k]) : m));

console.log(`\nServing "${task.id}". Paste this goal into the Senju bar:\n\n${goal}\n`);
if ((task.servers ?? []).includes('files')) console.log(`(Files for this task are in ${workspace})\n`);
console.log('Press Ctrl+C when the swarm is done to check the result.');

process.on('SIGINT', async () => {
  try {
    const v = await task.check(ctx);
    console.log(`\n${v.pass ? 'PASS' : 'FAIL'}  ${task.id}  (${v.detail})`);
    for (const m of v.milestones ?? []) console.log(`  ${m.ok ? '✓' : '✗'} ${m.name}`);
  } finally {
    await task.teardown?.(ctx);
    process.exit(0);
  }
});
