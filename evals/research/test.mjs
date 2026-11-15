// Self-test for the autoresearch loop: policy, skills, keep/revert, and one full generation on the scripted
// stub and noop models (no API keys).   node evals/research/test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyPolicy, dropSection, pickBest } from '../lib/policy.mjs';
import { initSkill, loadSkill, skillSource, exportSkill, defaultDescription, PLACEHOLDER } from '../lib/skills.mjs';
import { readSkill as protoReadSkill, listSkills as protoListSkills } from '../../app/src/skills.js';
import { decide, runGeneration, readLedger, seedsFor } from './run.mjs';
import { scoreOf } from '../run.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'senju-research-test-'));
const sys = (text) => [{ type: 'text', text }];
const WORKER = 'You are "Solver", one agent.\n\n# How to work\n- act\n\n# Steps only the user can do\nSign in.\n## detail\nmore\n\n# Messages while you work\nreply';
const leadTools = [{ name: 'spawn_agent', input_schema: { type: 'object' } }];

// 1. Policy: sections dropped, playbook and examples injected where asked, tool text and sampling applied.
{
  assert.equal(dropSection(WORKER, '# Steps only the user can do'), 'You are "Solver", one agent.\n\n# How to work\n- act\n\n# Messages while you work\nreply');
  assert.equal(dropSection(WORKER, '# Not there'), WORKER);
  const skill = { body: '1. Open the page.\n2. Fill the form.', examples: ['EXAMPLE RUN'] };
  const w = applyPolicy({ system: sys(WORKER), messages: [], tools: [{ name: 'sh', description: 'old' }] },
    { skill, policy: { worker: { drop: ['# Steps only the user can do'], append: 'ONE CALL PER TURN' }, tools: { sh: 'new' }, sampling: { temperature: 0.2 } } });
  const wt = w.system[0].text;
  assert.ok(wt.includes('# Playbook for this task') && wt.includes('2. Fill the form.'));
  assert.ok(wt.includes('EXAMPLE RUN') && wt.includes('ONE CALL PER TURN') && !wt.includes('Sign in.'));
  assert.equal(w.tools[0].description, 'new');
  assert.equal(w.temperature, 0.2);
  const l = applyPolicy({ system: sys('You lead.'), messages: [], tools: leadTools }, { skill, policy: {} });
  assert.ok(l.system[0].text.includes('# Playbook for this task'), 'the lead gets the playbook by default');
  assert.ok(!l.system[0].text.includes('EXAMPLE RUN'), 'examples go to workers only by default');
  const none = applyPolicy({ system: sys('You lead.'), messages: [], tools: leadTools }, { skill: { body: PLACEHOLDER, examples: [] } });
  assert.equal(none.system[0].text, 'You lead.', 'an empty skill adds nothing');
}

// 2. Best-of-N keeps the first reply whose tool calls are valid.
{
  const tools = [{ name: 'sh', input_schema: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] } }];
  const bad = { content: [{ type: 'tool_use', name: 'sh', input: { _raw: '{"cmd": ' } }] };
  const unknown = { content: [{ type: 'tool_use', name: 'bash', input: { cmd: 'ls' } }] };
  const good = { content: [{ type: 'tool_use', name: 'sh', input: { cmd: 'senju look' } }] };
  assert.equal(pickBest([bad, unknown, good], tools), good);
  assert.equal(pickBest([{ content: [{ type: 'text', text: 'hi' }] }, bad], tools), bad);
}

// 3. Skills: a folder with only the placeholder lists nothing; a written method is listed and readable.
{
  const dir = initSkill({ id: 'demo-task' }, { root: tmp });
  assert.deepEqual(await skillSource([dir]).list(), []);
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: demo-task\ndescription: Do the demo task.\n---\n\nStep one.\n');
  const src = skillSource([dir]);
  assert.deepEqual(await src.list(), [{ name: 'demo-task', description: 'Do the demo task.', uses: 0 }]);
  assert.equal((await src.read('Demo Task')).body, 'Step one.');
  await assert.rejects(src.save({ name: 'x', body: 'y' }));
  assert.deepEqual(loadSkill(dir).policy, {});
  const custom = initSkill({ id: 'demo-task' }, { dir: path.join(tmp, 'elsewhere', 'my-skill') });
  assert.ok(fs.existsSync(path.join(custom, 'SKILL.md')), 'a named folder that does not exist yet is created');
}

// 3b. Export: the app's skills folder reads the exported file with the swarm engine's own reader.
{
  const dir = initSkill({ id: 'bomb-defusal', goal: 'Co-op bomb defusal. A bomb is armed at {bombUrl}, and its manual is at {manualUrl}.' }, { root: path.join(tmp, 'exp') });
  assert.match(loadSkill(dir).description, /^Use for goals like: "Co-op bomb defusal\."/);
  assert.equal(defaultDescription({ id: 'x', goal: () => 'dynamic' }), 'How to do the x task reliably.');
  assert.throws(() => exportSkill(dir, path.join(tmp, 'app-skills')), /no method yet/);
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: bomb-defusal\ndescription: Use for co-op bomb defusal.\n---\n\n## Lead plan\nTwo workers.\n');
  fs.writeFileSync(path.join(dir, 'examples', 'win.md'), 'senju look\nsenju click <wire>');
  const appDir = path.join(tmp, 'app-skills');
  exportSkill(dir, appDir);
  const file = exportSkill(dir, appDir);
  assert.equal(path.basename(file), 'bomb-defusal.md');
  assert.deepEqual(protoListSkills(appDir), [{ name: 'bomb-defusal', description: 'Use for co-op bomb defusal.', uses: 0 }]);
  const read = protoReadSkill(appDir, 'bomb-defusal');
  assert.ok(read.body.startsWith('## Lead plan\nTwo workers.') && read.body.includes('## Worked example') && read.body.includes('senju click <wire>'));
  assert.match(fs.readFileSync(file, 'utf8'), /revision: 2/);
}

// 4. Scores, seeds and the keep rule.
{
  assert.equal(scoreOf({ pass: false, milestones: [{ ok: true }, { ok: true }, { ok: false }, { ok: false }] }), 0.5);
  assert.equal(scoreOf({ pass: true }), 1);
  assert.equal(scoreOf({ pass: false, score: 0.3 }), 0.3);
  assert.notDeepEqual(seedsFor('train', 0, 6), seedsFor('train', 1, 6), 'training seeds move every generation');
  assert.deepEqual(seedsFor('unseen', 7, 3), [1001, 1002, 1003]);
  const champ = { k: 6, passes: 2, score: 0.5 };
  assert.equal(decide({ k: 6, passes: 2, score: 0.5 }, null), 'baseline');
  assert.equal(decide({ k: 6, passes: 2, score: 0.6 }, champ), 'keep');
  assert.equal(decide({ k: 6, passes: 3, score: 0.5 }, champ), 'keep');
  assert.equal(decide({ k: 6, passes: 3, score: 0.45 }, champ), 'revert');
  assert.equal(decide({ k: 6, passes: 2, score: 0.55 }, champ), 'revert');
}

// 5. Full generations: stub sets the baseline, a failing generation (stub cut off at 1 ms) is reverted and the skill restored.
{
  const root = path.join(tmp, 'skills');
  const dir = initSkill({ id: 'write-file' }, { root });
  const method = '---\nname: write-file\ndescription: Write one file.\n---\n\n1. Use files__write_file with the full path.\n';
  fs.writeFileSync(path.join(dir, 'SKILL.md'), method);
  const opts = { task: 'write-file', k: 2, concurrency: 2, skillDir: dir, ledger: path.join(tmp, 'ledger.jsonl'), runs: path.join(tmp, 'runs'), log: () => {} };

  const a = await runGeneration({ ...opts, model: 'stub', label: 'baseline' });
  assert.equal(a.entry.verdict, 'baseline');
  assert.equal(a.entry.passes, 2);
  assert.equal(a.entry.kept, true);
  const ep = a.episodes[0].dir;
  assert.ok(fs.existsSync(path.join(ep, 'transcript.md')) && fs.existsSync(path.join(ep, 'row.json')));
  const calls = fs.readFileSync(path.join(ep, 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(calls.find((c) => c.who === 'lead').system.includes('1. Use files__write_file'), 'the lead saw the playbook');
  assert.ok(calls.some((c) => c.who !== 'lead' && c.system?.includes('# Playbook for this task')), 'a worker saw the playbook');

  fs.writeFileSync(path.join(dir, 'SKILL.md'), method.replace('full path', 'WRONG IDEA'));
  const b = await runGeneration({ ...opts, model: 'stub', timeout: 0.001, label: 'a bad change' });
  assert.equal(b.entry.verdict, 'revert');
  assert.equal(b.entry.gen, 1);
  assert.equal(b.entry.champion.gen, 0);
  assert.equal(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), method, 'the champion skill is restored');

  assert.equal(a.entry.shell, true, 'the loop runs the swarm the way app/ does by default');
  const raw = await runGeneration({ ...opts, model: 'stub', shell: false, label: 'raw tools' });
  assert.equal(raw.entry.verdict, 'baseline', 'raw-tool runs keep their own champion');
  assert.equal(raw.entry.passes, 2);
  const c = await runGeneration({ ...opts, model: 'stub', seeds: 'unseen' });
  assert.equal(c.entry.kind, 'check');
  assert.equal(c.entry.verdict, 'ready');
  assert.deepEqual(c.entry.seeds, [1001, 1002]);
  assert.equal(readLedger(opts.ledger).length, 4);
  assert.ok(fs.readFileSync(path.join(dir, 'HISTORY.md'), 'utf8').includes('| g1 |'));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('research self-test passed');
