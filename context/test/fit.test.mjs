import test from 'node:test';
import assert from 'node:assert/strict';
import { fit, fitReport, fitAsync, countTokens, countMessages, checkMessages, truncateText, TRIMMED, SUMMARY_TAG } from '../index.js';
import { workerTranscript, SYSTEM, pageDump, rng } from './transcripts.mjs';

const ids = (messages, type) => messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === type).map((b) => (type === 'tool_use' ? b.id : b.tool_use_id));
const goalText = (m) => (typeof m.content === 'string' ? m.content : m.content[0].text);

/** Every invariant fit promises, for one input and its output. */
function assertInvariants(input, output, { maxTokens, system }) {
  const used = countMessages(output, { system });
  assert.ok(used <= maxTokens, `over budget: ${used} > ${maxTokens}`);
  assert.deepEqual(checkMessages(output), [], 'invalid message list');
  // Goal kept, word for word, as the first block of the first message.
  assert.equal(output[0].role, 'user');
  assert.equal(goalText(output[0]), goalText(input[0]));
  // Newest message kept unchanged (when it fits on its own).
  assert.deepEqual(output.at(-1), input.at(-1));
  // Every surviving tool_result still has its tool_use.
  const uses = new Set(ids(output, 'tool_use'));
  for (const r of ids(output, 'tool_result')) assert.ok(uses.has(r), `orphan tool_result ${r}`);
}

const SAMPLES = {
  snapshot: '- generic [ref=e2]:\n  - heading "Signup" [level=1] [ref=e3]\n  - textbox "Email" [ref=e4]: a@b.c\n  - checkbox "Agree to terms" [checked] [ref=e5]\n  - combobox "Plan" [ref=e6]:\n    - option "Free" [selected]\n    - option "Pro"\n  - button "Submit" [ref=e7]\n  - link "Link A" [ref=e8] [cursor=pointer]:\n    - /url: "#a"\n'.repeat(10),
  prices: Array.from({ length: 60 }, (_, i) => 'row ' + i + ': SKU-' + (10000 + i * 37) + ' $' + (i * 13.37).toFixed(2) + ' qty ' + i * 7 + ' 2026-11-' + String(1 + (i % 28)).padStart(2, '0')).join('\n'),
  prose: 'The lead agent plans the goal, spawns workers, and waits for their reports. Each worker drives one browser window through the senju shell and reads the screen as text. '.repeat(12),
  json: JSON.stringify(Array.from({ length: 40 }, (_, i) => ({ id: 'call_' + i, cmd: 'senju click e' + i, ok: i % 3 !== 0 }))),
};
// Real usage.prompt_tokens from a hosted Ripple endpoint, 2026-11-14.
const REAL = { snapshot: 1189, prices: 1378, prose: 408, json: 721 };

test('countTokens errs high against Ripple\'s real counts, but not wildly', () => {
  for (const [k, real] of Object.entries(REAL)) {
    const est = countTokens(SAMPLES[k]);
    assert.ok(est >= real, `${k}: estimate ${est} is below real ${real}`);
    assert.ok(est <= real * 1.4, `${k}: estimate ${est} is more than 1.4x real ${real}`);
  }
});

test('countTokens basics', () => {
  assert.equal(countTokens(''), 0);
  assert.equal(countTokens(null), 0);
  assert.ok(countTokens('abcdefg') >= 1);
  assert.ok(countTokens('価格') >= 2);
  assert.ok(countTokens({ cmd: 'senju look' }) > 0);
  assert.ok(countTokens('x'.repeat(3500)) >= 700, 'long runs without spaces still count');
  assert.ok(countTokens('a'.repeat(100)) <= countTokens('a'.repeat(101)));
  assert.ok(countTokens('1234567890') > countTokens('abcdefghij'), 'digits cost more than letters');
});

test('countMessages counts system, tools and every block type', () => {
  const msgs = workerTranscript({ steps: 3, obsChars: 500 });
  const bare = countMessages(msgs);
  assert.ok(bare > 0);
  assert.ok(countMessages(msgs, { system: SYSTEM }) > bare + countTokens(SYSTEM) - 1);
  assert.ok(countMessages(msgs, { system: [{ type: 'text', text: SYSTEM }], tools: [{ name: 'sh', description: 'run', input_schema: {} }] }) > countMessages(msgs, { system: SYSTEM }));
});

test('under budget: returns equivalent messages and does not mutate', () => {
  const input = workerTranscript({ steps: 4, obsChars: 800 });
  const snapshot = structuredClone(input);
  const out = fit(input, { maxTokens: 32000 });
  assert.notEqual(out, input);
  assert.deepEqual(out, input);
  assert.deepEqual(input, snapshot);
});

test('empty and single-message inputs', () => {
  assert.deepEqual(fit([], { maxTokens: 100 }), []);
  const one = [{ role: 'user', content: 'Begin your subtask now.' }];
  assert.deepEqual(fit(one, { maxTokens: 16000 }), one);
});

test('rejects a missing budget', () => {
  assert.throws(() => fit([], {}), TypeError);
  assert.throws(() => fit(null, { maxTokens: 10 }), TypeError);
});

for (const maxTokens of [16000, 32000]) {
  for (const steps of [10, 40, 150, 500]) {
    for (const endWith of ['tool_result', 'assistant', 'user']) {
      test(`worker transcript, ${steps} steps ending in ${endWith}, fits ${maxTokens}`, () => {
        const input = workerTranscript({ steps, endWith, seed: steps });
        const snapshot = structuredClone(input);
        const opts = { maxTokens, system: SYSTEM };
        const out = fit(input, opts);
        assert.deepEqual(input, snapshot, 'input mutated');
        assertInvariants(input, out, opts);
        // The newest turn is whole: the last tool_result's tool_use is kept too.
        if (endWith === 'tool_result') assert.deepEqual(out.at(-2), input.at(-2));
        // Idempotent once it fits.
        assert.deepEqual(fit(out, opts), out);
      });
    }
  }
}

test('trims old observations before summarising, keeping the newest ones whole', () => {
  const input = workerTranscript({ steps: 12, obsChars: 4000, seed: 3 });
  const full = countMessages(input);
  const r = fitReport(input, { maxTokens: Math.floor(full * 0.7) });
  assert.ok(r.fits);
  assert.ok(r.trimmed > 0);
  assert.equal(r.summarized, 0);
  const results = r.messages.filter((m) => Array.isArray(m.content)).flatMap((m) => m.content).filter((b) => b.type === 'tool_result');
  const trimmed = results.map((b) => JSON.stringify(b.content).includes(TRIMMED));
  // Oldest first: the first result is trimmed, the newest four are whole.
  assert.equal(trimmed[0], true);
  assert.deepEqual(trimmed.slice(-4), [false, false, false, false]);
  // The placeholder keeps the first line (ok / error) and is_error.
  const placeholder = results.find((b) => JSON.stringify(b.content).includes(TRIMMED));
  assert.match(placeholder.content[0].text, /^\[old observation trimmed\] (ok|error)/);
  // Trimmed results lose their images too.
  for (const b of results.filter((x) => JSON.stringify(x.content).includes(TRIMMED))) assert.ok(!JSON.stringify(b.content).includes('"type":"image"'));
});

test('summarises the oldest turns into the goal message when trimming is not enough', () => {
  const input = workerTranscript({ steps: 400, seed: 9 });
  const r = fitReport(input, { maxTokens: 16000, system: SYSTEM });
  assert.ok(r.fits);
  assert.ok(r.summarized > 0);
  const summary = r.messages[0].content.find((b) => b.type === 'text' && b.text.startsWith(SUMMARY_TAG));
  assert.ok(summary, 'summary block in the goal message');
  assert.match(summary.text, /- sh senju (look|click e\d+) -> (ok|error)/);
  assert.equal(r.messages[0].content[0].text, 'Begin your subtask now.');
  assert.equal(r.messages[1].role, 'assistant');
});

test('lead instructions in the summarised range reach the summary', () => {
  const input = workerTranscript({ steps: 400, seed: 4 });
  const out = fit(input, { maxTokens: 16000 });
  const summary = out[0].content.find((b) => b.text?.startsWith(SUMMARY_TAG)).text;
  assert.match(summary, /user: Message from the lead/);
});

test('re-fitting a fitted transcript after more steps carries the old summary forward', () => {
  const opts = { maxTokens: 16000, system: SYSTEM };
  let history = fit(workerTranscript({ steps: 300, seed: 5 }), opts);
  const more = workerTranscript({ steps: 380, seed: 5 }).slice(-80 * 2);
  // Re-label ids so they do not clash, and append as new steps.
  const extra = structuredClone(more).map((m) => ({ ...m, content: Array.isArray(m.content) ? m.content.map((b) => (b.id ? { ...b, id: `x${b.id}` } : b.tool_use_id ? { ...b, tool_use_id: `x${b.tool_use_id}` } : b)) : m.content }));
  const start = extra.findIndex((m) => m.role === 'assistant');
  history = [...history, ...extra.slice(start)];
  if (history.at(-1).role === 'assistant') history.pop();
  assert.deepEqual(checkMessages(history), []);
  const out = fit(history, opts);
  assertInvariants(history, out, opts);
  const summaries = out[0].content.filter((b) => b.text?.startsWith(SUMMARY_TAG));
  assert.equal(summaries.length, 1, 'one summary block, not nested ones');
});

test('newest observation bigger than the whole budget is truncated, not thrown', () => {
  const rand = rng(2);
  const input = workerTranscript({ steps: 6, obsChars: 2000, seed: 2 });
  const last = input.at(-1);
  input[input.length - 1] = { role: 'user', content: [{ type: 'tool_result', tool_use_id: last.content[0].tool_use_id, content: [{ type: 'text', text: pageDump(rand, 200000) }] }] };
  const opts = { maxTokens: 16000, system: SYSTEM };
  const r = fitReport(input, opts);
  assert.ok(r.fits, `${r.tokens} > 16000`);
  assert.ok(r.truncated > 0);
  assert.deepEqual(checkMessages(r.messages), []);
  assert.equal(goalText(r.messages[0]), 'Begin your subtask now.');
  const text = r.messages.at(-1).content[0].content[0].text;
  assert.ok(text.startsWith('ok\npage:'), 'head of the observation kept');
  assert.match(text, /chars trimmed to fit the context/);
});

test('a huge goal is truncated last and keeps its start', () => {
  const goal = `Goal: ${'compare kettles. '.repeat(20000)}`;
  const input = [{ role: 'user', content: goal }];
  const out = fit(input, { maxTokens: 2000 });
  assert.ok(countMessages(out) <= 2000);
  assert.ok(out[0].content.startsWith('Goal: compare kettles.'));
});

test('a system prompt larger than the budget: best effort, reports it does not fit', () => {
  const r = fitReport(workerTranscript({ steps: 3 }), { maxTokens: 500, system: 'x'.repeat(10000) });
  assert.equal(r.fits, false);
  assert.deepEqual(checkMessages(r.messages), []);
});

test('fitAsync uses an injected summarizer and falls back on failure', async () => {
  const input = workerTranscript({ steps: 400, seed: 8 });
  const opts = { maxTokens: 16000, system: SYSTEM };
  let seen = '';
  const out = await fitAsync(input, { ...opts, summarize: async (t) => { seen = t; return 'Prices so far: kettle 12, mug 4.'; } });
  assert.match(seen, /senju (look|click)/);
  const summary = out[0].content.find((b) => b.text?.startsWith(SUMMARY_TAG)).text;
  assert.match(summary, /Prices so far: kettle 12, mug 4\./);
  assertInvariants(input, out, opts);
  const fallback = await fitAsync(input, { ...opts, summarize: async () => { throw new Error('model down'); } });
  assert.deepEqual(fallback, fit(input, opts));
});

test('truncateText keeps head and tail within the budget', () => {
  const s = `HEAD${'m'.repeat(10000)}TAIL`;
  const t = truncateText(s, 100);
  assert.ok(countTokens(t) <= 100);
  assert.ok(t.startsWith('HEAD') && t.endsWith('TAIL'));
  assert.equal(truncateText('short', 100), 'short');
});

test('checkMessages catches split pairs and bad alternation', () => {
  const ok = workerTranscript({ steps: 3 });
  assert.deepEqual(checkMessages(ok), []);
  assert.ok(checkMessages([ok[0], ok[2]]).length > 0);
  assert.ok(checkMessages([ok[0], ok[1], ok[3]]).length > 0);
});
