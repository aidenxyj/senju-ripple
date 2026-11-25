// How fast is an LLM endpoint for Senju's kind of call? Times a realistic worker turn (system prompt, a page
// snapshot, the sh tool; the model answers with one tool call), one at a time and then 4 at once like 4 bots.
//   node --env-file=.env        tools/modal/bench.mjs        # whatever endpoint .env points at
//   node --env-file=.env.modal  tools/modal/bench.mjs        # the Modal endpoint
// A cold Modal endpoint takes minutes to start: the first call is reported separately and not counted.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { llmFromEnv, llmSettings } = await import(`${ROOT}/adapter/index.js`);
const llm = llmFromEnv();
const N = Number(process.env.BENCH_N ?? 6);

const snapshot = Array.from({ length: 60 }, (_, i) => `e${i + 1} ${['button', 'link', 'textbox', 'text'][i % 4]} "${['Host a room', 'Rules, tips & FAQ', 'Your answer', 'Category 2: Name a type of tree', 'Senju BOT B IS UP'][i % 5]} ${i}"`).join('\n');
const params = () => ({
  model: llmSettings().model,
  max_tokens: 1024,
  system: [{ type: 'text', text: 'You are "Senju BOT A", a worker in a swarm. You act on a web page only through the sh tool, which runs senju commands (senju look, senju click <id>, senju type <id> "text" [--submit], senju wait 2s). Answer with one sh call.\n'.repeat(6) }],
  tools: [{ name: 'browser__sh', description: 'Run senju commands, one per line.', input_schema: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] } }],
  messages: [
    { role: 'user', content: 'Play Puffer Party. When the page says YOUR PUFFER, type one answer that fits the category into "Your answer" with --submit.' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'browser__sh', input: { cmd: 'senju look' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: `ok\npage: Puffer Party\n-- elements\n${snapshot}\n-- text\nCATEGORY 2 41s\nName a type of tree\n▸ YOUR PUFFER · TYPE AN ANSWER\nUsed: Oak, Maple, Birch` }] },
  ],
});

async function once() {
  const t = Date.now();
  const res = await llm.create(params(), {});
  const call = res.content.find((b) => b.type === 'tool_use');
  return { ms: Date.now() - t, inTok: res.usage?.input_tokens ?? 0, outTok: res.usage?.output_tokens ?? 0, cmd: call?.input?.cmd ?? '(no tool call)' };
}
const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];

console.log(`endpoint: ${llmSettings().baseUrl?.replace(/\/\/([^/]+).*/, '//$1')}  model: ${llmSettings().model}`);
const warm = await once();
console.log(`first call (includes any cold start): ${warm.ms} ms, ${warm.inTok} tokens in, ${warm.outTok} out -> ${warm.cmd.slice(0, 60)}`);
const seq = [];
for (let i = 0; i < N; i++) seq.push(await once());
console.log(`one at a time x${N}: median ${median(seq.map((r) => r.ms))} ms, min ${Math.min(...seq.map((r) => r.ms))}, max ${Math.max(...seq.map((r) => r.ms))}`);
const t = Date.now();
const par = await Promise.all(Array.from({ length: 4 }, once));
console.log(`4 at once (like 4 bots): median ${median(par.map((r) => r.ms))} ms each, ${Date.now() - t} ms for all four`);
console.log(`sample answer: ${par[0].cmd.slice(0, 80)}`);
