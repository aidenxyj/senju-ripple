// The real store: Supabase for sign-in, teams, memory and history.
// Uses the service role key, so it runs only on the server. Same shape as store-memory.js.
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { slug } from '../src/skills.js';

const ok = ({ data, error }) => { if (error) throw new Error(error.message); return data; };

export class SupabaseStore {
  constructor({ url, serviceKey, encryptionSecret }) {
    if (!url || !serviceKey) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
    if (!encryptionSecret || encryptionSecret.length < 16) throw new Error('KEY_ENCRYPTION_SECRET must be at least 16 characters.');
    this.db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    this.key = crypto.scryptSync(encryptionSecret, 'cursor-swarm-api-keys', 32);
  }

  // ---- People --------------------------------------------------------------------------
  async verifyToken(token) {
    if (!token) return null;
    const { data, error } = await this.db.auth.getUser(token);
    if (error || !data?.user) return null;
    const profile = ok(await this.db.from('profiles').select('name').eq('id', data.user.id).maybeSingle());
    return { id: data.user.id, email: data.user.email, name: profile?.name ?? data.user.email?.split('@')[0] ?? 'Someone' };
  }

  async teamOf(userId) {
    const mine = ok(await this.db.from('team_members').select('team_id, teams(id, name)').eq('user_id', userId).order('joined_at').limit(1));
    const team = mine?.[0]?.teams;
    if (!team) return null;
    const members = ok(await this.db.from('team_members').select('user_id, profiles(name)').eq('team_id', team.id));
    return { id: team.id, name: team.name, members: members.map((m) => ({ id: m.user_id, name: m.profiles?.name ?? 'Someone' })) };
  }

  async upsertDevice({ id, userId, teamId, name, platform }) {
    ok(await this.db.from('devices').upsert({ id, user_id: userId, team_id: teamId, name, platform, last_seen: new Date().toISOString() }));
  }

  // ---- API keys: AES-256-GCM, so the database never holds a usable key ---------------------
  encrypt(text) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), body].map((b) => b.toString('base64')).join('.');
  }
  decrypt(packed) {
    const [iv, tag, body] = packed.split('.').map((p) => Buffer.from(p, 'base64'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  }
  async getKey(userId) {
    const row = ok(await this.db.from('user_secrets').select('api_key_enc').eq('user_id', userId).maybeSingle());
    return row ? this.decrypt(row.api_key_enc) : null;
  }
  async setKey(userId, key) {
    ok(await this.db.from('user_secrets').upsert({ user_id: userId, api_key_enc: this.encrypt(key), updated_at: new Date().toISOString() }));
  }
  async deleteKey(userId) { ok(await this.db.from('user_secrets').delete().eq('user_id', userId)); }

  // ---- Sessions and chat ----------------------------------------------------------------------
  async createSession({ id, teamId, ownerId, goal }) {
    ok(await this.db.from('sessions').insert({ id, team_id: teamId, owner_id: ownerId, goal, title: String(goal).slice(0, 80), participants: [ownerId] }));
  }

  // ---- Session history: turns, events, and the lead's conversation for continuing ------------------
  async startTurn(id, turn) {
    const row = ok(await this.db.from('sessions').select('turns').eq('id', id).single());
    ok(await this.db.from('sessions').update({ turns: [...(row.turns ?? []), { ...turn, status: 'running' }], status: 'running', goal: turn.goal, ended_at: null }).eq('id', id));
  }
  async finishTurn(id, { participants = [], ...turn }) {
    const row = ok(await this.db.from('sessions').select('turns, participants').eq('id', id).single());
    const turns = (row.turns ?? []).map((t, i, all) => i === all.length - 1 ? { ...t, ...turn } : t);
    ok(await this.db.from('sessions').update({ turns, participants: [...new Set([...(row.participants ?? []), ...participants])] }).eq('id', id));
  }
  async saveLeadCtx(id, messages) {
    ok(await this.db.from('session_contexts').upsert({ session_id: id, messages, updated_at: new Date().toISOString() }));
  }
  async getLeadCtx(id) {
    return ok(await this.db.from('session_contexts').select('messages').eq('session_id', id).maybeSingle())?.messages ?? null;
  }
  async appendEvents(id, rows) {
    if (rows.length) ok(await this.db.from('session_events').insert(rows.map((r) => ({ session_id: id, turn: r.turn, seq: r.seq, at: r.at, audience: r.audience, event: r.event }))));
  }
  async listEvents(id) {
    const out = [];
    for (let from = 0; ; from += 1000) {   // PostgREST pages at 1000 rows
      const page = ok(await this.db.from('session_events').select('turn, seq, at, audience, event').eq('session_id', id).order('turn').order('seq').range(from, from + 999));
      out.push(...page);
      if (page.length < 1000) return out;
    }
  }
  async getSession(id) {
    const row = ok(await this.db.from('sessions').select(SESSION_COLUMNS).eq('id', id).maybeSingle());
    return row ? sessionRow(row) : null;
  }
  async listSessions(teamId, limit = 100) {
    return ok(await this.db.from('sessions').select(SESSION_COLUMNS).eq('team_id', teamId).order('started_at', { ascending: false }).limit(limit)).map(sessionRow);
  }
  async renameSession(id, title) { ok(await this.db.from('sessions').update({ title: String(title).slice(0, 120) }).eq('id', id)); }
  async deleteSession(id) { ok(await this.db.from('sessions').delete().eq('id', id)); }
  async endSession(id, { status, summary, usage, billing = null, costMicro = null }) {
    ok(await this.db.from('sessions').update({ status, summary, usage, billing, cost_micro: costMicro, ended_at: new Date().toISOString() }).eq('id', id));
  }
  async addMessage({ sessionId, authorId, target, text }) {
    ok(await this.db.from('messages').insert({ session_id: sessionId, author_id: authorId, target, text }));
  }

  // ---- Skills: team memory, each revision attributed to one person -------------------------------
  async listSkills(teamId) {
    return ok(await this.db.from('memories').select('name, description').eq('team_id', teamId).eq('kind', 'skill').order('name'));
  }
  async readSkill(teamId, name) {
    const row = ok(await this.db.from('memories').select('name, description, body').eq('team_id', teamId).eq('kind', 'skill').eq('name', slug(name)).maybeSingle());
    return row ?? null;
  }
  async saveSkill(teamId, { name, description, body }, authorId, sessionId) {
    const id = slug(name);
    if (!id) throw new Error('A skill needs a name made of letters, digits and dashes.');
    const text = String(body ?? '').trim().slice(0, 8000);
    if (text.length < 40) throw new Error('The skill body is too short to be useful.');
    const desc = String(description ?? '').replace(/\s+/g, ' ').trim().slice(0, 240);
    const old = ok(await this.db.from('memories').select('id, revision, author_id, description, body').eq('team_id', teamId).eq('kind', 'skill').eq('name', id).maybeSingle());
    if (!old) {
      ok(await this.db.from('memories').insert({ kind: 'skill', scope: 'team', team_id: teamId, author_id: authorId, session_id: sessionId, name: id, description: desc, body: text }));
      return { name: id, description: desc, created: true, revision: 1 };
    }
    ok(await this.db.from('memory_revisions').insert({ memory_id: old.id, revision: old.revision, author_id: old.author_id, description: old.description, body: old.body }));
    ok(await this.db.from('memories').update({ description: desc, body: text, revision: old.revision + 1, author_id: authorId, session_id: sessionId, updated_at: new Date().toISOString() }).eq('id', old.id));
    return { name: id, description: desc, created: false, revision: old.revision + 1 };
  }

  // ---- Notes: what people said they want remembered ---------------------------------------------
  async memoryNotes(teamId, userIds) {
    const rows = ok(await this.db.from('memories')
      .select('scope, subject_id, body, subject:profiles!memories_subject_id_fkey(name), author:profiles!memories_author_id_fkey(name)')
      .eq('team_id', teamId).eq('kind', 'note').order('created_at').limit(200));
    return rows
      .filter((m) => m.scope === 'team' || userIds.includes(m.subject_id))
      .map((m) => ({ scope: m.scope, subjectId: m.subject_id, subjectName: m.subject?.name ?? 'Someone', authorName: m.author?.name ?? 'Someone', note: m.body }));
  }
  // ---- Billing: one balance per person, every change written to a ledger -----------------------
  async getBilling(userId) {
    const row = ok(await this.db.from('billing_accounts').select('stripe_customer_id, subscription_id, status, period_end, credits_micro').eq('user_id', userId).maybeSingle());
    return { credits: Number(row?.credits_micro ?? 0), status: row?.status ?? 'none', customerId: row?.stripe_customer_id ?? null, subscriptionId: row?.subscription_id ?? null, periodEnd: row?.period_end ?? null };
  }
  async setBilling(userId, { status, customerId, subscriptionId, periodEnd }) {
    const patch = { user_id: userId, updated_at: new Date().toISOString() };
    if (status !== undefined) patch.status = status;
    if (customerId !== undefined) patch.stripe_customer_id = customerId;
    if (subscriptionId !== undefined) patch.subscription_id = subscriptionId;
    if (periodEnd !== undefined) patch.period_end = periodEnd;
    ok(await this.db.from('billing_accounts').upsert(patch));
  }
  async userByCustomer(customerId) {
    const row = ok(await this.db.from('billing_accounts').select('user_id').eq('stripe_customer_id', customerId).maybeSingle());
    return row?.user_id ?? null;
  }
  // The balance change and its ledger line happen together in the database (see apply_credit in schema.sql).
  async applyCredit({ userId, deltaMicro, kind, sessionId = null, eventId = null, note = '' }) {
    return Number(ok(await this.db.rpc('apply_credit', { p_user: userId, p_delta: deltaMicro, p_kind: kind, p_session: sessionId, p_event: eventId, p_note: note })));
  }

  async addMemory({ scope, teamId, subjectId, authorId, sessionId, note }) {
    ok(await this.db.from('memories').insert({ kind: 'note', scope, team_id: teamId, subject_id: subjectId, author_id: authorId, session_id: sessionId, body: note }));
  }

  // ---- Managing skills and memory (control page, desktop panel) ------------------------------------
  async skillDetails(teamId) {
    const rows = ok(await this.db.from('memories').select('name, description, body, revision, author:profiles!memories_author_id_fkey(name)').eq('team_id', teamId).eq('kind', 'skill').order('name'));
    return rows.map((r) => ({ name: r.name, description: r.description, body: r.body, revision: r.revision, authorName: r.author?.name ?? null }));
  }
  async deleteSkill(teamId, name) {
    return ok(await this.db.from('memories').delete().eq('team_id', teamId).eq('kind', 'skill').eq('name', slug(name)).select('id')).length > 0;
  }
  async listMemories(teamId, userId) {
    const rows = ok(await this.db.from('memories')
      .select('id, scope, subject_id, body, created_at, subject:profiles!memories_subject_id_fkey(name), author:profiles!memories_author_id_fkey(name)')
      .eq('team_id', teamId).eq('kind', 'note').order('created_at', { ascending: false }).limit(300));
    return rows.filter((m) => m.scope === 'team' || m.subject_id === userId)
      .map((m) => ({ id: m.id, scope: m.scope, note: m.body, subjectName: m.subject?.name ?? 'Someone', authorName: m.author?.name ?? 'Someone', at: m.created_at }));
  }
  async deleteMemory(teamId, userId, id) {
    const row = ok(await this.db.from('memories').select('id, scope, subject_id').eq('id', id).eq('team_id', teamId).eq('kind', 'note').maybeSingle());
    if (!row || (row.scope !== 'team' && row.subject_id !== userId)) return false;
    ok(await this.db.from('memories').delete().eq('id', id));
    return true;
  }

  // ---- Team management --------------------------------------------------------------------------
  async teamDetails(teamId) {
    const team = ok(await this.db.from('teams').select('id, name, invite_code').eq('id', teamId).maybeSingle());
    if (!team) return null;
    const members = ok(await this.db.from('team_members').select('user_id, role, joined_at, profiles(name)').eq('team_id', teamId).order('joined_at'));
    return {
      id: team.id, name: team.name, inviteCode: team.invite_code,
      ownerId: members.find((m) => m.role === 'owner')?.user_id ?? null,
      members: members.map((m) => ({ id: m.user_id, name: m.profiles?.name ?? 'Someone', role: m.role })),
    };
  }
  async renameTeam(teamId, name) { ok(await this.db.from('teams').update({ name: String(name).slice(0, 80) }).eq('id', teamId)); }
  async regenerateInvite(teamId) {
    const code = crypto.randomBytes(6).toString('hex');
    ok(await this.db.from('teams').update({ invite_code: code }).eq('id', teamId));
    return code;
  }
  async removeMember(teamId, userId) { ok(await this.db.from('team_members').delete().eq('team_id', teamId).eq('user_id', userId)); }
}

const SESSION_COLUMNS = 'id, team_id, owner_id, title, goal, status, summary, turns, participants, started_at, ended_at, cost_micro, owner:profiles!sessions_owner_id_fkey(name)';
function sessionRow(r) {
  return { id: r.id, teamId: r.team_id, ownerId: r.owner_id, ownerName: r.owner?.name ?? 'Someone', title: r.title ?? String(r.goal ?? '').slice(0, 80), goal: r.goal, status: r.status, summary: r.summary, turns: r.turns ?? [], participants: r.participants ?? [], startedAt: r.started_at, endedAt: r.ended_at, costMicro: r.cost_micro };
}
