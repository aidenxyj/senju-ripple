// An OpenAI-style endpoint has no server-side context management: the swarm must trim history itself,
// and a full context window must shrink the history instead of looping.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Swarm } from '../src/orchestrator.js';
import { makeLlm } from '../src/llm.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const echo = { command: process.execPath, args: [path.join(here, 'echo-server.mjs')], app: 'Finder' };
const config = { model: 'fake', maxAgents: 2, maxSteps: 12, servers: { echo }, context: { enabled: true } };

let uid = 0;
const use = (name, input = {}) => ({ type: 'tool_use', id: `t${++uid}`, name, input });
const say = (text) => ({ type: 'text', text });
const reply = (content, stop_reason = 'end_turn') => ({ content: Array.isArray(content) ? content : [content], stop_reason, usage: { input_tokens: 10, output_tokens: 5 } });
const FULL = { content: [], stop_reason: 'model_context_window_exceeded', usage: { input_tokens: 0, output_tokens: 0 } };
const isLead = (params) => params.tools?.[0]?.name === 'spawn_agent';
const resultTexts = (messages) => messages.flatMap((m) => Array.isArray(m.content) ? m.content : [])
  .filter((b) => b.type === 'tool_result').map((b) => (b.content ?? []).map((c) => c.text ?? '').join(''));

// 1. The model client says it has no server-side context management.
assert.equal(makeLlm('test-key', { LLM_BASE_URL: 'http://127.0.0.1:1/v1', LLM_MODEL: 'test-model' }).serverContext, false);

// 2. Workers on such a client send no server-side context fields and trim old tool results themselves.
{
  const LONG = 'x'.repeat(3000);
  const requests = [];
  let shouts = 0;
  const llm = {
    serverContext: false,
    async create(params) {
      requests.push(structuredClone(params));
      if (isLead(params)) {
        if (requests.filter(isLead).length === 1) return reply(use('spawn_agent', { name: 'Alpha', goal: 'shout a lot', servers: ['echo'] }));
        return /No workers are running|finished/.test(JSON.stringify(params.messages.at(-1))) ? reply(say('done')) : reply(use('wait'));
      }
      return shouts++ < 7 ? reply(use('echo__shout', { text: LONG })) : reply(say('shouted'));
    },
  };
  const swarm = new Swarm({ llm, config, workspace: '/tmp', emit: () => {} });
  await swarm.run('shout');
  await swarm.shutdown();
  for (const p of requests) {
    for (const k of ['betas', 'context_management', 'cache_control']) assert.ok(!(k in p), `request carried ${k}`);
  }
  const last = requests.filter((p) => !isLead(p)).at(-1);
  const texts = resultTexts(last.messages);
  assert.ok(texts.length >= 7, `expected the worker's tool results, got ${texts.length}`);
  assert.ok(texts.slice(0, -4).every((t) => t.length < 1000), 'older tool results were not trimmed');
  assert.ok(texts.slice(-4).every((t) => t.length >= 3000), 'the latest tool results must stay whole');
}

// 3. A full context window in the lead shrinks its history once and carries on.
{
  let calls = 0;
  const llm = { serverContext: false, async create() { calls++; return calls === 1 ? FULL : reply(say('all good')); } };
  const events = [];
  const swarm = new Swarm({ llm, config, workspace: '/tmp', emit: (e) => events.push(e) });
  await swarm.run('anything');
  await swarm.shutdown();
  assert.equal(calls, 2);
  assert.equal(events.find((e) => e.type === 'done')?.summary, 'all good');
}

// 4. A lead whose window stays full stops after one shrink, instead of looping hundreds of times.
{
  let calls = 0;
  const llm = { serverContext: false, async create() { calls++; return FULL; } };
  const swarm = new Swarm({ llm, config, workspace: '/tmp', emit: () => {} });
  await swarm.run('anything').catch(() => {});
  await swarm.shutdown();
  assert.equal(calls, 2, `lead made ${calls} calls on a full context window`);
}

console.log('client context test passed');
