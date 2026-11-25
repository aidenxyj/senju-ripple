// Eval runner. Runs each task in evals/tasks/ through the swarm engine's Swarm with one model,
// then writes evals/results/<run>.json: one row per task, { task, model, pass, steps, tokens, seconds, invalidCalls }.
//
//   npm run eval -- --model llm|stub|noop [--suite core|hard|games|benchmarks|all] [--task <id>]... [--timeout <seconds>] [--out <file>] [--no-guard]
//
// Suites: core is evals/tasks/*.js (the default, fast), hard is evals/tasks/hard/, games is evals/tasks/games/,
// benchmarks is evals/tasks/benchmarks/ (ports of MiniWoB++, WebGames and OpenApps; their assets live in evals/benchmarks/).
// --task looks in every suite, so --task price-hunt works without --suite.
//
// llm runs behind guard/'s guardLlm (repairs tool calls, lead must spawn, worker posts before done)
// unless --no-guard is given. invalidCalls counts the model's own mistakes, before the guard repairs them.
//
// A task module (evals/tasks/<id>.js) exports default { id, goal, setup(ctx), check(ctx) -> { pass, detail } }, plus optional:
//   servers   MCP servers the task needs, from lib/servers.mjs (default none)
//   stub      scripted worker steps used by --model stub, each { name, input } or ({ ctx, lastText }) => { name, input }
//   teardown  (ctx) => cleanup after check
//   timeout   seconds before the run is cancelled (default 300)
// ctx is { workspace } (a fresh scratch folder) plus whatever setup adds. {workspace}, {url} etc. in goal are filled from ctx.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Swarm } from '../app/src/orchestrator.js';
import { makeModel } from './lib/models.mjs';
import { meter } from './lib/meter.mjs';
import { pickServers } from './lib/servers.mjs';
import { guardLlm } from '../guard/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

export const SUITES = { core: 'tasks', hard: 'tasks/hard', games: 'tasks/games', benchmarks: 'tasks/benchmarks' };

export async function loadTasks(only = [], suite) {
  const names = suite === 'all' || (!suite && only.length) ? Object.keys(SUITES) : [suite ?? 'core'];
  const tasks = [];
  for (const name of names) {
    if (!SUITES[name]) throw new Error(`no such suite "${name}" (have: ${Object.keys(SUITES).join(', ')}, all)`);
    const dir = path.join(HERE, SUITES[name]);
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort();
    for (const f of files) {
      const task = (await import(pathToFileURL(path.join(dir, f)).href)).default;
      if (!task?.id || !task.goal || typeof task.check !== 'function') throw new Error(`${f}: a task needs id, goal and check()`);
      if (tasks.some((t) => t.id === task.id)) throw new Error(`${f}: duplicate task id "${task.id}"`);
      task.suite = name;
      if (only.length === 0 || only.includes(task.id)) tasks.push(task);
    }
  }
  const missing = only.filter((id) => !tasks.some((t) => t.id === id));
  if (missing.length) throw new Error(`no such task: ${missing.join(', ')}`);
  return tasks;
}

const fill = (text, ctx) => text.replace(/\{(\w+)\}/g, (m, k) => (k in ctx ? String(ctx[k]) : m));

// Extra options, used by the autoresearch loop (research/run.mjs):
//   seed      passed to the task as ctx.seed, so a task can build a fresh variant of itself
//   skills    a skills source ({ list, read, save }) handed to the Swarm, e.g. lib/skills.mjs
//   wrapLlm   (llm, { task, ctx }) => llm (or a promise), around the raw model client, inside the meter (recorder)
//   wrapStack (llm, { task, ctx }) => llm (or a promise), around the whole stack, just below the Swarm (policy)
//   shell     true: build the swarm exactly as app/ does, harness makeStack + makeSwarm({ shell: true }):
//             Swarm -> shell note -> wrapStack -> guard -> context.fit -> sched -> meter -> wrapLlm -> model.
//             Confirm cards and questions to the person are answered automatically (`answer`: approve | decline).
//   contextBudget  tokens per call for context.fit in shell mode (default 32000, as in the app)
// A checker may also return { score, milestones: [{ name, ok }] }; the row then carries both.
export async function runTask(task, modelName, {
  timeout, guard = modelName === 'llm', seed, skills, wrapLlm, wrapStack,
  shell = false, answer = 'approve', contextBudget = 32000,
} = {}) {
  const started = Date.now();
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `senju-eval-${task.id}-`)));
  const ctx = { workspace, ...(seed === undefined ? {} : { seed }) };
  const row = { task: task.id, model: modelName, pass: false, score: 0, steps: 0, tokens: 0, seconds: 0, invalidCalls: 0, guard, nudges: 0, detail: '' };
  if (shell) Object.assign(row, { shell: true, asks: 0 });
  let swarm = null;
  try {
    await task.setup?.(ctx);
    ctx.goal = fill(typeof task.goal === 'function' ? task.goal(ctx) : task.goal, ctx);
    const made = await makeModel(modelName, { task, ctx });
    const { model } = made;
    const llm = wrapLlm ? await wrapLlm(made.llm, { task, ctx }) : made.llm;
    // The meter sits just above the model, so it sees every real call, including the guard's retries,
    // and counts the model's own mistakes before the guard repairs them.
    const metered = meter(llm);
    const errors = [];
    const onGuard = (e) => { if (e.type === 'nudge') row.nudges += 1; };
    const config = {
      model, plannerModel: model,
      maxAgents: 4, maxSteps: task.maxSteps ?? 40, tokenBudget: task.tokenBudget ?? 2_000_000,
      context: { enabled: false }, trace: false, skills: false,
      servers: pickServers(task.servers),
    };
    const emit = (e) => {
      if (e.type === 'error' || e.type === 'notice') errors.push(e.message);
      if (e.type === 'ask' && swarm) {
        // Stand in for the person, as harness/live-shell.mjs does: approve (or decline) every card and question.
        row.asks = (row.asks ?? 0) + 1;
        const yes = e.options?.find((o) => /approve|yes/i.test(o)) ?? e.options?.[0] ?? 'Yes, go ahead';
        const no = e.options?.find((o) => /decline|no/i.test(o)) ?? 'No';
        setTimeout(() => swarm?.answer?.(e.qid, answer === 'decline' ? no : yes), 20);
      }
    };
    if (shell) {
      const { makeStack, makeSwarm } = await import('../harness/index.js');
      const stack = await makeStack({ llm: metered.llm, guard: guard ? true : false, onGuard, contextBudget });
      const top = wrapStack ? await wrapStack(stack, { task, ctx }) : stack;
      swarm = await makeSwarm({ stack: top, shell: true, config, workspace, emit, ...(skills ? { skills } : {}) });
    } else {
      // Swarm -> wrapStack -> guard -> meter -> wrapLlm -> model.
      const guarded = guard ? guardLlm(metered.llm, { onEvent: onGuard }) : metered.llm;
      const top = wrapStack ? await wrapStack(guarded, { task, ctx }) : guarded;
      swarm = new Swarm({ llm: top, config, workspace, emit, ...(skills ? { skills } : {}) });
    }
    const limit = (timeout ?? task.timeout ?? 300) * 1000;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; swarm.cancel(); }, limit);
    try { await swarm.run(ctx.goal); } finally { clearTimeout(timer); }
    Object.assign(row, { steps: metered.stats.steps, tokens: metered.stats.tokens, invalidCalls: metered.stats.invalidCalls });
    const verdict = await task.check(ctx);
    row.pass = Boolean(verdict?.pass);
    row.score = scoreOf(verdict);
    if (Array.isArray(verdict?.milestones)) row.milestones = verdict.milestones.map((m) => ({ name: String(m.name), ok: Boolean(m.ok) }));
    row.detail = [verdict?.detail, timedOut && `timed out after ${limit / 1000} s`, ...errors.filter((m) => m !== 'Cancelled.')]
      .filter(Boolean).join(' | ');
    if (metered.stats.invalid.length) row.invalid = metered.stats.invalid.slice(0, 20);
  } catch (err) {
    row.pass = false;
    row.detail = `runner error: ${err?.message ?? err}`;
  } finally {
    await swarm?.shutdown().catch(() => {});
    await Promise.resolve(task.teardown?.(ctx)).catch(() => {});
    fs.rmSync(workspace, { recursive: true, force: true });
    row.seconds = Math.round((Date.now() - started) / 100) / 10;
  }
  return row;
}

/** A checker's partial credit in [0, 1]: its own score, else the share of milestones met, else 1 or 0 for pass. */
export function scoreOf(verdict) {
  if (Number.isFinite(verdict?.score)) return Math.max(0, Math.min(1, verdict.score));
  const ms = Array.isArray(verdict?.milestones) ? verdict.milestones : [];
  if (verdict?.pass) return 1;
  return ms.length ? ms.filter((m) => m.ok).length / ms.length : 0;
}

export async function runEval({ model, only = [], suite, timeout, out, guard } = {}) {
  const tasks = await loadTasks(only, suite);
  const rows = [];
  for (const task of tasks) {
    const row = await runTask(task, model, { timeout, ...(guard === undefined ? {} : { guard }) });
    rows.push(row);
    console.log(`${row.pass ? 'PASS' : 'FAIL'}  ${row.task}  steps=${row.steps} tokens=${row.tokens} ${row.seconds}s invalid=${row.invalidCalls}${row.guard ? ` nudges=${row.nudges}` : ''}${row.detail ? `  (${row.detail})` : ''}`);
  }
  const run = `${new Date().toISOString().replace(/[:.]/g, '-')}-${model}`;
  const file = out ?? path.join(HERE, 'results', `${run}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(rows, null, 2) + '\n');
  console.log(`${rows.filter((r) => r.pass).length}/${rows.length} passed. Wrote ${path.relative(process.cwd(), file)}`);
  return { rows, file };
}

function parseArgs(argv) {
  const opts = { model: null, only: [], suite: undefined, timeout: undefined, out: undefined, guard: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === '--model') opts.model = next();
    else if (a === '--task') opts.only.push(next());
    else if (a === '--suite') opts.suite = next();
    else if (a === '--timeout') opts.timeout = Number(next());
    else if (a === '--out') opts.out = path.resolve(next());
    else if (a === '--no-guard') opts.guard = false;
    else if (a === '--guard') opts.guard = true;
    else throw new Error(`unknown argument "${a}"`);
  }
  if (!opts.model) throw new Error('pass --model llm|stub|noop');
  return opts;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* no .env: fine for stub and noop */ }
  try {
    const { rows } = await runEval(parseArgs(process.argv.slice(2)));
    process.exitCode = rows.every((r) => r.pass) ? 0 : 1;
  } catch (err) {
    console.error(`eval: ${err.message}`);
    process.exitCode = 2;
  }
}
