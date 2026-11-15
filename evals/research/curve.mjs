// The demo's learning curve: one chart per task, score per generation, from research/ledger.jsonl.
//   node evals/research/curve.mjs [--ledger <file>] [--out <file>]     default out: evals/results/research/curve.html
// Filled dots are kept generations (the champion line follows them), hollow dots were reverted,
// diamonds are readiness checks on unseen seeds.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEDGER, RUNS, readLedger } from './run.mjs';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function chart(task, rows) {
  const W = 720, H = 260, L = 48, R = 16, T = 16, B = 36;
  const gens = Math.max(1, ...rows.map((r) => r.gen + 1));
  const X = (g) => L + (gens === 1 ? 0.5 : g / (gens - 1)) * (W - L - R);
  const Y = (s) => T + (1 - s) * (H - T - B);
  const train = rows.filter((r) => r.kind === 'train');
  const champ = [];
  let best = null;
  for (const r of train) { if (r.kept) best = r; if (best) champ.push([r.gen, best.score]); }
  const line = champ.map(([g, s], i) => `${i ? 'L' : 'M'}${X(g).toFixed(1)} ${Y(s).toFixed(1)}`).join(' ');
  const grid = [0, 0.25, 0.5, 0.75, 1].map((s) => `<line x1="${L}" x2="${W - R}" y1="${Y(s)}" y2="${Y(s)}" class="grid"/><text x="${L - 8}" y="${Y(s) + 4}" text-anchor="end" class="tick">${s.toFixed(2)}</text>`).join('');
  const step = Math.max(1, Math.ceil(gens / 12));
  const xt = Array.from({ length: gens }, (_, g) => g).filter((g) => g % step === 0).map((g) => `<text x="${X(g)}" y="${H - 12}" text-anchor="middle" class="tick">g${g}</text>`).join('');
  const dots = train.map((r) => `<circle cx="${X(r.gen)}" cy="${Y(r.score)}" r="5" class="${r.kept ? 'kept' : 'rev'}"><title>g${r.gen}: ${r.score.toFixed(2)}, ${r.passes}/${r.k} passed, ${r.verdict}. ${esc(r.label)}</title></circle>`).join('');
  const checks = rows.filter((r) => r.kind === 'check').map((r) => `<path d="M${X(r.gen) + 10} ${Y(r.passes / r.k) - 6}l6 6l-6 6l-6 -6z" class="check"><title>unseen check after g${r.gen}: ${r.passes}/${r.k}</title></path>`).join('');
  const first = train[0];
  const head = first && best ? `${esc(task)}: score ${first.score.toFixed(2)} → ${best.score.toFixed(2)}, ${first.passes}/${first.k} → ${best.passes}/${best.k} runs passed` : esc(task);
  return `<section><h2>${head}</h2><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${head}">${grid}${xt}<path d="${line}" class="champ"/>${dots}${checks}</svg></section>`;
}

export function renderCurve(rows) {
  const tasks = [...new Set(rows.map((r) => r.task))];
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ripple learning curve</title>
<style>
:root{--bg:#fbfaf8;--ink:#1d1d1b;--quiet:#6b6a66;--grid:#e4e2dc;--accent:#2f6fde;--rev:#a9a7a0;--good:#2e8b57}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--ink:#ecebe7;--quiet:#9b9a95;--grid:#2c2c2a;--accent:#6f9cf0;--rev:#6b6a66;--good:#5cbf86}}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,sans-serif}
main{max-width:760px;margin:0 auto;padding:32px 16px}h1{font-size:22px;margin:0 0 4px}p{color:var(--quiet);margin:0 0 24px}
h2{font-size:15px;font-weight:600;margin:24px 0 8px}svg{width:100%;height:auto}
.grid{stroke:var(--grid)}.tick{fill:var(--quiet);font-size:11.5px}.champ{fill:none;stroke:var(--accent);stroke-width:2}
.kept{fill:var(--accent)}.rev{fill:var(--bg);stroke:var(--rev);stroke-width:1.5}.check{fill:var(--good)}
</style></head><body><main><h1>Ripple teaches itself the task</h1>
<p>Score per generation (share of milestones met, averaged over the runs). Filled dots were kept, hollow dots reverted, green diamonds are pass rates on unseen variants. Ripple's weights never change: only its SKILL.md does.</p>
${tasks.map((t) => chart(t, rows.filter((r) => r.task === t))).join('\n') || '<p>The ledger is empty.</p>'}
</main></body></html>`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? path.resolve(args[i + 1]) : def; };
  const out = opt('--out', path.join(RUNS, 'curve.html'));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, renderCurve(readLedger(opt('--ledger', LEDGER))));
  console.log(`Wrote ${path.relative(process.cwd(), out)}`);
}
