// Team mode end to end: two desktop clients (CloudClient + ToolHost) against a real hub.
import assert from 'node:assert/strict';
import http from 'node:http';
import { Hub } from '../server/hub.js';
import { MemoryStore } from '../server/store-memory.js';
import { CloudClient } from '../src/cloud.js';
import { ToolHost } from '../src/toolhost.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let uid = 0;
const use = (name, input = {}) => ({ type: 'tool_use', id: `t${++uid}`, name, input });
const say = (text) => ({ type: 'text', text });

const store = new MemoryStore();
store.addTeam('t1', 'Robotics');
store.addUser('james', 'James', 't1');
store.addUser('linda', 'Linda', 't1');
await store.setModel('james', { baseUrl: 'http://localhost:8000/v1', model: 'local-model', apiKey: 'sk-james' });

const turns = {};
const makeLlm = () => ({ async create(params) {
  await sleep(20);
  const isLead = params.tools?.[0]?.name === 'spawn_agent';
  const who = isLead ? 'lead' : params.system[0].text.match(/^You are "([^"]+)"/)[1];
  const turn = turns[who] = (turns[who] ?? 0) + 1;
  const last = params.messages.at(-1);
  const lastText = typeof last.content === 'string' ? last.content : last.content.map((b) => b.type === 'text' ? b.text : (b.content ?? []).map((c) => c.text ?? '').join('')).join('\n');
  let out;
  if (isLead) {
    const servers = params.tools[0].input_schema.properties.servers.items.enum;
    if (/retrospective/.test(lastText)) out = say('nothing');
    else if (servers.length === 4 && !turns.spawned) { turns.spawned = true; out = use('spawn_agent', { name: 'Courier', goal: 'carry it over', servers: servers.filter((s) => s.startsWith('desktop@')) }); }
    else if (turns.spawned && /No workers are running/.test(lastText)) out = say('Carried over.');
    else out = use('wait');
  } else {
    out = turn === 1 ? use('desktop_linda-mac__get_window_state', { pid: 41, window_id: 5 })
      : turn === 2 ? use('desktop_linda-mac__type_text', { pid: 41, text: 'hi' })
      : turn === 3 ? use('desktop_james-mac__click', { pid: 77 })
      : say('carried. Lessons: none.');
  }
  return { content: Array.isArray(out) ? out : [out], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 5 } };
} });

const server = http.createServer();
new Hub({ store, makeLlm, config: { model: 'fake', maxAgents: 4, maxSteps: 10 } }).listen(server);
await new Promise((r) => server.listen(0, r));
const url = `http://127.0.0.1:${server.address().port}`;

function desk(userId, deviceName, idle) {
  const calls = [];
  const closed = [];
  const connect = async (name) => ({
    name, pid: null, close: async () => closed.push(name),
    tools: (name === 'desktop' ? ['get_window_state', 'type_text', 'click'] : ['read_file']).map((n) => ({ name: n, description: n, inputSchema: { type: 'object', properties: {} } })),
    client: { callTool: async ({ name: tool, arguments: args }) => { calls.push([tool, args, Date.now()]); return { content: [{ type: 'text', text: `ok ${deviceName}` }] }; } },
  });
  const ui = [];
  const host = new ToolHost({
    config: { typingPause: 2, servers: { desktop: { command: 'x', about: 'Drives apps', kind: 'desktop', shared: true, serial: true, tile: 'window' }, files: { command: 'x', about: 'Files', shared: true } } },
    workspace: '/tmp', connect, idle, emit: (e) => ui.push(e),
    layout: (n) => Array.from({ length: n }, (_, i) => ({ x: i * 500, y: 118, w: 500, h: 600 })),
  });
  let over = 0;
  const client = new CloudClient({
    url, host, device: { id: `d-${userId}`, name: deviceName, platform: 'darwin' },
    auth: { token: async () => `user:${userId}`, signIn: async () => {}, signOut: async () => {} },
    send: (e) => ui.push(e), onSessionOver: () => { over++; },
  });
  const until = async (pred, label, ms = 6000) => { const t0 = Date.now(); for (;;) { const hit = ui.find(pred); if (hit) return hit; if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${label}`); await sleep(10); } };
  return { client, host, ui, calls, closed, until, get over() { return over; } };
}

// Linda is typing when the agent arrives at her computer; James is idle.
let lindaTypingUntil = 0;
const J = desk('james', 'James Mac', () => 60);
const L = desk('linda', 'Linda Mac', () => (Date.now() < lindaTypingUntil ? 0 : 60));
await J.client.start();
await L.client.start();
const acct = await J.until((e) => e.type === 'account' && e.state === 'signed_in', 'signed in');
assert.deepEqual([acct.user.name, acct.team.name, acct.device.id], ['James', 'Robotics', 'd-james']);
await L.until((e) => e.type === 'account' && e.state === 'signed_in', 'linda signed in');

J.client.startSession('Carry the text from Linda to James');
const consent = await L.until((e) => e.type === 'consent', 'consent card');
assert.equal(consent.session.owner.name, 'James');
lindaTypingUntil = Date.now() + 900;
L.client.consent(true);

await J.until((e) => e.type === 'done', 'done', 10000);
await sleep(150);

// Both screens got the same story.
for (const d of [J, L]) {
  assert.ok(d.ui.some((e) => e.type === 'spawn' && e.agent.name === 'Courier'));
  assert.equal(d.ui.find((e) => e.type === 'done').summary, 'Carried over.');
}
// Each call ran on the right computer.
// After each action the app's windows are listed and its window read again on the same computer, and handed back
// with the action's result.
assert.deepEqual(L.calls.map((c) => c[0]), ['get_window_state', 'type_text', 'list_windows', 'get_window_state']);
assert.deepEqual(J.calls.map((c) => c[0]).filter((t) => t !== 'list_windows' && t !== 'get_window_state'), ['click']);
// Docking: the agent's computer is named in its events, so the other screen can hide its cursor.
const onLinda = J.ui.find((e) => e.type === 'agent' && e.device === 'd-linda');
assert.deepEqual([onLinda.deviceName, onLinda.server], ['Linda Mac', 'desktop']);
assert.ok(J.ui.some((e) => e.type === 'agent' && e.device === 'd-james' && e.status === 'acting'));
// On Linda's computer the agent's window was tracked; on James's it was not hers to place.
const courierOnLinda = L.host.agents.size === 0 ? null : [...L.host.agents.values()][0];
assert.equal(courierOnLinda, null);                                    // cleared when the session ended
assert.ok(L.over >= 1 && J.over >= 1);
// Reading did not wait for Linda to stop typing; typing into her app did.
const [readAt, typeAt] = [L.calls[0][2], L.calls[1][2]];
assert.ok(readAt < lindaTypingUntil, 'reading does not wait');
assert.ok(typeAt >= lindaTypingUntil, 'acting waits for the person at that computer to pause');
assert.ok(L.ui.some((e) => e.type === 'agent' && e.local && e.label === 'waiting for you to pause'));
// Presence told each computer whether it was in the session.
assert.ok(L.ui.some((e) => e.type === 'presence' && e.people.find((p) => p.name === 'Linda').devices[0].inSession));
// Shared servers stay open for the next session.
assert.deepEqual(L.closed, []);

// Slots: two agents on one computer get different places.
const a1 = L.host.agent({ id: 'x1', name: 'A', color: '#f00' });
const a2 = L.host.agent({ id: 'x2', name: 'B', color: '#0f0' });
await L.host.open('desktop', a1); await L.host.open('desktop', a2);
assert.ok(a1.slot && a2.slot && a1.slot.x !== a2.slot.x);
await assert.rejects(L.host.open('nope', a1), /no "nope" server/);

await J.client.shutdown(); await L.client.shutdown();
console.log('cloud test passed');
process.exit(0);
