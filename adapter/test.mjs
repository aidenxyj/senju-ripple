// Unit tests for adapter/ and sched/, no network. Run: node adapter/test.mjs
import assert from 'node:assert/strict';
import { makeLlm, toOpenAI, fromOpenAI, parseArgs, llmSettings, llmFromEnv } from './index.js';
import { limit, limitLlm } from '../sched/index.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log(`ok - ${name}`); };

await test('request: system, tool_use/tool_result pairing, images, vendor-specific fields dropped', () => {
  const body = toOpenAI({
    model: 'ignored-by-adapter', max_tokens: 100,
    betas: ['x'], cache_control: { type: 'ephemeral' }, context_management: { edits: [] },
    system: [{ type: 'text', text: 'You are "Alpha".', cache_control: { type: 'ephemeral' } }],
    tools: [{ name: 'echo__shout', description: 'Uppercase', input_schema: { type: 'object', properties: { text: { type: 'string' } } } }, { type: 'web_search_20250305', name: 'web_search' }],
    messages: [
      { role: 'user', content: 'Goal: shout hi' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'secret' }, { type: 'text', text: 'Shouting.' }, { type: 'tool_use', id: 't1', name: 'echo__shout', input: { text: 'hi' } }] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'HI' }, { type: 'image', source: { type: 'base64', data: 'AAAA' } }] },
        { type: 'text', text: 'New on the board' },
      ] },
    ],
  }, { model: 'some-model', minOutputTokens: 1024 });
  assert.equal(body.model, 'some-model');
  assert.equal(body.max_tokens, 1024);
  for (const k of ['betas', 'cache_control', 'context_management', 'system']) assert.ok(!(k in body), k);
  assert.deepEqual(body.messages.map((m) => m.role), ['system', 'user', 'assistant', 'tool', 'user']);
  assert.equal(body.messages[0].content, 'You are "Alpha".');
  assert.equal(body.messages[2].content, 'Shouting.');
  assert.deepEqual(body.messages[2].tool_calls, [{ id: 't1', type: 'function', function: { name: 'echo__shout', arguments: '{"text":"hi"}' } }]);
  assert.equal(body.messages[3].content, 'HI\n[image omitted]');
  assert.ok(!JSON.stringify(body).includes('AAAA'), 'no image bytes sent');
  assert.ok(!JSON.stringify(body).includes('secret'), 'no thinking sent');
  assert.equal(body.tools.length, 1);
  assert.equal(body.tools[0].function.name, 'echo__shout');
});

await test('request: error results are marked, tool_choice maps', () => {
  const body = toOpenAI({ tool_choice: { type: 'any' }, tools: [{ name: 'a', input_schema: { type: 'object' } }], messages: [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'a', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'boom', is_error: true }] },
  ] });
  assert.equal(body.messages[0].content, null);
  assert.equal(body.messages[1].content, 'Error: boom');
  assert.equal(body.tool_choice, 'required');
});

await test('response: text + tool calls, reasoning stripped, usage mapped', () => {
  const out = fromOpenAI({
    choices: [{ finish_reason: 'tool_calls', message: { content: '\nRunning it.', reasoning: 'hidden plan', tool_calls: [{ id: 'c1', function: { name: 'sh', arguments: '{"cmd": "ls"}' } }] } }],
    usage: { prompt_tokens: 100, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 40 } },
  });
  assert.deepEqual(out.content, [{ type: 'text', text: 'Running it.' }, { type: 'tool_use', id: 'c1', name: 'sh', input: { cmd: 'ls' } }]);
  assert.equal(out.stop_reason, 'tool_use');
  assert.deepEqual(out.usage, { input_tokens: 60, output_tokens: 7, cache_read_input_tokens: 40, cache_creation_input_tokens: 0 });
  assert.ok(!JSON.stringify(out).includes('hidden plan'));
});

await test('response: finish reasons, inline <think>, bad JSON args', () => {
  assert.equal(fromOpenAI({ choices: [{ finish_reason: 'length', message: { content: null } }] }).stop_reason, 'max_tokens');
  assert.equal(fromOpenAI({ choices: [{ finish_reason: 'stop', message: { content: 'hi' } }] }).stop_reason, 'end_turn');
  assert.equal(fromOpenAI({ choices: [{ finish_reason: 'stop', message: { tool_calls: [{ id: 'a', function: { name: 'x', arguments: '{}' } }] } }] }).stop_reason, 'tool_use');
  assert.deepEqual(fromOpenAI({ choices: [{ finish_reason: 'stop', message: { content: '<think>plan</think>\nDone.' } }] }).content, [{ type: 'text', text: 'Done.' }]);
  assert.deepEqual(parseArgs('{"cmd": "ls",}'), { _raw: '{"cmd": "ls",}' });
  assert.deepEqual(parseArgs('[1]'), { _raw: '[1]' });
  assert.deepEqual(parseArgs(''), {});
  assert.equal(fromOpenAI({ choices: [] }), null);
});

const fakeFetch = (replies, seen = []) => async (url, init) => {
  seen.push(JSON.parse(init.body));
  const r = replies.shift();
  if (r instanceof Error) throw r;
  if (r.wait) await new Promise((res, rej) => { const t = setTimeout(res, r.wait); init.signal.addEventListener('abort', () => { clearTimeout(t); rej(new Error('aborted')); }); });
  return { ok: r.status === 200, status: r.status, json: async () => r.json };
};
const ok = (content) => ({ status: 200, json: { choices: [{ finish_reason: 'stop', message: { content } }], usage: { prompt_tokens: 3, completion_tokens: 1 } } });
const opts = { baseUrl: 'https://x/api/v1/', apiKey: 'k', model: 'some-model', maxRetries: 3 };

await test('create: provider routing, retries on 429 and network errors', async () => {
  const seen = [];
  const llm = makeLlm({ ...opts, fetch: fakeFetch([{ status: 429, json: { error: { message: 'rate', code: 429 } } }, new Error('ECONNRESET'), ok('hi')], seen) });
  const out = await llm.create({ max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(out.content[0].text, 'hi');
  assert.equal(seen.length, 3);
  assert.equal(seen[0].provider, undefined);   // a single vLLM server: no provider routing by default
  const routed = [];
  await makeLlm({ ...opts, provider: { only: ['x'] }, fetch: fakeFetch([ok('hi')], routed) }).create({ max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
  assert.deepEqual(routed[0].provider, { only: ['x'] });
});

await test('create: context errors become model_context_window_exceeded; other 400s throw with status', async () => {
  const llm = makeLlm({ ...opts, fetch: fakeFetch([
    { status: 400, json: { error: { code: 400, message: "This endpoint's maximum context length is 1048576 tokens." } } },
    { status: 400, json: { error: { code: 400, message: 'bad tool schema' } } },
  ]) });
  assert.equal((await llm.create({ messages: [] })).stop_reason, 'model_context_window_exceeded');
  await assert.rejects(llm.create({ messages: [] }), (e) => e.status === 400 && /bad tool schema/.test(e.message));
  const small = makeLlm({ ...opts, maxContext: 100, fetch: () => assert.fail('should not call') });
  assert.equal((await small.create({ max_tokens: 10, messages: [{ role: 'user', content: 'x'.repeat(1000) }] })).stop_reason, 'model_context_window_exceeded');
});

await test('create: rejects when the signal aborts mid-call', async () => {
  const llm = makeLlm({ ...opts, fetch: fakeFetch([{ status: 200, wait: 5000, json: {} }]) });
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 20);
  const t0 = Date.now();
  await assert.rejects(llm.create({ messages: [] }, { signal: ac.signal }), /abort/i);
  assert.ok(Date.now() - t0 < 1000);
});

await test('vision: images pass through as image_url parts after the tool message', () => {
  const body = toOpenAI({ messages: [
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'snap', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'shot' }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } }] }] },
  ] }, { model: 'm', vision: true });
  assert.deepEqual(body.messages.map((m) => m.role), ['assistant', 'tool', 'user']);
  assert.equal(body.messages[1].content, 'shot\n[image omitted]');
  assert.deepEqual(body.messages[2].content, [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } }]);
});

await test('create: no key means no authorization header; max_tokens refusal switches to max_completion_tokens', async () => {
  const seen = [], heads = [];
  const replies = [{ status: 400, json: { error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." } } }, ok('a'), ok('b')];
  const fetch = async (url, init) => { heads.push(init.headers); seen.push(JSON.parse(init.body)); const r = replies.shift(); return { ok: r.status === 200, status: r.status, json: async () => r.json }; };
  const llm = makeLlm({ baseUrl: 'http://localhost:8000/v1', model: 'm', fetch });
  await llm.create({ max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
  await llm.create({ max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
  assert.ok(!('authorization' in heads[0]));
  assert.ok('max_tokens' in seen[0]);
  assert.equal(seen[1].max_completion_tokens, 1024);
  assert.ok(!('max_tokens' in seen[1]) && !('max_tokens' in seen[2]), 'remembered after the first refusal');
});

await test('settings: LLM_* from env, clear error when missing', () => {
  assert.deepEqual(llmSettings({ LLM_BASE_URL: 'u', LLM_MODEL: 'm', LLM_MAX_CONTEXT: '8000', LLM_VISION: '1' }), { baseUrl: 'u', apiKey: '', model: 'm', maxContext: 8000, vision: true });
  assert.equal(llmSettings({ LLM_BASE_URL: 'u', LLM_MODEL: 'm' }).maxContext, Infinity);
  assert.throws(() => llmFromEnv({ LLM_BASE_URL: 'u' }), /LLM_MODEL/);
});

await test('sched: at most n at once, order kept, errors propagate', async () => {
  const run = limit(2);
  let active = 0, peak = 0;
  const order = [];
  const job = (i) => run(async () => { active++; peak = Math.max(peak, active); await sleep(20); active--; order.push(i); if (i === 3) throw new Error('x'); return i; });
  const res = await Promise.allSettled([0, 1, 2, 3, 4].map(job));
  assert.equal(peak, 2);
  assert.deepEqual(res.map((r) => r.status), ['fulfilled', 'fulfilled', 'fulfilled', 'rejected', 'fulfilled']);
  assert.equal(run.active, 0);
  const calls = [];
  const llm = limitLlm({ create: async (p) => { calls.push(p); return 'ok'; } }, 1);
  const ac = new AbortController(); ac.abort();
  await assert.rejects(llm.create({ a: 1 }, { signal: ac.signal }), /abort/);
  assert.equal(await llm.create({ a: 2 }), 'ok');
  assert.deepEqual(calls, [{ a: 2 }]);
});

console.log(`\n${n} passed`);
