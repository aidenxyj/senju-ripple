// The hub: where a team's session lives. It runs the lead and workers, and connects them
// to people's computers and browsers over WebSocket.
//
//   desktop app (a "device") --ws-->  hub  <--ws-- web app
//        lends its tools                |   runs the Swarm on the session owner's model settings
//        shows cursors and cards        |   keeps accounts, memory and history in the store
//
// A tool server on a computer appears to the swarm as "<server>@<computer>". Calling it
// sends the call to that computer, which runs it and sends the result back.
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { costMicro, dollars, isActive } from './billing.js';
import { Swarm } from '../src/orchestrator.js';

const slug = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'computer';
const CALL_TIMEOUT = 150000;
const CHARGE_STEP = 250_000;   // hosted sessions are charged each time another $0.25 has been used
// Kept so that someone who joins late can catch up.
const LOGGED = new Set(['said', 'chat', 'result', 'board', 'remembered', 'skill']);
const LOG_MAX = 300;
// Kept for good in the session's history (everything but cursor motion and running totals).
const UNSAVED = new Set(['point', 'cursor', 'targets', 'usage', 'credits', 'reset']);
const FLUSH_MS = 2000;
// The web app watches and manages; only the desktop app runs or steers a session.
const DEVICE_ONLY = new Set(['start', 'chat', 'answer', 'cancel', 'pause', 'stop_agent', 'consent', 'leave']);
// Tools whose target text is personal (a note about someone) or typed text that may be private.
const PRIVATE_LABEL = /(^|__)(remember)$/;
const TYPED = /type|set_value|fill/;

export class Hub {
  /**
   * @param {object} o
   * @param {object} o.store      accounts, teams, model settings, memory, history (see store-memory.js for the shape)
   * @param {(settings: {baseUrl?: string, model?: string, apiKey?: string}) => {create: Function, model?: string}} o.makeLlm
   *                              builds a client for any OpenAI-compatible endpoint; may throw if the settings are incomplete
   * @param {object} [o.hosted]   the server's own model settings ({ baseUrl, model, apiKey }), sold in credits
   * @param {object} o.config     swarm settings: model, maxAgents, maxSteps, context, tokenBudget
   * @param {string} [o.traceDir]
   */
  // hosted and pricing are set when the server sells sessions on its own model; without them everyone brings their own.
  constructor({ store, makeLlm, config, traceDir = null, log = () => {}, hosted = null, pricing = null }) {
    this.hosted = pricing && hosted?.baseUrl && hosted?.model ? hosted : null;
    this.pricing = pricing;
    this.store = store;
    this.makeLlm = makeLlm;
    this.config = config;
    this.traceDir = traceDir;
    this.log = log;
    this.teams = new Map();   // teamId -> { id, name, clients: Set, session }
    this.wss = null;
  }

  listen(server) {
    this.wss = new WebSocketServer({ server, maxPayload: 48 * 1024 * 1024 });
    this.wss.on('connection', (ws) => this.accept(ws));
    return this;
  }

  // ---- Connections ----------------------------------------------------------------

  accept(ws) {
    const client = { ws, user: null, team: null, role: null, device: null, servers: {}, rpc: new Map(), alive: true };
    const greet = setTimeout(() => { if (!client.user) ws.close(4001, 'no hello'); }, 15000);
    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      try {
        if (msg.t === 'hello') { clearTimeout(greet); await this.hello(client, msg); }
        else if (!client.user) this.send(client, { t: 'error', message: 'Say hello first.' });
        else await this.handle(client, msg);
      } catch (err) {
        this.log('error', err);
        this.send(client, { t: 'error', message: String(err?.message ?? err) });
      }
    });
    ws.on('close', () => { clearTimeout(greet); this.leave(client); });
    ws.on('error', () => {});
  }

  send(client, msg) {
    if (client.ws.readyState === 1) client.ws.send(JSON.stringify(msg));
  }

  async hello(client, msg) {
    const user = await this.store.verifyToken(msg.token);
    if (!user) { this.send(client, { t: 'error', code: 'auth', message: 'Sign in again: the session has expired.' }); client.ws.close(4003, 'auth'); return; }
    const teamInfo = await this.store.teamOf(user.id);
    if (!teamInfo) { this.send(client, { t: 'error', code: 'no_team', message: 'Create or join a team in the web app first.' }); client.ws.close(4004, 'no team'); return; }
    let team = this.teams.get(teamInfo.id);
    if (!team) { team = { id: teamInfo.id, name: teamInfo.name, clients: new Set(), session: null }; this.teams.set(team.id, team); }
    team.name = teamInfo.name;
    team.members = teamInfo.members;
    client.user = user;
    client.team = team;
    client.role = msg.role === 'device' ? 'device' : 'web';
    if (client.role === 'device') {
      const id = String(msg.device?.id ?? crypto.randomUUID());
      // One connection per computer: a reconnect replaces the old one.
      for (const other of team.clients) if (other.device?.id === id) other.ws.close(4005, 'replaced');
      const taken = new Set([...team.clients].filter((c) => c.device).map((c) => c.device.slug));
      let s = slug(msg.device?.name), n = 2;
      while (taken.has(s)) s = `${slug(msg.device?.name)}-${n++}`;
      client.device = { id, name: String(msg.device?.name ?? 'Computer').slice(0, 60), slug: s, platform: msg.device?.platform ?? '' };
      client.servers = msg.servers && typeof msg.servers === 'object' ? msg.servers : {};
      await this.store.upsertDevice({ id, userId: user.id, teamId: team.id, name: client.device.name, platform: client.device.platform });
    }
    team.clients.add(client);
    const s = team.session;
    this.send(client, {
      t: 'welcome',
      user: { id: user.id, name: user.name },
      team: { id: team.id, name: team.name },
      device: client.device ? { id: client.device.id, name: client.device.name } : null,
      session: s ? this.sessionFor(s, client) : null,
    });
    this.presence(team);
    if (s && client.device) this.offer(s, client);
  }

  leave(client) {
    const team = client.team;
    if (!team) return;
    team.clients.delete(client);
    for (const { reject, timer } of client.rpc.values()) { clearTimeout(timer); reject(new Error('That computer disconnected.')); }
    client.rpc.clear();
    const s = team.session;
    if (s && client.device) {
      for (const [full, at] of s.servers) if (at.client === client) { s.servers.delete(full); s.swarm.removeServer(full); }
      s.allowed.delete(client.device.id);
    }
    this.presence(team);
    if (team.clients.size === 0 && !team.session) this.teams.delete(team.id);
  }

  presence(team) {
    const s = team.session;
    const people = new Map();
    for (const c of team.clients) {
      const p = people.get(c.user.id) ?? { id: c.user.id, name: c.user.name, web: false, joined: Boolean(s?.people.has(c.user.id)), devices: [] };
      if (c.device) p.devices.push({ id: c.device.id, name: c.device.name, inSession: Boolean(s?.allowed.has(c.device.id)), asked: Boolean(s?.asked.has(c.device.id)) });
      else p.web = true;
      people.set(c.user.id, p);
    }
    this.broadcast(team, { t: 'presence', people: [...people.values()], session: s ? { id: s.id, goal: s.goal, owner: s.owner } : null });
  }

  broadcast(team, msg) { for (const c of team.clients) this.send(c, msg); }

  // ---- Messages from clients ----------------------------------------------------------

  async handle(client, msg) {
    const team = client.team;
    const s = team.session;
    if (client.role === 'web' && DEVICE_ONLY.has(msg.t)) {
      return this.send(client, { t: 'error', code: 'view_only', message: 'The web page is for watching and managing. Start, continue and steer sessions from the Senju desktop app.' });
    }
    switch (msg.t) {
      case 'start': return this.start(client, String(msg.goal ?? '').trim(), msg.continueId ? String(msg.continueId) : null);
      case 'opened': case 'result': { // replies to our calls into a computer
        const waiting = client.rpc.get(msg.rid);
        if (!waiting) return;
        client.rpc.delete(msg.rid);
        clearTimeout(waiting.timer);
        return msg.error ? waiting.reject(new Error(String(msg.error))) : waiting.resolve(msg);
      }
    }
    if (!s) return this.send(client, { t: 'error', message: 'No session is running.' });
    const isOwner = client.user.id === s.owner.id;
    switch (msg.t) {
      case 'consent': {
        if (!client.device || !s.asked.has(client.device.id)) return;
        s.asked.delete(client.device.id);
        if (msg.allow) this.admit(s, client);
        else if (msg.watch) {   // follow the session and talk to the lead, without lending this computer
          this.join(s, client.user);
          s.swarm.pushEvent({ kind: 'system', text: `${client.user.name} is following the session but did not share "${client.device.name}". Do not plan on that computer.` });
        } else s.swarm.pushEvent({ kind: 'system', text: `${client.user.name} declined to share "${client.device.name}" for this session. Do not plan on it.` });
        return this.presence(team);
      }
      case 'join':   // see the session and take part, from a browser or a computer
        this.join(s, client.user);
        return this.presence(team);
      case 'chat': {
        const text = String(msg.text ?? '').trim();
        if (!text) return;
        const target = msg.target || 'lead';
        this.join(s, client.user);
        if (!s.swarm.tell(text, target, client.user.name)) return this.send(client, { t: 'error', message: 'That agent is no longer working, so the message was not delivered.' });
        this.event(s, { type: 'said', from: { id: client.user.id, name: client.user.name }, target, text });
        return this.store.addMessage({ sessionId: s.id, authorId: client.user.id, target, text });
      }
      case 'answer': {
        const ask = s.asks.get(msg.qid);
        if (!ask) return;
        if (!s.people.has(client.user.id)) return this.send(client, { t: 'error', message: 'Join the session first.' });
        // A request tied to a computer is answered by the person at it, and by nobody else.
        if (ask.audience && ask.audience.userId !== client.user.id) return this.send(client, { t: 'error', message: `That request is for ${ask.audience.userName}.` });
        return s.swarm.answer(msg.qid, String(msg.text ?? ''), client.user.name);
      }
      case 'pause': case 'stop_agent': {
        const agent = s.swarm.agents.find((a) => a.id === msg.id);
        const at = agent && s.servers.get(agent.server);
        if (!isOwner && at?.client.user.id !== client.user.id) return this.send(client, { t: 'error', message: 'Only the session owner, or the person whose computer the agent is on, can do that.' });
        return msg.t === 'pause' ? s.swarm.setPaused(msg.id, msg.paused) : s.swarm.stopAgent(msg.id);
      }
      case 'cancel':
        if (!isOwner) return this.send(client, { t: 'error', message: `Only ${s.owner.name}, who started this session, can stop it.` });
        return s.swarm.cancel();
      case 'leave': { // take this computer out of the session
        if (!client.device) return;
        for (const [full, at] of s.servers) if (at.client === client) { s.servers.delete(full); s.swarm.removeServer(full); }
        s.allowed.delete(client.device.id);
        return this.presence(team);
      }
    }
  }

  // ---- Sessions ---------------------------------------------------------------------------

  async start(client, goal, continueId = null) {
    const team = client.team;
    if (!goal) return;
    if (team.session) return this.send(client, { t: 'error', message: `${team.session.owner.name} already has a session running. Write to its lead to change the plan.` });
    // Continuing a session: the lead picks up its saved conversation.
    let prior = null;
    if (continueId) {
      prior = await this.store.getSession(continueId);
      if (!prior || prior.teamId !== team.id) return this.send(client, { t: 'error', code: 'no_session', message: 'That session is not in your team.' });
    }
    // Whoever starts the session pays for it: on their own model if they saved one, otherwise from their credits.
    let settings = await this.store.getModel(client.user.id);
    let hosted = false;
    if (!settings) {
      if (!this.hosted) return this.send(client, { t: 'error', code: 'no_model', message: 'Add your model settings in the web app first (any OpenAI-compatible endpoint). A session runs on the model of whoever starts it.' });
      const account = await this.store.getBilling(client.user.id);
      if (!isActive(account.status)) return this.send(client, { t: 'error', code: 'no_plan', message: 'Sessions on this server\'s model need a subscription. Subscribe in the web app, or save your own model settings there to run for free.' });
      if (account.credits < this.pricing.minStartMicro) return this.send(client, { t: 'error', code: 'no_credits', message: `You have ${dollars(Math.max(0, account.credits))} of credits left, which is not enough to start. Add credits in the web app.` });
      settings = this.hosted;
      hosted = true;
    }
    let llm;
    try { llm = this.makeLlm(settings); }
    catch (err) {
      this.log('model settings', client.user.id, err?.message ?? err);
      return this.send(client, { t: 'error', code: 'no_model', message: 'Your saved model settings are incomplete (they need a base URL and a model name). Save them again in the web app.' });
    }

    const s = {
      id: prior?.id ?? crypto.randomUUID(), team, goal,
      title: prior?.title ?? goal.slice(0, 80),
      turn: prior?.turns?.length ?? 0,
      persist: [], seq: 0, flushing: Promise.resolve(),
      owner: { id: client.user.id, name: client.user.name },
      servers: new Map(),     // "server@computer" -> { client, server }
      allowed: new Set(),     // device ids taking part
      asked: new Set(),       // device ids with a consent request open
      asks: new Map(),        // open questions: qid -> { audience, event }
      people: new Map([[client.user.id, client.user.name]]),   // participants, for memory attribution
      // The session's current picture, for people who join late: built per person in snapshot().
      spawns: new Map(), latest: new Map(), leadLast: null, stateNow: 'planning', log: [], done: null,
      billing: hosted ? { cost: 0, charged: 0, n: 0, out: false, chain: Promise.resolve() } : null,
    };
    const store = this.store;
    const config = { ...this.config, servers: {}, ...(llm.model ? { model: llm.model, plannerModel: llm.model } : {}) };
    s.swarm = new Swarm({
      llm,
      config,
      workspace: '~/Senju on each computer',
      emit: (event) => this.event(s, event),
      connect: (name, _spec, agent) => this.open(s, name, agent),
      traceDir: this.traceDir,
      team: { get brief() { return hubBrief(s); } },
      skills: {
        list: () => store.listSkills(team.id),
        read: (name) => store.readSkill(team.id, name),
        save: (skill) => store.saveSkill(team.id, skill, s.owner.id, s.id),
      },
      memory: {
        notes: async () => (await store.memoryNotes(team.id, [...s.people.keys()]))
          .map((m) => `- ${m.scope === 'team' ? 'Team' : m.subjectName}: ${m.note} (from ${m.authorName})`).join('\n'),
        remember: async ({ scope, person, note }) => {
          const who = [...s.people].find(([, name]) => name.toLowerCase() === String(person ?? '').trim().toLowerCase());
          if (!who) return `Not remembered: "${person}" is not a participant. Participants: ${[...s.people.values()].join(', ')}.`;
          if (!String(note ?? '').trim()) return 'Not remembered: the note is empty.';
          const row = { scope: scope === 'team' ? 'team' : 'user', teamId: team.id, subjectId: who[0], authorId: who[0], sessionId: s.id, note: String(note).trim().slice(0, 600) };
          await store.addMemory(row);
          this.event(s, { type: 'remembered', scope: row.scope, person: who[1], personId: who[0], note: row.note });
          return `Remembered for ${row.scope === 'team' ? 'the team' : who[1]}, attributed to ${who[1]}.`;
        },
      },
    });
    s.swarm.catalog = {};
    team.session = s;
    // Earlier participants of a continued session keep their place in its history.
    for (const id of prior?.participants ?? []) if (!s.people.has(id)) s.history = [...(s.history ?? []), id];
    if (!prior) await store.createSession({ id: s.id, teamId: team.id, ownerId: s.owner.id, goal });
    const started = new Date().toISOString();
    await store.startTurn(s.id, { goal, ownerId: s.owner.id, ownerName: s.owner.name, started });
    const resume = prior ? { messages: await store.getLeadCtx(s.id), by: client.user.name, gap: since(prior.endedAt) } : null;
    s.flusher = setInterval(() => this.flush(s), FLUSH_MS);
    // The owner's own computers are in from the start. Everyone else's are asked.
    for (const c of team.clients) if (c.device) this.offer(s, c);
    this.presence(team);
    this.event(s, { type: 'session', id: s.id, goal, owner: s.owner, turn: s.turn, title: s.title, continued: Boolean(prior) });

    s.swarm.run(goal, { resume: resume?.messages?.length ? resume : null }).then(async () => {
      const done = s.done;
      if (s.billing) await this.meter(s, s.swarm.usage, true);
      clearInterval(s.flusher);
      await this.flush(s);
      const status = done ? 'done' : 'stopped';
      const turn = { status, summary: done?.summary ?? null, usage: s.swarm.usage, billing: s.billing ? 'hosted' : 'own_key', costMicro: s.billing?.cost ?? null, ended: new Date().toISOString() };
      await store.finishTurn(s.id, { ...turn, participants: [...new Set([...(s.history ?? []), ...s.people.keys()])] }).catch((err) => this.log('history: could not save the turn', s.id, err?.message ?? err));
      if (s.swarm.leadSnapshot) await store.saveLeadCtx(s.id, s.swarm.leadSnapshot).catch((err) => this.log('history: could not save the lead', s.id, err?.message ?? err));
      await store.endSession(s.id, { status, summary: turn.summary, usage: turn.usage, billing: turn.billing, costMicro: turn.costMicro }).catch(() => {});
      for (const c of team.clients) if (c.device) this.send(c, { t: 'session_over', sessionId: s.id });
      team.session = null;
      this.presence(team);
      await s.swarm.learning;   // the retrospective finishes in the background
      if (s.billing) await this.meter(s, s.swarm.usage, true);   // writing the skill used tokens too
      if (team.clients.size === 0 && !team.session) this.teams.delete(team.id);
    });
  }

  // Charge a hosted session's owner for what it has used since the last charge. Charges are small and
  // frequent so that a crash loses little, and the session stops as soon as the balance is gone.
  meter(s, usage, final = false) {
    const b = s.billing;
    b.cost = costMicro(usage, this.pricing);
    const due = b.cost - b.charged;
    if (due <= 0 || (!final && due < CHARGE_STEP)) return b.chain;
    b.charged = b.cost;
    const n = ++b.n;
    b.chain = b.chain.then(async () => {
      const balance = await this.store.applyCredit({ userId: s.owner.id, deltaMicro: -due, kind: 'usage', sessionId: s.id, eventId: `usage:${s.id}:${n}`, note: s.goal.slice(0, 80) });
      // Only the person paying sees their balance.
      for (const c of s.team.clients) if (c.user.id === s.owner.id) this.send(c, { t: 'event', sessionId: s.id, event: { type: 'credits', balance, text: dollars(Math.max(0, balance)), spent: dollars(b.charged) } });
      if (balance <= 0 && !b.out && s.team.session === s) {
        b.out = true;
        this.event(s, { type: 'notice', message: `${s.owner.name} is out of credits, so this session is stopping. Add credits in the web app to run it again.` });
        s.swarm.cancel();
      }
    }).catch((err) => this.log('billing: could not charge', s.id, err?.message ?? err));
    return b.chain;
  }

  // Someone takes part for the first time: the lead is told, along with what is remembered about them.
  join(s, user) {
    if (s.people.has(user.id)) return;
    s.people.set(user.id, user.name);
    // Until now they saw only that agents exist. Send the session as it stands, as they may see it.
    for (const c of s.team.clients) if (c.user.id === user.id) this.send(c, { t: 'joined', session: this.sessionFor(s, c) });
    this.store.memoryNotes(s.team.id, [user.id]).then((notes) => {
      const own = notes.filter((m) => m.scope !== 'team').map((m) => `- ${m.note} (from ${m.authorName})`).join('\n');
      s.swarm.pushEvent({ kind: 'system', text: `${user.name} joined the session.${own ? ` Remembered about ${user.name}:\n${own}` : ''}` });
    }).catch(() => {});
  }

  // Bring a computer into the session, or ask its owner first.
  offer(s, client) {
    if (s.allowed.has(client.device.id)) return;
    if (client.user.id === s.owner.id) return this.admit(s, client);
    s.asked.add(client.device.id);
    this.send(client, { t: 'consent_request', session: { id: s.id, goal: s.goal, owner: s.owner } });
  }

  admit(s, client) {
    s.allowed.add(client.device.id);
    this.join(s, client.user);
    for (const [server, info] of Object.entries(client.servers)) {
      const full = `${server}@${client.device.slug}`;
      s.servers.set(full, { client, server });
      s.swarm.addServer(full, {
        about: `${info.about ?? server}. Runs on "${client.device.name}", ${client.user.name}'s computer`,
        kind: info.kind, app: info.app, shared: false,
        // A browser server: the swarm moves the cursor and types visibly only for tiled browsers.
        tile: info.tile ?? ((info.tools ?? []).some((t) => t.name === 'browser_navigate') ? 'playwright' : undefined),
      }, info.tools ?? []);
    }
  }

  // ---- Calls into a computer ------------------------------------------------------------------

  rpc(client, msg, signal, ms = CALL_TIMEOUT) {
    return new Promise((resolve, reject) => {
      if (client.ws.readyState !== 1) return reject(new Error('That computer is offline.'));
      const rid = crypto.randomUUID();
      const timer = setTimeout(() => { client.rpc.delete(rid); reject(new Error('That computer did not answer in time.')); }, ms);
      client.rpc.set(rid, { resolve, reject, timer });
      signal?.addEventListener('abort', () => { if (client.rpc.delete(rid)) { clearTimeout(timer); reject(new Error('cancelled')); } }, { once: true });
      this.send(client, { ...msg, rid });
    });
  }

  // A worker starts using a server on some computer. That computer opens it for this worker.
  async open(s, full, agent) {
    const at = s.servers.get(full);
    if (!at) throw new Error(`"${full}" is not available: its computer is not in this session.`);
    const opened = await this.rpc(at.client, { t: 'open', sessionId: s.id, server: at.server, agent: { id: agent.id, name: agent.name, color: agent.color } });
    const conn = opened.conn;
    return {
      name: full,
      tools: opened.tools ?? [],
      pid: null,
      client: {
        callTool: async ({ name, arguments: args }, _schema, opts) => {
          const res = await this.rpc(at.client, { t: 'call', conn, tool: name, args }, opts?.signal);
          return { content: res.content ?? [], isError: Boolean(res.isError), structuredContent: res.structured };
        },
      },
      close: async () => this.send(at.client, { t: 'close', conn }),
    };
  }

  // ---- Events out to everyone ---------------------------------------------------------------------

  event(s, event) {
    const e = { ...event };
    if (e.type === 'step') {
      // Tool results stay between the computer and the model; typed text and personal notes are not shown.
      delete e.result;
      delete e.input;
      if (PRIVATE_LABEL.test(String(e.tool ?? ''))) e.label = '';
      else if (TYPED.test(String(e.tool ?? '').replace(/^.*__/, '')) && e.label) e.label = e.label.replace(/"[^"]*"$/, '(typed text)');
      const agent = s.swarm.agents.find((a) => a.id === e.agentId);
      const at = agent && s.servers.get(agent.server);
      if (at) e.deviceName = at.client.device.name;
    }
    if (e.type === 'answered') e.audience = s.asks.get(e.qid)?.audience ?? null;
    if (e.type === 'agent' && e.server) {
      // Which computer the agent is on right now. Its cursor shows there and nowhere else.
      const at = s.servers.get(e.server);
      if (at) { e.device = at.client.device.id; e.deviceName = at.client.device.name; e.server = at.server; }
    }
    if (e.type === 'ask') {
      // A worker's request goes to the person at the computer it is working on.
      const agent = s.swarm.agents.find((a) => a.id === e.agentId);
      const at = agent && s.servers.get(agent.server);
      e.audience = at ? { deviceId: at.client.device.id, userId: at.client.user.id, userName: at.client.user.name } : null;
      s.asks.set(e.qid, { audience: e.audience, event: e });
    }
    if (e.type === 'answered') s.asks.delete(e.qid);
    if (e.type === 'spawn') s.spawns.set(e.agent.id, e);
    if (e.type === 'agent') s.latest.set(e.id, e);
    if (e.type === 'lead') s.leadLast = e;
    if (e.type === 'state') s.stateNow = e.state;
    if (e.type === 'done') s.done = e;
    if (e.type === 'usage' && s.billing) this.meter(s, e);
    if (LOGGED.has(e.type)) { s.log.push(e); if (s.log.length > LOG_MAX) s.log.shift(); }
    if (!UNSAVED.has(e.type)) s.persist.push({ turn: s.turn, seq: s.seq++, at: new Date().toISOString(), audience: audienceOf(e), event: e });
    for (const c of s.team.clients) {
      const seen = this.view(s, c, e);
      if (seen) this.send(c, { t: 'event', sessionId: s.id, event: seen });
    }
  }

  // What one person may see of an event.
  // Teammates who have not joined see only that agents exist and which computer each is on,
  // so the cursors can dock on their screen. Personal things go to their person alone.
  view(s, client, e) {
    return viewEvent(e, client.user.id, s.people.has(client.user.id));
  }

  // Write what has happened since the last flush to the session's history.
  flush(s) {
    if (!s.persist.length) return s.flushing;
    const rows = s.persist.splice(0);
    s.flushing = s.flushing.then(() => this.store.appendEvents(s.id, rows)).catch((err) => this.log('history: could not save events', s.id, err?.message ?? err));
    return s.flushing;
  }

  // A session that is running now, for the HTTP API: its id and who is in it.
  live(teamId) {
    const s = this.teams.get(teamId)?.session;
    return s ? { id: s.id, people: [...s.people.keys()] } : null;
  }

  // The session as it stands, replayed for one person through view().
  snapshot(s, client) {
    const events = [{ type: 'session', id: s.id, goal: s.goal, owner: s.owner }, { type: 'reset' }, { type: 'state', state: s.stateNow }];
    for (const [id, spawn] of s.spawns) { events.push(spawn); if (s.latest.has(id)) events.push(s.latest.get(id)); }
    if (s.leadLast) events.push(s.leadLast);
    events.push(...s.log);
    for (const { event } of s.asks.values()) events.push(event);
    return events.map((e) => this.view(s, client, e)).filter(Boolean);
  }

  sessionFor(s, client) {
    return { id: s.id, goal: s.goal, owner: s.owner, joined: s.people.has(client.user.id), replay: this.snapshot(s, client) };
  }
}

// What the lead is told about who and what is in the session.
function hubBrief(s) {
  const byDevice = new Map();
  for (const [full, at] of s.servers) {
    const d = byDevice.get(at.client.device.id) ?? { name: at.client.device.name, owner: at.client.user.name, servers: [] };
    d.servers.push(full);
    byDevice.set(at.client.device.id, d);
  }
  const computers = [...byDevice.values()].map((d) => `- "${d.name}" (${d.owner}'s): ${d.servers.join(', ')}`).join('\n');
  return `Session owner: ${s.owner.name}. People in this session: ${[...s.people.values()].join(', ')}.\nComputers connected now:\n${computers || '(none yet)'}`;
}

// What one person may see of an event: the same rule live and in history.
// Teammates who are not in the session see only that agents exist and which computer each is on,
// so the cursors can dock on their screen. Personal things go to their person alone.
export function viewEvent(e, me, joined) {
  if (!joined) {
    if (e.type === 'session' || e.type === 'reset' || e.type === 'state') return e;
    if (e.type === 'spawn') return { type: 'spawn', agent: { id: e.agent.id, name: e.agent.name, color: e.agent.color } };
    if (e.type === 'agent') return { ...e, label: '' };
    return null;
  }
  if (e.type === 'remembered' && e.scope !== 'team' && e.personId !== me) return null;
  if (e.type === 'ask' && e.audience && e.audience.userId !== me) return { type: 'ask', qid: e.qid, agentId: e.agentId, kind: e.kind, audience: e.audience, redacted: true };
  if (e.type === 'answered' && e.audience && e.audience.userId !== me) return { type: 'answered', qid: e.qid };
  return e;
}

// Who an event is for, stored beside it so history can be filtered the same way.
function audienceOf(e) {
  if (e.type === 'remembered' && e.scope !== 'team') return { userId: e.personId };
  if ((e.type === 'ask' || e.type === 'answered') && e.audience) return { userId: e.audience.userId };
  return null;
}

function since(iso) {
  const ms = iso ? Date.now() - Date.parse(iso) : NaN;
  if (!Number.isFinite(ms) || ms < 0) return null;
  const min = Math.round(ms / 60000);
  return min < 90 ? `${min} minutes` : min < 60 * 36 ? `${Math.round(min / 60)} hours` : `${Math.round(min / 1440)} days`;
}
