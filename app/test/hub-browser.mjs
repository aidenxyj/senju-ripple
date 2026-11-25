// Hub test: in a team session, a worker using a teammate's browser still moves its ghost cursor there.
// The hub knows a computer's browser only by name (browser@<computer>), so it must keep it marked as a tiled
// browser; otherwise the swarm skips pointing, visible typing, popups, on-screen keys and ad skipping.
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
await store.setModel('james', { baseUrl: 'http://localhost:8000/v1', model: 'local-model', apiKey: 'sk-james' });

const turns = {};
const makeLlm = () => ({
  async create(params) {
    await sleep(5);
    const isLead = params.tools?.[0]?.name === 'spawn_agent';
    const who = isLead ? 'lead' : params.system[0].text.match(/^You are "([^"]+)"/)[1];
    const turn = turns[who] = (turns[who] ?? 0) + 1;
    const last = params.messages.at(-1);
    const lastText = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
    let out;
    if (who === 'lead') {
      if (/retrospective/.test(lastText)) out = say('nothing to save');
      else if (!turns.spawned) {
        turns.spawned = true;
        const servers = params.tools.find((t) => t.name === 'spawn_agent').input_schema.properties.servers.items.enum;
        out = use('spawn_agent', { name: 'Clicker', goal: 'click the link', servers });
      } else if (/No workers are running/.test(lastText)) out = say('Clicked it.');
      else out = use('wait');
    } else {
      const click = params.tools.find((t) => /browser_click$/.test(t.name)).name;
      out = turn === 1 ? use(click, { element: 'More information link', target: 'e12' }) : say('clicked');
    }
    return { content: [out], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } };
  },
});

const server = http.createServer();
new Hub({ store, makeLlm, config: { model: 'fake', maxAgents: 2, maxSteps: 6 } }).listen(server);
await new Promise((r) => server.listen(0, r));

// James's computer, as an older app would describe it: a browser server with no "tile" field.
const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
const tools = ['browser_navigate', 'browser_click', 'browser_evaluate', 'browser_type'].map((name) => ({ name, description: name, inputSchema: { type: 'object', properties: {} } }));
const got = { events: [], calls: [], welcome: false };
ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', token: james, role: 'device', device: { id: 'd-james', name: 'James Mac', platform: 'darwin' }, servers: { browser: { about: 'Chrome', tools } } })));
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.t === 'welcome') got.welcome = true;
  if (m.t === 'event') got.events.push(m.event);
  if (m.t === 'open') ws.send(JSON.stringify({ t: 'opened', rid: m.rid, conn: 'c1', tools }));
  if (m.t === 'call') {
    got.calls.push(m.tool);
    // The page answers the cursor's measuring script with where the element is on screen.
    const text = m.tool === 'browser_evaluate' ? '### Result\n{"x":120,"y":300,"screenX":520,"screenY":640,"windowW":800,"windowH":600,"w":90,"h":20,"chromeTop":87}' : 'ok';
    ws.send(JSON.stringify({ t: 'result', rid: m.rid, content: [{ type: 'text', text }] }));
  }
});
const until = async (pred, label, ms = 8000) => { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${label}`); await sleep(10); } };
await until(() => got.welcome, 'welcome');
ws.send(JSON.stringify({ t: 'start', goal: 'Click the link on the page' }));
await until(() => got.calls.includes('browser_click'), 'the click');

const point = got.events.find((e) => e.type === 'point');
assert.ok(point, 'the cursor moved to the element before the click');
assert.equal(point.point.verb, 'click');
assert.equal(point.point.screenX, 520);
assert.ok(got.calls.indexOf('browser_evaluate') < got.calls.indexOf('browser_click'), 'measured, then clicked');

ws.close();
server.close();
console.log('hub browser test passed');
process.exit(0);
