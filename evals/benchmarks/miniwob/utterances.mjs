// Regenerates utterances.json: the instruction each MiniWoB++ task shows for DEFAULT_SEED, so task goals can quote it.
// Seeded episodes are deterministic, so this only needs to run again after changing the seed or the vendored pages.
//   node evals/benchmarks/miniwob/utterances.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectServer, resolveSpec } from '../../../prototype/src/mcp.js';
import { serveMiniwob } from './serve.mjs';
import { DEFAULT_SEED } from './task.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TASKS = fs.readdirSync(path.join(HERE, 'html/miniwob')).filter((f) => f.endsWith('.html')).map((f) => f.slice(0, -5)).sort();
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'miniwob-utter-'));
const conn = await connectServer('browser', resolveSpec({ command: 'bundled', args: ['node_modules/@playwright/mcp/cli.js', '--isolated', '--headless', '--output-dir', path.join(work, 'pw')] }, work));
const out = {};
try {
  for (const task of TASKS) {
    const seen = [];
    for (let run = 0; run < 2; run++) {   // twice, to prove the seed makes it deterministic
      const site = await serveMiniwob({ task, seed: DEFAULT_SEED, maxSeconds: 60 });
      await conn.client.callTool({ name: 'browser_navigate', arguments: { url: site.url } });
      for (let i = 0; i < 50 && site.started.length === 0; i++) await new Promise((r) => setTimeout(r, 100));
      seen.push(site.started[0]?.utterance ?? null);
      await site.close();
    }
    if (!seen[0] || seen[0] !== seen[1]) throw new Error(`${task}: utterance is not stable for seed ${DEFAULT_SEED}: ${JSON.stringify(seen)}`);
    out[task] = { [DEFAULT_SEED]: seen[0] };
    console.log(`${task}: ${seen[0]}`);
  }
} finally {
  await conn.close();
  fs.rmSync(work, { recursive: true, force: true });
}
fs.writeFileSync(path.join(HERE, 'utterances.json'), JSON.stringify(out, null, 2) + '\n');
