// Skills: short how-to notes the lead writes after a job, so the next job starts smarter.
// One markdown file per skill in the skills folder, with a small frontmatter header.
// They are plain files: read them, edit them, or delete them freely.
import fs from 'node:fs';
import path from 'node:path';

const MAX_BODY = 8000;

export const slug = (name) => String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);

function parse(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text.trim() };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-z_]+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  return { meta, body: m[2].trim() };
}

export function listSkills(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort().map((f) => {
    const { meta } = parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    return { name: f.slice(0, -3), description: meta.description ?? '', uses: Number(meta.uses ?? 0) };
  });
}

export function readSkill(dir, name) {
  const file = path.join(dir ?? '', `${slug(name)}.md`);
  if (!dir || !slug(name) || !fs.existsSync(file)) return null;
  const { meta, body } = parse(fs.readFileSync(file, 'utf8'));
  return { name: slug(name), description: meta.description ?? '', body };
}

// Create or replace a skill. The previous version is kept under .history/.
export function saveSkill(dir, { name, description, body }) {
  const id = slug(name);
  if (!dir || !id) throw new Error('A skill needs a name made of letters, digits and dashes.');
  const text = String(body ?? '').trim();
  if (text.length < 40) throw new Error('The skill body is too short to be useful.');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.md`);
  const existed = fs.existsSync(file);
  let revision = 1;
  if (existed) {
    const old = fs.readFileSync(file, 'utf8');
    revision = Number(parse(old).meta.revision ?? 1) + 1;
    const history = path.join(dir, '.history');
    fs.mkdirSync(history, { recursive: true });
    fs.writeFileSync(path.join(history, `${id}-r${revision - 1}.md`), old);
  }
  const desc = String(description ?? '').replace(/\s+/g, ' ').trim().slice(0, 240);
  fs.writeFileSync(file, `---\nname: ${id}\ndescription: ${desc}\nrevision: ${revision}\nupdated: ${new Date().toISOString().slice(0, 10)}\n---\n\n${text.slice(0, MAX_BODY)}\n`);
  return { name: id, description: desc, created: !existed, revision };
}

// Everything about every skill, for the skills panel.
export function skillDetails(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort().map((f) => {
    const { meta, body } = parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    return { name: f.slice(0, -3), description: meta.description ?? '', body, revision: Number(meta.revision ?? 1), updated: meta.updated ?? null };
  });
}

// Remove a skill. Its last version is kept under .history/, like an edit.
export function deleteSkill(dir, name) {
  const id = slug(name);
  const file = path.join(dir ?? '', `${id}.md`);
  if (!dir || !id || !fs.existsSync(file)) return false;
  const history = path.join(dir, '.history');
  fs.mkdirSync(history, { recursive: true });
  fs.renameSync(file, path.join(history, `${id}-deleted-${Date.now()}.md`));
  return true;
}
