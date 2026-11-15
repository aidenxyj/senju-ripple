// Builds an eval task from one MiniWoB++ page. Each evals/tasks/benchmarks/miniwob-<name>.js is one line:
//   export default miniwobTask('click-button');
//
// - setup() serves the page for one episode with a fixed seed (ctx.seed overrides it), see serve.mjs.
// - The goal quotes the page's instruction for the default seed (utterances.json, made by utterances.mjs).
//   For any other seed it tells the agent to read the instruction at the top of the page.
// - check() passes when the first finished episode has a raw reward above 0, as BrowserGym scores MiniWoB.
//   The first one counts: reloading the page after a wrong click does not give a second try.
// - stub: open the page, then run solver.mjs in it through browser_evaluate.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveMiniwob } from './serve.mjs';
import { solveMiniwob } from './solver.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_SEED = 42;
const UTTERANCES = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(HERE, 'utterances.json'), 'utf8')); } catch { return {}; }
})();

export function miniwobTask(name, { timeout = 240, maxSteps = 40 } = {}) {
  return {
    id: `miniwob-${name}`,
    servers: ['browser'],
    timeout,
    maxSteps,
    goal(ctx) {
      const said = ctx.seed === undefined || ctx.seed === DEFAULT_SEED ? UTTERANCES[name]?.[String(DEFAULT_SEED)] : null;
      const what = said ? `It asks: "${said}"` : 'Its instruction is shown at the top of the page.';
      return `Open ${ctx.url} in the browser. It is a small web task (MiniWoB++ "${name}"). ${what} ` +
        'Do exactly that on the page. You get one try: the first time the task ends (a correct or a wrong final click) is what counts, ' +
        'and reloading the page does not reset it.';
    },
    async setup(ctx) {
      ctx.site = await serveMiniwob({ task: name, seed: ctx.seed ?? DEFAULT_SEED, maxSeconds: timeout });
      ctx.url = ctx.site.url;
    },
    async check(ctx) {
      const site = ctx.site;
      if (!site) return { pass: false, detail: 'the page was never served' };
      for (let i = 0; i < 20 && site.reports.length === 0 && site.started.length > 0; i++) await new Promise((r) => setTimeout(r, 100));
      if (site.started.length === 0) return { pass: false, detail: 'the page was never opened' };
      const first = site.reports[0];
      if (!first) return { pass: false, detail: `the task was opened ${site.started.length === 1 ? 'once' : `${site.started.length} times`} but never finished` };
      const tail = site.reports.length > 1 ? ` (${site.reports.length} episodes; the first counts)` : '';
      if (first.raw > 0) return { pass: true, detail: `reward ${first.raw}${tail}` };
      return { pass: false, detail: `reward ${first.raw}${first.reason ? `, ${first.reason}` : ''}${tail}` };
    },
    async teardown(ctx) { await ctx.site?.close(); },
    stub: [
      ({ ctx }) => ({ name: 'browser__browser_navigate', input: { url: ctx.url } }),
      { name: 'browser__browser_evaluate', input: { function: `async () => (${solveMiniwob.toString()})(${JSON.stringify(name)})` } },
    ],
  };
}
