// Team mode: this computer's connection to the hub.
// It signs in, announces the tools this computer offers, runs tool calls the hub sends,
// and relays session events to the overlay.
import WebSocket from 'ws';

export class CloudClient {
  /**
   * @param {object} o
   * @param {string} o.url            the server's address, e.g. https://swarm.example.com
   * @param {object} o.auth           { token(): Promise<string|null>, signIn(email, password), signOut() }
   * @param {object} o.host           a ToolHost
   * @param {object} o.device         { id, name, platform }
   * @param {(event: object) => void} o.send   to the overlay
   * @param {() => void} [o.onSessionOver]
   */
  constructor({ url, auth, host, device, send, onSessionOver = () => {} }) {
    this.url = String(url).replace(/\/+$/, '');
    this.auth = auth;
    this.host = host;
    this.device = device;
    this.send = send;
    this.onSessionOver = onSessionOver;
    this.ws = null;
    this.me = null;          // { user, team } once the hub has welcomed us
    this.session = null;     // { id, goal, owner } while one runs
    this.inSession = false;  // this computer is taking part
    this.retry = 0;
    this.closed = false;
  }

  get running() { return Boolean(this.session); }
  get wsUrl() { return this.url.replace(/^http/, 'ws'); }

  async start() {
    const token = await this.auth.token();
    if (!token) return this.send({ type: 'account', state: 'signed_out', url: this.url });
    this.connect(token);
  }

  async signIn(email, password) {
    try {
      await this.auth.signIn(email, password);
      await this.start();
    } catch (err) {
      this.send({ type: 'account', state: 'signed_out', url: this.url, error: String(err?.message ?? err) });
    }
  }

  async signOut() {
    this.closed = true;
    this.ws?.close();
    await this.auth.signOut();
    this.me = null;
    this.closed = false;
    this.send({ type: 'account', state: 'signed_out', url: this.url });
  }

  async connect(token) {
    const servers = await this.host.catalog();
    const ws = new WebSocket(this.wsUrl, { maxPayload: 48 * 1024 * 1024 });
    this.ws = ws;
    ws.on('open', () => { this.retry = 0; this.say({ t: 'hello', token, role: 'device', device: this.device, servers }); });
    ws.on('message', (raw) => { let m; try { m = JSON.parse(raw.toString()); } catch { return; } this.onMessage(m).catch((err) => this.send({ type: 'notice', message: String(err?.message ?? err) })); });
    ws.on('error', () => {});
    ws.on('close', (code) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.session) { this.session = null; this.inSession = false; this.host.endSession(); this.onSessionOver(); this.send({ type: 'state', state: 'idle' }); }
      if (this.closed || code === 4003 || code === 4004 || code === 4005) return;   // signed out, no team, or replaced by a newer connection
      this.send({ type: 'account', state: 'offline', url: this.url });
      const wait = Math.min(30000, 1500 * 2 ** this.retry++);
      setTimeout(() => { if (!this.closed && !this.ws) this.start(); }, wait);
    });
  }

  say(msg) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(msg)); }

  async onMessage(m) {
    switch (m.t) {
      case 'welcome':
        this.me = { user: m.user, team: m.team };
        this.device = { ...this.device, ...m.device };
        this.send({ type: 'account', state: 'signed_in', user: m.user, team: m.team, device: m.device, url: this.url });
        if (m.session) this.catchUp(m.session);
        return;
      case 'joined':   // this person now takes part: the hub sends the session as they may see it
        return this.catchUp(m.session);
      case 'presence': {
        const mine = m.people.flatMap((p) => p.devices).find((d) => d.id === this.device.id);
        this.inSession = Boolean(mine?.inSession);
        if (!m.session && this.session) this.session = null;
        return this.send({ type: 'presence', people: m.people, session: m.session });
      }
      case 'consent_request':
        return this.send({ type: 'consent', session: m.session });
      case 'event':
        return this.onEvent(m.event);
      case 'open':
        try { this.say({ t: 'opened', rid: m.rid, ...(await this.host.open(m.server, m.agent)) }); }
        catch (err) { this.say({ t: 'opened', rid: m.rid, error: String(err?.message ?? err) }); }
        return;
      case 'call': {
        const res = await this.host.call(m.conn, m.tool, m.args);
        return this.say({ t: 'result', rid: m.rid, content: res.content, isError: res.isError, structured: res.structured });
      }
      case 'close':
        return this.host.close(m.conn);
      case 'session_over':
        this.session = null;
        this.inSession = false;
        await this.host.endSession();
        return this.onSessionOver();
      case 'error':
        if (m.code === 'auth') { await this.auth.signOut().catch(() => {}); return this.send({ type: 'account', state: 'signed_out', url: this.url, error: m.message }); }
        if (m.code === 'no_team') return this.send({ type: 'account', state: 'no_team', url: this.url, error: m.message });
        return this.send({ type: 'error', message: m.message });
    }
  }

  catchUp(session) {
    this.session = { id: session.id, goal: session.goal, owner: session.owner };
    for (const e of session.replay ?? []) this.onEvent(e, true);
  }

  // Keep the local picture of the agents current (for cursor placement), then pass the event on.
  // A replay repeats a session already under way, so it must not drop agents working here.
  onEvent(e, replay = false) {
    if (e.type === 'session') { this.session = { id: e.id, goal: e.goal, owner: e.owner }; if (!replay) this.host.agents.clear(); }
    if (e.type === 'spawn') this.host.agent(e.agent);
    if (e.type === 'agent') {
      const a = this.host.agents.get(e.id);
      if (a) {
        a.status = e.status; a.label = e.label;
        a.live = !['done', 'error', 'cancelled'].includes(e.status);
        // The server only matters for placement while the agent is on this computer.
        if (e.device) a.server = e.device === this.device.id ? e.server : null;
        a.device = e.device ?? a.device ?? null;
      }
    }
    this.send(e);
  }

  // ---- What the person at this computer can do -----------------------------------------------
  startSession(goal, continueId = null) { this.say({ t: 'start', goal, ...(continueId ? { continueId } : {}) }); }
  chat(text, target) { this.say({ t: 'chat', text, target }); }
  answer(qid, text) { this.say({ t: 'answer', qid, text }); }
  cancel() { this.say({ t: 'cancel' }); }
  pause(id, paused) { this.say({ t: 'pause', id, paused }); }
  stopAgent(id) { this.say({ t: 'stop_agent', id }); }
  consent(allow, watch = false) { this.say({ t: 'consent', allow, watch }); }
  join() { this.say({ t: 'join' }); }
  leave() { this.say({ t: 'leave' }); this.host.endSession(); this.onSessionOver(); }

  async shutdown() { this.closed = true; this.ws?.close(); await this.host.shutdown(); }
}

// Sign-in backed by Supabase, with the session kept in a file so the app stays signed in.
export async function supabaseAuth(serverUrl, sessionFile) {
  const fs = await import('node:fs');
  const { createClient } = await import('@supabase/supabase-js');
  const res = await fetch(`${String(serverUrl).replace(/\/+$/, '')}/api/config`);
  if (!res.ok) throw new Error(`The server at ${serverUrl} did not answer (${res.status}).`);
  const { supabaseUrl, supabaseAnonKey } = await res.json();
  const read = () => { try { return JSON.parse(fs.readFileSync(sessionFile, 'utf8')); } catch { return {}; } };
  const storage = {
    getItem: (k) => read()[k] ?? null,
    setItem: (k, v) => { const all = read(); all[k] = v; fs.writeFileSync(sessionFile, JSON.stringify(all), { mode: 0o600 }); },
    removeItem: (k) => { const all = read(); delete all[k]; fs.writeFileSync(sessionFile, JSON.stringify(all), { mode: 0o600 }); },
  };
  const sb = createClient(supabaseUrl, supabaseAnonKey, { auth: { storage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } });
  return {
    token: async () => (await sb.auth.getSession()).data.session?.access_token ?? null,
    signIn: async (email, password) => { const { error } = await sb.auth.signInWithPassword({ email, password }); if (error) throw new Error(error.message); },
    signOut: async () => { await sb.auth.signOut(); },
  };
}
