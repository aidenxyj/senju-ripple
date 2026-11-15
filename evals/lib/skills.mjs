// Task skills for the autoresearch loop. One folder per task, in the Agent Skills layout:
//
//   evals/skills/<task>/
//     SKILL.md          frontmatter (name, description) + the method; injected into the swarm's prompts
//     examples/*.md     optional: a shortened winning run, injected after the method
//     policy.json       optional: knobs for lib/policy.mjs (sampling, bestOf, prompt cuts, ...)
//     HISTORY.md        one line per generation, written by research/run.mjs
//
// skillSource() gives the swarm engine's Swarm a read-only { list, read, save } over these folders,
// so the lead's read_skill and spawn_agent.skills work exactly as they do in the app.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SKILLS_DIR = path.resolve(HERE, '..', 'skills');
export const PLACEHOLDER = '(No method yet. The autoresearch loop fills this in.)';

const slug = (name) => String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);

/** Splits a SKILL.md into its frontmatter fields and its body. */
export function parseSkill(text) {
  const m = String(text).match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: String(text).trim() };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-zA-Z_-]+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  return { meta, body: m[2].trim() };
}

/** True when a skill body holds an actual method (not empty, not the placeholder). */
export const hasMethod = (body) => Boolean(body && body.trim() && body.trim() !== PLACEHOLDER);

/** Reads one skill folder: { dir, name, description, body, examples, policy }. Throws if SKILL.md is missing. */
export function loadSkill(dir) {
  const file = path.join(dir, 'SKILL.md');
  if (!fs.existsSync(file)) throw new Error(`no SKILL.md in ${dir}`);
  const { meta, body } = parseSkill(fs.readFileSync(file, 'utf8'));
  const exDir = path.join(dir, 'examples');
  const examples = fs.existsSync(exDir)
    ? fs.readdirSync(exDir).filter((f) => f.endsWith('.md')).sort().map((f) => fs.readFileSync(path.join(exDir, f), 'utf8').trim()).filter(Boolean)
    : [];
  const policyFile = path.join(dir, 'policy.json');
  const policy = fs.existsSync(policyFile) ? JSON.parse(fs.readFileSync(policyFile, 'utf8')) : {};
  return { dir, name: slug(meta.name || path.basename(dir)), description: meta.description ?? '', body, examples, policy };
}

/** A read-only skills source for the Swarm over the given skill folders. */
export function skillSource(dirs) {
  const load = () => dirs.map((d) => loadSkill(d)).filter((s) => hasMethod(s.body));
  return {
    async list() { return load().map((s) => ({ name: s.name, description: s.description, uses: 0 })); },
    async read(name) {
      const s = load().find((k) => k.name === slug(name));
      return s ? { name: s.name, description: s.description, body: s.body } : null;
    },
    async save() { throw new Error('Skills are read-only during an eval run.'); },
  };
}

/** Creates evals/skills/<task>/ (or `dir`) with an empty method, unless it exists. Returns the folder. */
export function initSkill(task, { root = SKILLS_DIR, dir = path.join(root, task.id), description } = {}) {
  if (fs.existsSync(path.join(dir, 'SKILL.md'))) return dir;
  fs.mkdirSync(path.join(dir, 'examples'), { recursive: true });
  const desc = description ?? defaultDescription(task);
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${task.id}\ndescription: ${desc}\n---\n\n${PLACEHOLDER}\n`);
  fs.writeFileSync(path.join(dir, 'policy.json'), '{}\n');
  fs.writeFileSync(path.join(dir, 'HISTORY.md'), `# ${task.id}: generations\n\n| gen | seeds | score | passes | verdict | change |\n| --- | --- | --- | --- | --- | --- |\n`);
  return dir;
}

/** A description the app's lead can match a goal against: the goal's opening words, with {placeholders} removed. */
export function defaultDescription(task) {
  const goal = typeof task.goal === 'string' ? task.goal : '';
  const first = goal.replace(/\{\w+\}/g, '').replace(/\s+/g, ' ').split(/(?<=[.!?])\s/)[0]?.trim().slice(0, 160);
  return first ? `Use for goals like: "${first}" The tested method, its traps, and how to check the work.` : `How to do the ${task.id} task reliably.`;
}

/**
 * Writes a skill folder as one flat <name>.md in the swarm engine's skills format, the way app/ reads its skills folder
 * (app/skills/ when run from source). Examples are appended under "## Worked example". Returns the file written.
 */
export function exportSkill(dir, toDir) {
  const s = loadSkill(dir);
  if (!hasMethod(s.body)) throw new Error(`${dir} has no method yet: nothing to export`);
  const examples = s.examples.length ? `\n\n## Worked example\nAn earlier run that succeeded. Your names and values are different: use the ones in your goal.\n\n${s.examples.join('\n\n---\n\n')}` : '';
  fs.mkdirSync(toDir, { recursive: true });
  const file = path.join(toDir, `${s.name}.md`);
  const old = fs.existsSync(file) ? parseSkill(fs.readFileSync(file, 'utf8')).meta : {};
  const revision = Number(old.revision ?? 0) + 1;
  fs.writeFileSync(file, `---\nname: ${s.name}\ndescription: ${s.description.replace(/\n/g, ' ')}\nrevision: ${revision}\nupdated: ${new Date().toISOString().slice(0, 10)}\n---\n\n${s.body}${examples}\n`);
  return file;
}
