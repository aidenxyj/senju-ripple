// An in-memory store with the same shape as the Supabase one. Used by the tests, and
// handy for trying the hub locally: tokens are just "user:<id>".
import { slug } from '../src/skills.js';
import { parseSaved, serialize } from './models.js';

export class MemoryStore {
  constructor() {
    this.users = new Map();      // id -> { id, name, email }
    this.teams = new Map();      // id -> { id, name, members: Set<userId> }
    this.secrets = new Map();   // userId -> the stored string: model settings as JSON (or, from before, a bare key)
    this.devices = new Map();
    this.sessions = new Map();
    this.messages = [];
    this.skills = new Map();     // `${teamId}/${name}` -> { name, description, body, revision, authorId, history: [] }
    this.memories = [];
    this.billing = new Map();    // userId -> { credits, status, customerId, subscriptionId, periodEnd }
    this.ledger = [];            // { userId, deltaMicro, kind, sessionId, eventId, note }
    this.events = new Map();     // sessionId -> [{ turn, seq, at, audience, event }]
    this.leadCtx = new Map();    // sessionId -> the lead's saved conversation
  }

  addUser(id, name, teamId = null) { this.users.set(id, { id, name, email: `${id}@example.com` }); if (teamId) this.join(id, teamId); return `user:${id}`; }
  addTeam(id, name) { this.teams.set(id, { id, name, members: new Set(), owner: null, invite: `inv-${id}` }); }
  join(userId, teamId) { const t = this.teams.get(teamId); t.members.add(userId); t.owner ??= userId; }

  async verifyToken(token) { const m = /^user:(.+)$/.exec(String(token ?? '')); return m ? this.users.get(m[1]) ?? null : null; }
  async teamOf(userId) {
    const t = [...this.teams.values()].find((x) => x.members.has(userId));
    return t ? { id: t.id, name: t.name, members: [...t.members].map((id) => ({ id, name: this.users.get(id).name })) } : null;
  }
  async upsertDevice(d) { this.devices.set(d.id, d); }
  // A person's own model settings, { baseUrl, model, apiKey }, or null. Stored as a string, like the Supabase store.
  async getModel(userId) { return parseSaved(this.secrets.get(userId)); }
  async setModel(userId, settings) { this.secrets.set(userId, serialize(settings)); }
  async deleteModel(userId) { this.secrets.delete(userId); }
  async createSession(s) { this.sessions.set(s.id, { ...s, title: String(s.goal ?? '').slice(0, 80), status: 'running', turns: [], participants: [s.ownerId], startedAt: new Date().toISOString(), endedAt: null }); }
  async endSession(id, patch) { Object.assign(this.sessions.get(id), patch, { endedAt: new Date().toISOString() }); }

  // ---- Session history ---------------------------------------------------------------------
  async startTurn(id, turn) { const s = this.sessions.get(id); s.turns = [...s.turns, { ...turn, status: 'running' }]; s.status = 'running'; s.goal = turn.goal; s.endedAt = null; }
  async finishTurn(id, { participants, ...turn }) {
    const s = this.sessions.get(id);
    s.turns = s.turns.map((t, i) => i === s.turns.length - 1 ? { ...t, ...turn } : t);
    s.participants = [...new Set([...(s.participants ?? []), ...(participants ?? [])])];
  }
  async saveLeadCtx(id, messages) { this.leadCtx.set(id, messages); }
  async getLeadCtx(id) { return this.leadCtx.get(id) ?? null; }
  async appendEvents(id, rows) { this.events.set(id, [...(this.events.get(id) ?? []), ...rows]); }
  async listEvents(id) { return [...(this.events.get(id) ?? [])].sort((a, b) => a.turn - b.turn || a.seq - b.seq); }
  async getSession(id) { const s = this.sessions.get(id); return s ? this.row(s) : null; }
  async listSessions(teamId, limit = 100) { return [...this.sessions.values()].filter((s) => s.teamId === teamId).map((s) => this.row(s)).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt))).slice(0, limit); }
  async renameSession(id, title) { this.sessions.get(id).title = String(title).slice(0, 120); }
  async deleteSession(id) { this.sessions.delete(id); this.events.delete(id); this.leadCtx.delete(id); }
  row(s) {
    const name = (id) => this.users.get(id)?.name ?? 'someone';
    return { id: s.id, teamId: s.teamId, ownerId: s.ownerId, ownerName: name(s.ownerId), title: s.title, goal: s.goal, status: s.status, summary: s.summary ?? null, turns: s.turns ?? [], participants: s.participants ?? [], startedAt: s.startedAt, endedAt: s.endedAt, costMicro: s.costMicro ?? null };
  }
  async addMessage(m) { this.messages.push(m); }

  async listSkills(teamId) { return [...this.skills].filter(([k]) => k.startsWith(`${teamId}/`)).map(([, v]) => ({ name: v.name, description: v.description })); }
  async readSkill(teamId, name) { const v = this.skills.get(`${teamId}/${slug(name)}`); return v ? { name: v.name, description: v.description, body: v.body } : null; }
  async saveSkill(teamId, { name, description, body }, authorId, sessionId) {
    const id = slug(name);
    if (!id) throw new Error('A skill needs a name made of letters, digits and dashes.');
    if (String(body ?? '').trim().length < 40) throw new Error('The skill body is too short to be useful.');
    const key = `${teamId}/${id}`;
    const old = this.skills.get(key);
    const row = { name: id, description: String(description ?? '').trim(), body: String(body).trim(), revision: (old?.revision ?? 0) + 1, authorId, sessionId, history: old ? [...old.history, { revision: old.revision, authorId: old.authorId, body: old.body }] : [] };
    this.skills.set(key, row);
    return { name: id, description: row.description, created: !old, revision: row.revision };
  }

  async memoryNotes(teamId, userIds) {
    const name = (id) => this.users.get(id)?.name ?? 'someone';
    return this.memories
      .filter((m) => m.teamId === teamId && (m.scope === 'team' || userIds.includes(m.subjectId)))
      .map((m) => ({ scope: m.scope, subjectId: m.subjectId, subjectName: name(m.subjectId), authorName: name(m.authorId), note: m.note }));
  }
  async addMemory(m) { this.memories.push({ id: `m${this.memories.length + 1}`, ...m, at: Date.now() }); }

  // ---- Managing skills and memory (control page, desktop panel) ------------------------------------
  async skillDetails(teamId) {
    return [...this.skills].filter(([k]) => k.startsWith(`${teamId}/`)).map(([, v]) => ({ name: v.name, description: v.description, body: v.body, revision: v.revision, authorName: this.users.get(v.authorId)?.name ?? null }));
  }
  async deleteSkill(teamId, name) { return this.skills.delete(`${teamId}/${slug(name)}`); }
  // Notes this person may see: the team's, and their own.
  async listMemories(teamId, userId) {
    const name = (id) => this.users.get(id)?.name ?? 'someone';
    return this.memories.filter((m) => m.teamId === teamId && (m.scope === 'team' || m.subjectId === userId))
      .map((m) => ({ id: m.id, scope: m.scope, note: m.note, subjectName: name(m.subjectId), authorName: name(m.authorId), at: m.at }));
  }
  async deleteMemory(teamId, userId, id) {
    const i = this.memories.findIndex((m) => m.id === id && m.teamId === teamId && (m.scope === 'team' || m.subjectId === userId));
    if (i < 0) return false;
    this.memories.splice(i, 1);
    return true;
  }

  // ---- Team management --------------------------------------------------------------------------
  async teamDetails(teamId) {
    const t = this.teams.get(teamId);
    return t ? { id: t.id, name: t.name, inviteCode: t.invite, ownerId: t.owner, members: [...t.members].map((id) => ({ id, name: this.users.get(id).name, role: id === t.owner ? 'owner' : 'member' })) } : null;
  }
  async renameTeam(teamId, name) { this.teams.get(teamId).name = String(name).slice(0, 80); }
  async regenerateInvite(teamId) { const t = this.teams.get(teamId); t.invite = `inv-${Math.random().toString(16).slice(2, 10)}`; return t.invite; }
  async removeMember(teamId, userId) { this.teams.get(teamId).members.delete(userId); }

  // ---- Billing ---------------------------------------------------------------------------
  account(userId) { if (!this.billing.has(userId)) this.billing.set(userId, { credits: 0, status: 'none', customerId: null, subscriptionId: null, periodEnd: null }); return this.billing.get(userId); }
  async getBilling(userId) { return { ...this.account(userId) }; }
  async setBilling(userId, patch) { Object.assign(this.account(userId), patch); }
  async userByCustomer(customerId) { return [...this.billing].find(([, b]) => b.customerId === customerId)?.[0] ?? null; }
  // Adds to (or takes from) a balance. An event id makes it safe to apply twice.
  async applyCredit({ userId, deltaMicro, kind, sessionId = null, eventId = null, note = '' }) {
    const b = this.account(userId);
    if (eventId && this.ledger.some((l) => l.eventId === eventId)) return b.credits;
    this.ledger.push({ userId, deltaMicro, kind, sessionId, eventId, note });
    b.credits += deltaMicro;
    return b.credits;
  }
}
