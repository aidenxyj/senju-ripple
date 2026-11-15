// Personal sessions, kept on this Mac: one folder per session.
//
//   <dir>/<id>/session.json   { id, title, created, updated, status, turns: [{ goal, started, ended, status, summary, usage }] }
//   <dir>/<id>/events.jsonl   what happened, one event per line, each tagged with its turn
//   <dir>/<id>/lead.json      the lead's conversation after the last turn, so the session can be continued
//
// A session is a thread of turns, like a chat. Continuing it adds a turn and resumes the lead.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Not worth keeping: cursor motion, window positions, running totals (the last total is saved with the turn).
const UNSAVED = new Set(['point', 'cursor', 'targets', 'usage', 'reset', 'summon', 'mode', 'account', 'need_key', 'key_saved', 'presence', 'consent']);

export class SessionStore {
  constructor(dir) {
    this.dir = dir;
  }

  folder(id) {
    if (!/^[a-z0-9-]{8,64}$/.test(String(id))) throw new Error('Not a session id.');
    return path.join(this.dir, id);
  }
  read(id, file, fallback = null) {
    try { return JSON.parse(fs.readFileSync(path.join(this.folder(id), file), 'utf8')); } catch { return fallback; }
  }
  write(id, file, value) {
    const dir = this.folder(id);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.${file}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(tmp, path.join(dir, file));
  }

  create(goal) {
    const now = new Date().toISOString();
    const meta = { id: crypto.randomUUID(), title: String(goal).replace(/\s+/g, ' ').trim().slice(0, 80) || 'New session', created: now, updated: now, status: 'idle', turns: [] };
    this.write(meta.id, 'session.json', meta);
    return meta;
  }

  get(id) { this.folder(id); return this.read(id, 'session.json'); }   // folder() refuses anything but an id

  list() {
    let ids = [];
    try { ids = fs.readdirSync(this.dir); } catch { return []; }
    return ids.map((id) => { try { return this.get(id); } catch { return null; } })
      .filter(Boolean)
      .sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
  }

  startTurn(id, goal) {
    const meta = this.get(id);
    if (!meta) throw new Error('No such session.');
    const now = new Date().toISOString();
    meta.turns.push({ goal, started: now, ended: null, status: 'running', summary: null, usage: null });
    meta.status = 'running';
    meta.updated = now;
    this.write(id, 'session.json', meta);
    return meta.turns.length - 1;
  }

  finishTurn(id, { status, summary = null, usage = null }) {
    const meta = this.get(id);
    if (!meta?.turns.length) return;
    const now = new Date().toISOString();
    Object.assign(meta.turns.at(-1), { ended: now, status, summary, usage });
    meta.status = status;
    meta.updated = now;
    this.write(id, 'session.json', meta);
  }

  // Keep an event for the session's history. Returns false for events that are not kept.
  appendEvent(id, turn, event) {
    if (!event || UNSAVED.has(event.type)) return false;
    fs.mkdirSync(this.folder(id), { recursive: true });
    fs.appendFileSync(path.join(this.folder(id), 'events.jsonl'), `${JSON.stringify({ turn, at: new Date().toISOString(), event })}\n`, { mode: 0o600 });
    return true;
  }

  events(id) {
    let text = '';
    try { text = fs.readFileSync(path.join(this.folder(id), 'events.jsonl'), 'utf8'); } catch { return []; }
    return text.split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  }

  saveLead(id, messages) { if (messages?.length) this.write(id, 'lead.json', messages); }
  lead(id) { return this.read(id, 'lead.json'); }

  rename(id, title) {
    const meta = this.get(id);
    if (!meta) return;
    meta.title = String(title).trim().slice(0, 120) || meta.title;
    this.write(id, 'session.json', meta);
  }

  remove(id) { fs.rmSync(this.folder(id), { recursive: true, force: true }); }

  // A session the app was closed in the middle of: mark its open turn as interrupted.
  recover() {
    for (const meta of this.list()) {
      if (meta.status !== 'running') continue;
      const turn = meta.turns.at(-1);
      if (turn && !turn.ended) Object.assign(turn, { ended: meta.updated, status: 'stopped', summary: turn.summary ?? 'Senju was closed before this finished.' });
      meta.status = 'stopped';
      this.write(meta.id, 'session.json', meta);
    }
  }
}
