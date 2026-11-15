// Personal memory, kept on this Mac: short notes the lead should know about you in every session.
// Same adapter shape the team server gives the swarm ({ notes, remember }), plus what the panel needs.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MAX_NOTES = 200;

export class LocalMemory {
  constructor(file) {
    this.file = file;
  }

  list() {
    try {
      const rows = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return Array.isArray(rows) ? rows : [];
    } catch { return []; }
  }

  save(rows) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(rows.slice(-MAX_NOTES), null, 2), { mode: 0o600 });
  }

  add(note, source = 'you') {
    const text = String(note ?? '').replace(/\s+/g, ' ').trim().slice(0, 600);
    if (!text) throw new Error('The note is empty.');
    const row = { id: crypto.randomUUID(), note: text, source, at: new Date().toISOString() };
    this.save([...this.list(), row]);
    return row;
  }

  update(id, note) {
    const text = String(note ?? '').replace(/\s+/g, ' ').trim().slice(0, 600);
    if (!text) throw new Error('The note is empty.');
    this.save(this.list().map((r) => r.id === id ? { ...r, note: text, at: new Date().toISOString() } : r));
  }

  remove(id) { this.save(this.list().filter((r) => r.id !== id)); }

  // ---- The swarm's adapter ----
  async notes() { return this.list().map((r) => `- ${r.note}`).join('\n'); }
  async remember({ note }) {
    try { this.add(note, 'lead'); } catch (err) { return `Not remembered: ${err.message}`; }
    return 'Remembered. It will be in your notes for every session on this Mac.';
  }
}
