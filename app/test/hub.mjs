// Hub test: two people, two computers and a browser, over real WebSockets, with a scripted model.
import assert from 'node:assert/strict';
import http from 'node:http';
import WebSocket from 'ws';
import { Hub } from '../server/hub.js';
import { MemoryStore } from '../server/store-memory.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let uid = 0;
const use = (name, input = {}) => ({ type: 'tool_use', id: `t${++uid}`, name, input });
const say = (text) => ({ type: 'text', text });

const store = new MemoryStore();
store.addTeam('t1', 'Robotics');
const james = store.addUser('james', 'James', 't1');
const linda = store.addUser('linda', 'Linda', 't1');
const mona = store.addUser('mona', 'Mona', 't1');
store.addUser('nobody', 'Nobody');
await store.setKey('james', 'sk-james');
store.memories.push({ scope: 'user', teamId: 't1', subjectId: 'linda', authorId: 'linda', note: 'Linda writes in British English.' });
store.memories.push({ scope: 'user', teamId: 't1', subjectId: 'nobody', authorId: 'nobody', note: 'private to someone else' });

// ---- scripted model -------------------------------------------------------------------
const seen = { keys: [], leadTools: [], lead: [] };
const turns = {};
const scripts = {
  lead: ({ lastText, params }) => {
    seen.lead.push(lastText);
    const servers = params.tools.find((t) => t.name === 'spawn_agent').input_schema.properties.servers.items.enum;
    seen.leadTools.push(servers.join(','));
    if (/do a short retrospective/.test(lastText)) return use('save_skill', { name: 'word-to-doc', description: 'Use when copying text between two people\'s computers.', body: 'Read on the source computer, then write on the target computer. Ask the person at each computer for sign-ins.' });
    if (/Created skill "word-to-doc"/.test(lastText)) return say('noted');
    if (/Message from the user Linda: also make it bold/.test(lastText)) return [say('Will do, Linda.'), use('remember', { scope: 'person', person: 'linda', note: 'Likes headings in bold.' }), use('remember', { scope: 'person', person: 'Zed', note: 'x' })];
    if (servers.length === 2 && !turns.spawned) { turns.spawned = true; return use('spawn_agent', { name: 'Mover', goal: 'copy the text across', servers }); }
    if (turns.spawned && /No workers are running/.test(lastText)) return say('Copied across both computers.');
    return use('wait');
  },
  Mover: ({ turn, lastText, system }) => {
    if (turn === 1) { seen.moverSystem = system; return use('desktop_linda-mac__click', { pid: 7 }); }
    if (turn === 2) return use('handoff', { reason: 'Word wants a sign-in', steps_for_user: 'Sign in to Word', done_when: 'the document is open' });
    if (turn === 3) { seen.afterHandoff = lastText; return use('desktop_james-mac__click', { pid: 9 }); }
    return say('moved it. Lessons: read then write.');
  },
};
const makeLlm = (key) => ({
  async create(params, { signal } = {}) {
    seen.keys.push(key);
    await sleep(15);
    if (signal?.aborted) throw new Error('aborted');
    const isLead = params.tools?.[0]?.name === 'spawn_agent';
    const who = isLead ? 'lead' : params.system[0].text.match(/^You are "([^"]+)"/)[1];
    const turn = turns[who] = (turns[who] ?? 0) + 1;
    const last = params.messages.at(-1);
    const lastText = typeof last.content === 'string' ? last.content
      : last.content.map((b) => b.type === 'text' ? b.text : (b.content ?? []).map((c) => c.text ?? '').join('')).join('\n');
    const out = await scripts[who]({ turn, lastText, params, system: params.system[0].text });
    return { content: Array.isArray(out) ? out : [out], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } };
  },
});

// ---- server and clients -----------------------------------------------------------------
const server = http.createServer();
const hub = new Hub({ store, makeLlm, config: { model: 'fake', maxAgents: 4, maxSteps: 10 } }).listen(server);
await new Promise((r) => server.listen(0, r));
const url = `ws://127.0.0.1:${server.address().port}`;

function connect(token, role, device) {
  const ws = new WebSocket(url);
  const c = { ws, got: [], events: [], calls: [], opens: [], autoConsent: null };
  const tools = [{ name: 'click', description: 'click', inputSchema: { type: 'object', properties: {} } }];
  ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', token, role, device, servers: device ? { desktop: { about: 'Drives apps', kind: 'desktop', tools } } : undefined })));
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    c.got.push(m);
    if (m.t === 'event') c.events.push(m.event);
    if (m.t === 'consent_request' && c.autoConsent != null) setTimeout(() => ws.send(JSON.stringify({ t: 'consent', allow: c.autoConsent })), 60);
    if (m.t === 'open') { c.opens.push(m); ws.send(JSON.stringify({ t: 'opened', rid: m.rid, conn: `c-${m.agent.id}-${m.server}`, tools })); }
    if (m.t === 'call') { c.calls.push(m); ws.send(JSON.stringify({ t: 'result', rid: m.rid, content: [{ type: 'text', text: `ok on ${device.name}` }] })); }
  });
  c.say = (msg) => ws.send(JSON.stringify(msg));
  c.until = async (pred, label, ms = 5000) => { const t0 = Date.now(); for (;;) { const hit = c.got.find(pred); if (hit) return hit; if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${label}`); await sleep(10); } };
  return c;
}

// Sign-in and team checks.
const bad = connect('garbage', 'web');
assert.equal((await bad.until((m) => m.t === 'error', 'auth error')).code, 'auth');
const loner = connect('user:nobody', 'web');
assert.equal((await loner.until((m) => m.t === 'error', 'team error')).code, 'no_team');

const jamesMac = connect(james, 'device', { id: 'd-james', name: 'James Mac', platform: 'darwin' });
const lindaMac = connect(linda, 'device', { id: 'd-linda', name: 'Linda Mac', platform: 'darwin' });
const lindaWeb = connect(linda, 'web');
const monaWeb = connect(mona, 'web');
lindaMac.autoConsent = true;
await Promise.all([jamesMac, lindaMac, lindaWeb, monaWeb].map((c) => c.until((m) => m.t === 'welcome', 'welcome')));
const pres = await lindaWeb.until((m) => m.t === 'presence' && m.people.length === 3 && m.people.filter((p) => p.devices.length === 1).length === 2, 'presence');
assert.deepEqual(pres.people.map((p) => p.name).sort(), ['James', 'Linda', 'Mona']);

// The web page watches and manages; it cannot start or steer a session.
lindaWeb.say({ t: 'start', goal: 'x' });
assert.equal((await lindaWeb.until((m) => m.t === 'error', 'view only')).code, 'view_only');
// A session runs on its starter's key, so Linda (no key) cannot start one.
lindaMac.say({ t: 'start', goal: 'x' });
assert.equal((await lindaMac.until((m) => m.t === 'error', 'no key')).code, 'no_key');

jamesMac.say({ t: 'start', goal: "Copy the text from Linda's Word into my doc" });
const ask = (await lindaMac.until((m) => m.t === 'consent_request', 'consent request')).session;
assert.equal(ask.owner.name, 'James');
assert.ok(!jamesMac.got.some((m) => m.t === 'consent_request'));   // the owner's own computer needs no prompt

// Linda writes to the lead from the browser while the job runs.
await lindaWeb.until((m) => m.t === 'event' && m.event.type === 'spawn', 'spawn');
lindaMac.say({ t: 'chat', text: 'also make it bold' });

// The worker hits a sign-in on Linda's computer: the request is addressed to her.
const handoff = (await lindaMac.until((m) => m.t === 'event' && m.event.type === 'ask', 'handoff')).event;
assert.deepEqual(handoff.audience, { deviceId: 'd-linda', userId: 'linda', userName: 'Linda' });
lindaMac.say({ t: 'cancel' });                                       // only the owner may stop the session
assert.match((await lindaMac.until((m) => m.t === 'error' && /Only James/.test(m.message), 'cancel refused')).message, /Only James/);
// The request is for Linda alone: James sees that she is needed, not what was asked, and cannot answer for her.
const jamesSees = (await jamesMac.until((m) => m.t === 'event' && m.event.type === 'ask', 'redacted ask')).event;
assert.deepEqual(jamesSees, { type: 'ask', qid: handoff.qid, agentId: handoff.agentId, kind: 'handoff', audience: handoff.audience, redacted: true });
jamesMac.say({ t: 'answer', qid: handoff.qid, text: 'Done' });
assert.match((await jamesMac.until((m) => m.t === 'error' && /for Linda/.test(m.message), 'answer refused')).message, /for Linda/);
// Attaching mid-session: Linda opens a second browser tab and gets the session as it stands.
const lindaLate = connect(linda, 'web');
const late = (await lindaLate.until((m) => m.t === 'welcome', 'late welcome')).session;
assert.equal(late.joined, true);
assert.deepEqual(late.replay.slice(0, 2).map((e) => e.type), ['session', 'reset']);
assert.equal(late.replay.find((e) => e.type === 'spawn').agent.goal, 'copy the text across');
assert.ok(late.replay.some((e) => e.type === 'said' && e.text === 'also make it bold'));
assert.ok(late.replay.some((e) => e.type === 'remembered' && e.note === 'Likes headings in bold.'));
assert.equal(late.replay.find((e) => e.type === 'ask').steps, 'Sign in to Word');
// Mona is on the team but not in the session: she can see that agents exist and where, and nothing else.
const monaLate = connect(mona, 'web');
const outside = (await monaLate.until((m) => m.t === 'welcome', 'mona welcome')).session;
assert.equal(outside.joined, false);
assert.deepEqual([...new Set(outside.replay.map((e) => e.type))].sort(), ['agent', 'reset', 'session', 'spawn', 'state']);
assert.deepEqual(Object.keys(outside.replay.find((e) => e.type === 'spawn').agent).sort(), ['color', 'id', 'name']);
assert.ok(outside.replay.filter((e) => e.type === 'agent').every((e) => e.label === ''));
assert.ok(!/bold|British|Sign in to Word|copy the text/.test(JSON.stringify(monaWeb.events)));
lindaMac.say({ t: 'answer', qid: handoff.qid, text: '' });

await jamesMac.until((m) => m.t === 'event' && m.event.type === 'done', 'done', 8000);
await jamesMac.until((m) => m.t === 'event' && m.event.type === 'skill', 'skill', 8000);
await sleep(100);

const ev = jamesMac.events;
assert.equal(ev.find((e) => e.type === 'done').summary, 'Copied across both computers.');
// One worker used both computers, and each call ran on the right one.
// After each action the window is looked at on the same computer (list_windows finds it: this fake has none).
assert.deepEqual(lindaMac.calls.map((c) => [c.tool, c.args.pid]), [['click', 7], ['list_windows', 7]]);
assert.deepEqual(jamesMac.calls.map((c) => [c.tool, c.args.pid]), [['click', 9], ['list_windows', 9]]);
assert.equal(lindaMac.opens[0].agent.name, 'Mover');
// The cursor's computer follows the worker: Linda's first, then James's.
const where = ev.filter((e) => e.type === 'agent' && e.status === 'acting' && e.device).map((e) => e.deviceName);
assert.deepEqual([...new Set(where)], ['Linda Mac', 'James Mac']);
assert.equal(ev.find((e) => e.type === 'agent' && e.device === 'd-linda').server, 'desktop');
// The lead learned of Linda's computer only after she agreed, and its tools grew to match.
assert.equal(seen.leadTools[0], 'desktop@james-mac');
assert.ok(seen.leadTools.includes('desktop@james-mac,desktop@linda-mac'));
assert.ok(seen.lead.some((t) => /A tool server is now available:\n- desktop@linda-mac: Drives apps\. Runs on "Linda Mac", Linda's computer/.test(t)));
assert.match(seen.lead[0], /Session owner: James\.[\s\S]*Computers connected now:\n- "James Mac" \(James's\): desktop@james-mac/);
assert.match(seen.moverSystem, /# Several people share this session/);
// Attribution: who wrote, who answered, whose key, whose memory.
assert.match(seen.afterHandoff, /The user replied: Done \(from Linda\)/);
assert.ok(ev.some((e) => e.type === 'said' && e.from.name === 'Linda' && e.text === 'also make it bold'));
assert.ok(ev.some((e) => e.type === 'chat' && e.from === 'lead' && e.text === 'Will do, Linda.'));
assert.ok(seen.keys.every((k) => k === 'sk-james'));
// Memory: only participants' notes reach the lead; new notes are attributed to the person who said them.
assert.ok(seen.lead.some((t) => /Linda joined the session\. Remembered about Linda:\n- Linda writes in British English\. \(from Linda\)/.test(t)));
assert.ok(!/private to someone else/.test(seen.lead.join('\n')));
const mem = store.memories.find((m) => m.note === 'Likes headings in bold.');
assert.deepEqual([mem.scope, mem.subjectId, mem.authorId, mem.teamId], ['user', 'linda', 'linda', 't1']);
assert.ok(seen.lead.some((t) => /Not remembered: "Zed" is not a participant/.test(t)));
// A personal note is shown to its person only. James, the owner, does not get it.
assert.ok(lindaWeb.events.some((e) => e.type === 'remembered' && e.person === 'Linda'));
assert.ok(!ev.some((e) => e.type === 'remembered'));
assert.ok(!/British English/.test(JSON.stringify(jamesMac.got)));
assert.ok(!ev.some((e) => e.type === 'ask' && e.steps));
assert.ok(!monaWeb.events.some((e) => !['session', 'reset', 'state', 'spawn', 'agent'].includes(e.type)));
// The skill belongs to the team, credited to the session owner.
const skill = store.skills.get('t1/word-to-doc');
assert.deepEqual([skill.authorId, skill.revision], ['james', 1]);
// History.
const session = [...store.sessions.values()][0];
assert.deepEqual([session.ownerId, session.status, session.summary], ['james', 'done', 'Copied across both computers.']);
assert.deepEqual(store.messages.map((m) => [m.authorId, m.text]), [['linda', 'also make it bold']]);
assert.ok(lindaMac.got.some((m) => m.t === 'session_over'));

// A declined computer never receives calls, and a computer that drops out is reported to the lead.
Object.keys(turns).forEach((k) => delete turns[k]);
lindaMac.autoConsent = false;
lindaMac.calls.length = 0;
const told = [];
scripts.lead = ({ lastText, turn }) => { told.push(lastText); return /no longer available/.test(lastText) ? say('stopping') : turn > 40 ? say('gave up') : use('ask_user', { question: 'continue?' }); };
jamesMac.got.length = 0; jamesMac.events.length = 0;
jamesMac.say({ t: 'start', goal: 'second' });
const q = (await jamesMac.until((m) => m.t === 'event' && m.event.type === 'ask', 'lead question')).event;
assert.equal(q.audience, null);                                       // a question from the lead is for everyone
await sleep(150);
jamesMac.ws.close();                                                  // James's computer drops out
await sleep(100);
// Linda declined to share her computer, so she is outside this session until she joins.
lindaWeb.got.length = 0;
lindaMac.got.length = 0;
lindaWeb.say({ t: 'answer', qid: q.qid, text: 'yes' });
await lindaWeb.until((m) => m.t === 'error' && m.code === 'view_only', 'web cannot answer');
lindaMac.say({ t: 'answer', qid: q.qid, text: 'yes' });
await lindaMac.until((m) => m.t === 'error' && /Join the session first/.test(m.message), 'join first');
lindaWeb.say({ t: 'join' });   // watching from the web page is allowed
const caught = (await lindaWeb.until((m) => m.t === 'joined', 'joined')).session;
assert.equal(caught.joined, true);
assert.equal(caught.replay.find((e) => e.type === 'ask').question, 'continue?');   // the open question came with the catch-up
lindaMac.say({ t: 'answer', qid: q.qid, text: 'yes' });
await lindaWeb.until((m) => m.t === 'event' && m.event.type === 'done' && m.event.summary === 'stopping', 'second done', 8000);
assert.ok(told.some((t) => /Linda declined to share "Linda Mac"/.test(t)));
assert.ok(told.some((t) => /The tool server "desktop@james-mac" is no longer available/.test(t)));
assert.equal(lindaMac.calls.length, 0);

console.log('hub test passed');
process.exit(0);
