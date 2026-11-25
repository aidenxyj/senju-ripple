// One generation of the autoresearch loop for one task.
//
//   node evals/research/run.mjs --task <id> [--k 6] [--concurrency 3] [--label "what changed"]
//   node evals/research/run.mjs --task <id> --seeds unseen      readiness check on seeds the researcher never sees
//   node evals/research/run.mjs --status [--task <id>]          the ledger, summarised
//
// It runs the task k times on fresh variants (ctx.seed), with evals/skills/<task>/ injected through
// lib/policy.mjs and served as a skill, records every call (lib/record.mjs), scores each run
// (milestones = partial credit), and compares the generation with the task's champion:
//   keep     score up by 0.1 or more, or pass rate up by at least one run with no fall in score
//   revert   otherwise; the skill folder is restored from the champion's snapshot (unless --no-revert)
//   baseline the task's first generation, which becomes the champion
// Each generation appends a row to research/ledger.jsonl and a line to the skill's HISTORY.md.
// Episodes go to evals/results/research/<task>/<run>/<n>-seed<s>/{transcript.md, calls.jsonl, row.json}.
//
// Other options: --model llm|stub|noop (default llm), --skill <dir>, --no-skill (raw baseline),
// --export [--to <dir>] (write the skill as <task>.md into app/skills/, the app's skills folder),
// --seeds train|unseen|1,2,3, --timeout <s>, --no-guard, --context-budget <tokens> (default 32000, as in app/),
// --no-shell (raw MCP tools instead of the senju shell), --decline (answer every confirm card with Decline), --ledger <file>, --runs <dir>, --init (create the skill folder only).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadTasks, runTask } from '../run.mjs';
import { SKILLS_DIR, initSkill, loadSkill, skillSource, exportSkill } from '../lib/skills.mjs';
import { withPolicy } from '../lib/policy.mjs';
import { recorder } from '../lib/record.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
export const LEDGER = path.join(HERE, 'ledger.jsonl');
export const RUNS = path.resolve(HERE, '..', 'results', 'research');
export const READY = 5 / 6;
export const APP_SKILLS = path.join(ROOT, 'app', 'skills');   // app/ run from source reads its skills here
const SKILL_FILES = ['SKILL.md', 'policy.json', 'examples'];

export function readLedger(file = LEDGER) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

/** The task's current champion: the last kept training generation for this model and mode (shell or raw tools). */
export function championOf(rows, task, model, shell = true) {
  return rows.filter((r) => r.task === task && r.kind === 'train' && r.model === model && (r.shell ?? false) === shell && r.kept).at(-1) ?? null;
}

/** Training seeds move every generation, so the skill cannot memorise one variant. Unseen seeds stay fixed. */
export function seedsFor(kind, gen, k) {
  if (Array.isArray(kind)) return kind;
  if (kind === 'unseen') return Array.from({ length: k }, (_, i) => 1001 + i);
  const start = 1 + ((gen * k) % 900);
  return Array.from({ length: k }, (_, i) => start + i);
}

/** keep | revert, comparing a generation with the champion. Rates, so a different k still compares fairly. */
export function decide(gen, champ) {
  if (!champ) return 'baseline';
  const rate = gen.passes / gen.k;
  const champRate = champ.passes / champ.k;
  if (gen.score >= champ.score + 0.1) return 'keep';
  if (rate >= champRate + 1 / Math.max(gen.k, champ.k) - 1e-9 && gen.score >= champ.score) return 'keep';
  return 'revert';
}

function skillHash(dir) {
  if (!dir || !fs.existsSync(dir)) return null;
  const h = crypto.createHash('sha1');
  const walk = (p) => {
    if (!fs.existsSync(p)) return;
    if (fs.statSync(p).isDirectory()) for (const f of fs.readdirSync(p).sort()) walk(path.join(p, f));
    else h.update(path.relative(dir, p)).update(fs.readFileSync(p));
  };
  for (const f of SKILL_FILES) walk(path.join(dir, f));
  return h.digest('hex').slice(0, 10);
}

function gitSha() {
  try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(); } catch { return null; }
}

function copySkill(from, to) {
  for (const f of SKILL_FILES) {
    const src = path.join(from, f);
    const dst = path.join(to, f);
    fs.rmSync(dst, { recursive: true, force: true });
    if (fs.existsSync(src)) fs.cpSync(src, dst, { recursive: true });
  }
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

const firstMissed = (row) => {
  if (row.pass) return null;
  if (row.detail?.startsWith('runner error')) return 'infra: runner error';
  return row.milestones?.find((m) => !m.ok)?.name ?? `fail: ${String(row.detail ?? '').split(' | ')[0].slice(0, 80)}`;
};

export async function runGeneration({
  task: taskId, k = 6, concurrency = 3, seeds = 'train', model = 'llm', label = '', skillDir, noSkill = false,
  timeout, guard, ledger = LEDGER, runs = RUNS, revert = true, contextBudget = 32000, shell = true, answer = 'approve', log = console.log,
} = {}) {
  const [task] = await loadTasks([taskId]);
  const dir = noSkill ? null : initSkill(task, skillDir ? { dir: skillDir } : {});
  const skill = dir ? loadSkill(dir) : null;
  const rows = readLedger(ledger);
  const kind = seeds === 'train' ? 'train' : 'check';
  const trainGens = rows.filter((r) => r.task === task.id && r.kind === 'train').length;
  const gen = kind === 'train' ? trainGens : Math.max(0, trainGens - 1);
  const seedList = seedsFor(Array.isArray(seeds) ? seeds : seeds, gen, k);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = path.join(runs, task.id, `${stamp}-${kind}-g${gen}`);
  fs.mkdirSync(runDir, { recursive: true });
  if (dir) copySkill(dir, path.join(runDir, 'skill'));

  log(`${task.id}: ${kind} generation ${gen}, ${seedList.length} runs on ${model}${shell ? ' through the senju shell, as app/ runs it' : ' with raw MCP tools'} (seeds ${seedList.join(', ')})${skill ? `, skill ${path.relative(ROOT, dir)}` : ', no skill'}`);
  const episodes = await pool(seedList, concurrency, async (seed, i) => {
    const epDir = path.join(runDir, `${i + 1}-seed${seed}`);
    let rec = null;
    let goal = '';
    const row = await runTask(task, model, {
      seed, timeout, ...(guard === undefined ? {} : { guard }),
      skills: dir ? skillSource([dir]) : undefined,
      // As app/ builds it (shell mode): Swarm -> shell note -> policy -> guard -> context.fit -> sched -> meter -> recorder -> model.
      shell, contextBudget, answer,
      wrapLlm: (llm, { ctx }) => { goal = ctx.goal; rec = recorder(llm, epDir); return rec.llm; },
      wrapStack: (stack) => withPolicy(stack, { skill, policy: skill?.policy ?? {} }),
    });
    fs.mkdirSync(epDir, { recursive: true });
    const lines = [`Goal: ${goal}`, '', `Result: ${row.pass ? 'PASS' : 'FAIL'}, score ${row.score.toFixed(2)}, ${row.steps} calls, ${row.seconds} s, ${row.invalidCalls} invalid calls`, '', `Checker: ${row.detail}`];
    if (row.milestones) lines.push('', 'Milestones:', ...row.milestones.map((m) => `- [${m.ok ? 'x' : ' '}] ${m.name}`));
    rec?.writeTranscript({ title: `${task.id}, seed ${seed}`, lines });
    fs.writeFileSync(path.join(epDir, 'row.json'), JSON.stringify({ seed, ...row }, null, 2) + '\n');
    log(`  ${row.pass ? 'PASS' : 'FAIL'} seed ${seed}  score ${row.score.toFixed(2)}  ${row.steps} calls  ${row.seconds}s${row.pass ? '' : `  (${firstMissed(row)})`}`);
    return { seed, dir: epDir, row };
  });

  const n = episodes.length;
  const mean = (f) => Math.round((episodes.reduce((s, e) => s + f(e.row), 0) / n) * 1000) / 1000;
  const missed = {};
  for (const e of episodes) { const m = firstMissed(e.row); if (m) missed[m] = (missed[m] ?? 0) + 1; }
  const infra = episodes.filter((e) => e.row.detail?.startsWith('runner error')).length;
  const summary = { k: n, passes: episodes.filter((e) => e.row.pass).length, score: mean((r) => r.score) };
  const champ = kind === 'train' ? championOf(rows, task.id, model, shell) : null;
  let verdict = kind === 'train' ? decide(summary, champ) : (summary.passes / n >= READY - 1e-9 ? 'ready' : 'not ready');
  if (infra * 2 > n) verdict = 'infra';
  const kept = verdict === 'keep' || verdict === 'baseline';

  let restored = false;
  if (verdict === 'revert' && revert && dir && champ?.runDir) {
    const snap = path.join(ROOT, champ.runDir, 'skill');
    if (fs.existsSync(snap)) { copySkill(snap, dir); restored = true; }
  }

  const entry = {
    time: new Date().toISOString(), task: task.id, kind, gen, model, shell, label,
    gitSha: gitSha(), skillHash: skillHash(path.join(runDir, 'skill')), runDir: path.relative(ROOT, runDir),
    seeds: seedList, ...summary, steps: mean((r) => r.steps), invalidCalls: episodes.reduce((s, e) => s + e.row.invalidCalls, 0),
    seconds: mean((r) => r.seconds), firstMissed: missed, infra, verdict, kept: kind === 'train' ? kept : undefined,
    champion: champ ? { gen: champ.gen, score: champ.score, passes: champ.passes, k: champ.k } : null,
  };
  fs.mkdirSync(path.dirname(ledger), { recursive: true });
  fs.appendFileSync(ledger, JSON.stringify(entry) + '\n');
  if (dir) {
    const hist = path.join(dir, 'HISTORY.md');
    if (fs.existsSync(hist)) fs.appendFileSync(hist, `| ${kind === 'train' ? `g${gen}` : `check after g${gen}`} | ${seedList[0]}–${seedList.at(-1)} | ${summary.score.toFixed(2)} | ${summary.passes}/${n} | ${verdict}${restored ? ' (restored)' : ''} | ${label.replace(/\|/g, '/').replace(/\n/g, ' ')} |\n`);
  }

  log('');
  log(`${task.id} ${kind} g${gen}: score ${summary.score.toFixed(2)}, passes ${summary.passes}/${n}${champ ? ` (champion g${champ.gen}: ${champ.score.toFixed(2)}, ${champ.passes}/${champ.k})` : ''} -> ${verdict.toUpperCase()}${restored ? ', skill restored from the champion' : ''}`);
  if (Object.keys(missed).length) {
    log('First missed milestone:');
    for (const [m, c] of Object.entries(missed).sort((a, b) => b[1] - a[1])) log(`  ${c}x  ${m}`);
  }
  const failing = episodes.filter((e) => !e.row.pass);
  if (failing.length && kind === 'train') {
    log('Failing transcripts:');
    for (const e of failing) log(`  ${path.relative(process.cwd(), path.join(e.dir, 'transcript.md'))}`);
  }
  const passing = episodes.filter((e) => e.row.pass);
  if (passing.length && kind === 'train') {
    log('Passing transcripts (material for the playbook and examples/):');
    for (const e of passing) log(`  ${path.relative(process.cwd(), path.join(e.dir, 'transcript.md'))}`);
  }
  return { entry, episodes };
}

export function status({ task, ledger = LEDGER, log = console.log } = {}) {
  const rows = readLedger(ledger).filter((r) => !task || r.task === task);
  const tasks = [...new Set(rows.map((r) => r.task))];
  if (!tasks.length) { log('The ledger is empty.'); return; }
  for (const t of tasks) {
    const mine = rows.filter((r) => r.task === t);
    const train = mine.filter((r) => r.kind === 'train');
    const champ = train.filter((r) => r.kept).at(-1);
    const checks = mine.filter((r) => r.kind === 'check');
    const ready = checks.length >= 2 && checks.slice(-2).every((r) => r.verdict === 'ready');
    log(`${t}: ${train.length} generations, champion g${champ?.gen ?? '-'} (score ${champ?.score?.toFixed(2) ?? '-'}, ${champ ? `${champ.passes}/${champ.k}` : '-'})${checks.length ? `, last unseen check ${checks.at(-1).passes}/${checks.at(-1).k}` : ''}${ready ? ', DEMO-READY' : ''}`);
    for (const r of mine.slice(-8)) log(`  ${r.kind === 'train' ? `g${r.gen}` : 'check'}  ${r.score.toFixed(2)}  ${r.passes}/${r.k}  ${r.verdict.padEnd(9)} ${r.label ?? ''}`);
  }
}

function parseArgs(argv) {
  const o = { task: null, k: 6, concurrency: 3, seeds: 'train', model: 'llm', label: '', revert: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === '--task') o.task = next();
    else if (a === '--k') o.k = Number(next());
    else if (a === '--concurrency') o.concurrency = Number(next());
    else if (a === '--seeds') { const v = next(); o.seeds = /^[\d,\s]+$/.test(v) ? v.split(',').map(Number) : v; }
    else if (a === '--model') o.model = next();
    else if (a === '--label') o.label = next();
    else if (a === '--skill') o.skillDir = path.resolve(next());
    else if (a === '--no-skill') o.noSkill = true;
    else if (a === '--timeout') o.timeout = Number(next());
    else if (a === '--no-guard') o.guard = false;
    else if (a === '--ledger') o.ledger = path.resolve(next());
    else if (a === '--runs') o.runs = path.resolve(next());
    else if (a === '--no-revert') o.revert = false;
    else if (a === '--context-budget') o.contextBudget = Number(next());
    else if (a === '--no-shell') o.shell = false;
    else if (a === '--decline') o.answer = 'decline';
    else if (a === '--export') o.export = true;
    else if (a === '--to') o.to = path.resolve(next());
    else if (a === '--status') o.status = true;
    else if (a === '--init') o.init = true;
    else throw new Error(`unknown argument "${a}"`);
  }
  if (!o.status && !o.task) throw new Error('pass --task <id> (or --status)');
  if (!['train', 'unseen'].includes(o.seeds) && !Array.isArray(o.seeds)) throw new Error('--seeds is train, unseen or a list like 1,2,3');
  return o;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* stub and noop need no keys */ }
  try {
    const o = parseArgs(process.argv.slice(2));
    if (o.status) status(o);
    else if (o.export) {
      const dir = o.skillDir ?? path.join(SKILLS_DIR, o.task);
      const file = exportSkill(dir, o.to ?? APP_SKILLS);
      console.log(`Exported ${path.relative(process.cwd(), dir)} to ${path.relative(process.cwd(), file)}. The app's lead lists it and can read_skill it.`);
    } else if (o.init) {
      const [task] = await loadTasks([o.task]);
      console.log(`skill folder: ${path.relative(process.cwd(), initSkill(task, o.skillDir ? { dir: o.skillDir } : { root: SKILLS_DIR }))}`);
    } else await runGeneration(o);
  } catch (err) {
    console.error(`research: ${err.message}`);
    process.exitCode = 2;
  }
}
