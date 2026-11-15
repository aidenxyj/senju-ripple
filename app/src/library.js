// What the launcher shows besides a live job: past sessions, skills and notes.
// Personal mode reads files on this Mac; team mode asks the hub's HTTP API with the signed-in token.
// Both answer in the same shapes, so the launcher does not care which it is talking to.
import { skillDetails, saveSkill, deleteSkill } from './skills.js';

export class LocalLibrary {
  constructor({ sessions, memory, skillsDir }) {
    this.store = sessions;
    this.memory = memory;
    this.skillsDir = skillsDir;
  }

  async sessions() {
    return this.store.list().map((s) => ({
      id: s.id, title: s.title, status: s.status, startedAt: s.created, updatedAt: s.updated,
      turnCount: s.turns.length, lastSummary: s.turns.at(-1)?.summary ?? null, live: s.status === 'running',
    }));
  }
  async session(id) {
    const meta = this.store.get(id);
    if (!meta) throw new Error('That session is gone.');
    return { session: { ...meta, participant: true, canManage: true, results: true }, events: this.store.events(id) };
  }
  async rename(id, title) { this.store.rename(id, title); }
  async remove(id) { this.store.remove(id); }

  async skills() { return skillDetails(this.skillsDir); }
  async saveSkill(skill) { return saveSkill(this.skillsDir, skill); }
  async deleteSkill(name) { return deleteSkill(this.skillsDir, name); }

  async notes() { return this.memory.list().map((r) => ({ id: r.id, scope: 'user', note: r.note, authorName: r.source === 'lead' ? 'the lead' : 'you', at: r.at })).reverse(); }
  async addNote(note) { this.memory.add(note); }
  async deleteNote(id) { this.memory.remove(id); }
}

export class TeamLibrary {
  constructor({ url, token }) {
    this.url = String(url).replace(/\/+$/, '');
    this.token = token;   // async () => access token or null
  }

  async api(method, path, body) {
    const token = await this.token();
    if (!token) throw new Error('Sign in to your team first.');
    const res = await fetch(`${this.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `The team server answered ${res.status}.`);
    return data;
  }

  async sessions() {
    return (await this.api('GET', '/api/sessions')).sessions.map((s) => ({ ...s, updatedAt: s.endedAt ?? s.startedAt }));
  }
  async session(id) {
    const { session, events } = await this.api('GET', `/api/sessions/${encodeURIComponent(id)}`);
    return { session: { ...session, results: false }, events };
  }
  async rename(id, title) { await this.api('PATCH', `/api/sessions/${encodeURIComponent(id)}`, { title }); }
  async remove(id) { await this.api('DELETE', `/api/sessions/${encodeURIComponent(id)}`); }

  async skills() { return (await this.api('GET', '/api/skills')).skills; }
  async saveSkill({ name, description, body }) { return this.api('PUT', `/api/skills/${encodeURIComponent(name)}`, { description, body }); }
  async deleteSkill(name) { return (await this.api('DELETE', `/api/skills/${encodeURIComponent(name)}`)).ok; }

  async notes() { return (await this.api('GET', '/api/memory')).notes; }
  async addNote(note, scope = 'me') { await this.api('POST', '/api/memory', { note, scope }); }
  async deleteNote(id) { await this.api('DELETE', `/api/memory/${encodeURIComponent(id)}`); }
}
