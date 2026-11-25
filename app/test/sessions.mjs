// Persistent sessions: the lead's conversation is saved and resumed, every step is an event,
// personal sessions and memory live in files, and team history is filtered per person.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { Swarm, snapshotMessages, stepLabel } from '../src/orchestrator.js';
import { SessionStore } from '../src/sessions.js';
import { LocalMemory } from '../src/memory.js';
import { Hub } from '../server/hub.js';
import { MemoryStore } from '../server/store-memory.js';
import { handleApi } from '../server/api.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let uid = 0;
const use = (name, input = {}) => ({ type: 'tool_use', id: `t${++uid}`, name, input });
const say = (text) => ({ type: 'text', text });
const textOf = (m) => typeof m.content === 'string' ? m.content : m.content.map((b) => b.text ?? (b.content ?? []).map((c) => c.text ?? '').join('')).join('\n');
const until = async (pred, label, ms = 6000) => { const t0 = Date.now(); for (;;) { const v = pred(); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${label}`); await sleep(10); } };

function llmFor(lead) {
  return {
    async create(params, { signal } = {}) {
      await sleep(5);
      if (signal?.aborted) throw new Error('aborted');
      const isLead = params.tools?.[0]?.name === 'spawn_agent';
      const out = isLead ? await lead(params, signal) : say('worker done');
      return { content: Array.isArray(out) ? out : [out], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } };
    },
  };
}
const config = { model: 'fake', maxAgents: 2, maxSteps: 4, servers: {} };

// 1. The lead's conversation is saved after a job and resumed by the next, with the new message at the end.
{
  const seen = [];
  const events = [];
  const swarm = new Swarm({
    llm: llmFor((params) => { seen.push(JSON.parse(JSON.stringify(params.messages))); return say(seen.length === 1 ? 'Opened example.com. Its title is Example Domain.' : 'Followed the link.'); }),
    config, workspace: '/tmp', emit: (e) => events.push(e),
  });
  await swarm.run('open example.com and tell me its title');
  const saved = swarm.leadSnapshot;
  assert.equal(saved.at(-1).role, 'assistant');
  assert.match(textOf(saved[0]), /Goal: open example\.com/);
  // The step trace has the lead's reply.
  assert.ok(events.some((e) => e.type === 'step' && e.agentId === 'lead' && e.kind === 'say' && /Example Domain/.test(e.text)));

  await swarm.run('now open its More information link', { resume: { messages: saved, by: 'James' } });
  const first = seen[1];
  assert.equal(first.length, 3);   // the old goal, the old answer, and the new message
  assert.match(textOf(first[0]), /Goal: open example\.com/);
  assert.match(textOf(first[1]), /Example Domain/);
  assert.match(textOf(first[2]), /comes back to this session|come back to this session/);
  assert.match(textOf(first[2]), /New message from the user \(James\): now open its More information link/);
  // The saved conversation was not changed by the resumed run (it was copied).
  assert.equal(saved.length, 2);
  assert.equal(swarm.leadSnapshot.length, 4);
  await swarm.shutdown();
}

// 2. A job stopped mid-call is still saved in a form the model accepts: every tool call gets a result.
{
  let asked = false;
  const swarm = new Swarm({ llm: llmFor(() => { asked = true; return use('ask_user', { question: 'Which account?' }); }), config, workspace: '/tmp', emit: () => {} });
  const running = swarm.run('send the report');
  await until(() => asked && swarm.pending.size, 'the question');
  swarm.cancel();
  await running;
  const last = swarm.leadSnapshot.at(-1);
  assert.equal(last.role, 'user');
  assert.equal(last.content[0].type, 'tool_result');
  assert.match(last.content[0].content[0].text, /Not run: the job ended/);
  await swarm.shutdown();
}

// 3. Snapshots drop images and labels describe steps briefly.
{
  const snap = snapshotMessages([{ role: 'user', content: [{ type: 'image', source: {} }, { type: 'text', text: 'hi' }] }, { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'wait', input: {} }] }]);
  assert.deepEqual(snap[0].content, [{ type: 'text', text: 'hi' }]);
  assert.equal(snap.at(-1).content[0].tool_use_id, 'x');
  assert.equal(stepLabel('browser__browser_navigate', { url: 'https://example.com' }), 'https://example.com');
  assert.equal(stepLabel('desktop__press_key', { key: 'Return' }), 'Return');
  assert.equal(stepLabel('browser__browser_type', { element: 'Search', text: 'cats' }), 'Search ← "cats"');
}

// 4. Personal sessions and memory are files on this Mac.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'senju-sessions-'));
  const store = new SessionStore(path.join(dir, 'sessions'));
  const meta = store.create('open example.com');
  assert.equal(store.startTurn(meta.id, 'open example.com'), 0);
  assert.equal(store.appendEvent(meta.id, 0, { type: 'step', agentId: 'lead', kind: 'say', text: 'hi' }), true);
  assert.equal(store.appendEvent(meta.id, 0, { type: 'point', agentId: 'a1' }), false);   // cursor motion is not kept
  store.saveLead(meta.id, [{ role: 'user', content: 'Goal: open example.com' }, { role: 'assistant', content: [{ type: 'text', text: 'done' }] }]);
  store.finishTurn(meta.id, { status: 'done', summary: 'done' });
  assert.equal(store.startTurn(meta.id, 'again'), 1);
  // The app quit mid-turn: on the next launch the turn is marked as stopped.
  store.recover();
  const back = store.get(meta.id);
  assert.deepEqual(back.turns.map((t) => t.status), ['done', 'stopped']);
  assert.equal(store.list()[0].id, meta.id);
  assert.equal(store.events(meta.id).length, 1);
  assert.equal(store.lead(meta.id).length, 2);
  store.rename(meta.id, 'Example');
  assert.equal(store.get(meta.id).title, 'Example');
  assert.throws(() => store.get('../../etc'), /Not a session id/);
  store.remove(meta.id);
  assert.equal(store.list().length, 0);

  const memory = new LocalMemory(path.join(dir, 'memory.json'));
  const row = memory.add('Prefers dark mode.');
  assert.match(await memory.notes(), /- Prefers dark mode\./);
  assert.match(await memory.remember({ scope: 'person', person: 'user', note: 'Writes in British English.' }), /Remembered/);
  assert.equal(memory.list().length, 2);
  memory.remove(row.id);
  assert.deepEqual(memory.list().map((r) => r.note), ['Writes in British English.']);
  // The swarm offers the remember tool once it has memory.
  let tools = null;
  const swarm = new Swarm({ llm: llmFor((params) => { tools = params.tools.map((t) => t.name); return say('ok'); }), config, workspace: '/tmp', emit: () => {}, memory });
  await swarm.run('hi');
  assert.ok(tools.includes('remember'));
  await swarm.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
}

// 5. Team: history is saved per turn, can be continued, and is filtered per person over the API.
{
  const store = new MemoryStore();
  store.addTeam('t1', 'Robotics');
  const tokens = { james: store.addUser('james', 'James', 't1'), linda: store.addUser('linda', 'Linda', 't1'), mona: store.addUser('mona', 'Mona', 't1') };
  await store.setModel('james', { baseUrl: 'http://127.0.0.1:1/v1', model: 'fake', apiKey: 'sk-james' });
  await store.setModel('linda', { baseUrl: 'http://127.0.0.1:1/v1', model: 'fake', apiKey: 'sk-linda' });
  const leadSaw = [];
  const keys = [];
  const makeLlm = (settings) => ({
    model: settings.model,
    async create(params) {
      await sleep(5);
      keys.push(settings.apiKey);
      const isLead = params.tools?.[0]?.name === 'spawn_agent';
      if (!isLead) return { content: [say('typed it')], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };
      leadSaw.push(params.messages.map(textOf).join('\n---\n'));
      const n = leadSaw.length;
      const content = n === 1 ? [use('remember', { scope: 'person', person: 'James', note: 'James likes short summaries.' })]
        : n === 2 ? [say('Noted. All done for now.')]
        : [say('Picked up where we left off.')];
      return { content, stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };
    },
  });
  const server = http.createServer();
  const hub = new Hub({ store, makeLlm, config: { model: 'fake', maxAgents: 2, maxSteps: 4 } }).listen(server);
  await new Promise((r) => server.listen(0, r));
  const connect = async (who, role = 'device') => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
    const c = { got: [], say: (m) => ws.send(JSON.stringify(m)), ws };
    ws.on('message', (d) => c.got.push(JSON.parse(d)));
    await new Promise((r) => ws.on('open', r));
    c.say({ t: 'hello', token: tokens[who], role, ...(role === 'device' ? { device: { id: `d-${who}`, name: `${who} Mac` }, servers: {} } : {}) });
    await until(() => c.got.find((m) => m.t === 'welcome'), `${who} welcome`);
    return c;
  };
  const james = await connect('james');
  const lindaWeb = await connect('linda', 'web');

  // Turn 1, from James's computer.
  james.say({ t: 'start', goal: 'tidy the notes' });
  await until(() => [...store.sessions.values()][0]?.turns?.[0]?.status === 'done', 'first turn saved');
  const id = [...store.sessions.keys()][0];
  await sleep(50);
  assert.equal(store.leadCtx.get(id).at(-1).role, 'assistant');
  const saved = await store.listEvents(id);
  assert.ok(saved.some((r) => r.event.type === 'step' && r.event.kind === 'say'));
  // Tool results never reach the history, and a personal note is stored for its person only.
  assert.ok(saved.every((r) => r.event.type !== 'step' || !('result' in r.event)));
  assert.ok(saved.filter((r) => r.event.type === 'step' && r.event.tool === 'remember').every((r) => r.event.label === ''));
  assert.deepEqual(saved.find((r) => r.event.type === 'remembered').audience, { userId: 'james' });

  // The web page cannot continue it.
  lindaWeb.say({ t: 'start', goal: 'more', continueId: id });
  await until(() => lindaWeb.got.find((m) => m.t === 'error' && m.code === 'view_only'), 'view only');

  // Linda continues it from her computer: same session, a second turn, on her key, with the lead's memory.
  const linda = await connect('linda');
  keys.length = 0;
  linda.say({ t: 'start', goal: 'now email it to Mona', continueId: id });
  await until(() => store.sessions.get(id).turns.length === 2 && store.sessions.get(id).turns[1].status === 'done', 'second turn saved');
  assert.equal(store.sessions.size, 1);
  assert.ok(keys.every((k) => k === 'sk-linda'));
  assert.match(leadSaw.at(-1), /Goal: tidy the notes[\s\S]*New message from the user \(Linda\): now email it to Mona/);
  assert.deepEqual(store.sessions.get(id).turns.map((t) => [t.goal, t.ownerName]), [['tidy the notes', 'James'], ['now email it to Mona', 'Linda']]);
  assert.deepEqual(new Set(store.sessions.get(id).participants), new Set(['james', 'linda']));

  // Over the API: James sees everything that is his; Mona, who took no part, sees the outline only.
  const api = async (who, method, pathname, body) => {
    let out;
    const req = { method, headers: {} };
    await handleApi({ req, url: new URL(`http://x${pathname}`), user: await store.verifyToken(tokens[who]), store, hub, json: (code, b) => { out = { code, body: b }; return true; }, readBody: async () => body ?? {} });
    return out;
  };
  const list = await api('mona', 'GET', '/api/sessions');
  assert.equal(list.body.sessions[0].turnCount, 2);
  const forJames = (await api('james', 'GET', `/api/sessions/${id}`)).body;
  assert.ok(forJames.events.some((r) => r.event.type === 'remembered'));
  assert.ok(forJames.events.some((r) => r.event.type === 'step'));
  const forLinda = (await api('linda', 'GET', `/api/sessions/${id}`)).body;
  assert.ok(!forLinda.events.some((r) => r.event.type === 'remembered'));   // James's personal note
  const forMona = (await api('mona', 'GET', `/api/sessions/${id}`)).body;
  assert.equal(forMona.session.participant, false);
  assert.ok(forMona.events.every((r) => ['session', 'state', 'spawn', 'agent'].includes(r.event.type)));
  assert.ok(!/short summaries/.test(JSON.stringify(forMona)));
  // Managing: only the starter (or team owner) renames; skills, notes and the team are managed here.
  assert.equal((await api('mona', 'PATCH', `/api/sessions/${id}`, { title: 'x' })).code, 403);
  assert.equal((await api('james', 'PATCH', `/api/sessions/${id}`, { title: 'Notes' })).code, 200);
  assert.equal(store.sessions.get(id).title, 'Notes');
  assert.equal((await api('linda', 'PUT', '/api/skills/notes-tidy', { description: 'Tidy notes', body: 'Open the notes app, sort by date, merge duplicates, then summarise.' })).body.revision, 1);
  assert.equal((await api('james', 'GET', '/api/skills')).body.skills[0].authorName, 'Linda');
  await api('mona', 'POST', '/api/memory', { scope: 'me', note: 'Mona prefers bullet points.' });
  assert.ok((await api('mona', 'GET', '/api/memory')).body.notes.some((n) => /bullet/.test(n.note)));
  assert.ok(!(await api('james', 'GET', '/api/memory')).body.notes.some((n) => /bullet/.test(n.note)));
  const team = (await api('james', 'GET', '/api/team')).body.team;
  assert.equal(team.isOwner, true);
  assert.equal((await api('linda', 'DELETE', '/api/team/members/mona')).code, 403);
  assert.equal((await api('james', 'DELETE', '/api/team/members/mona')).code, 200);
  assert.equal((await store.teamOf('mona')), null);

  james.ws.close(); linda.ws.close(); lindaWeb.ws.close();
  server.close();
}

console.log('sessions test passed');
process.exit(0);
