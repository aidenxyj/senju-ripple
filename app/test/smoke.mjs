// Smoke test: runs the swarm against scripted fake models and a real MCP server.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Swarm } from '../src/orchestrator.js';
import { connectServer } from '../src/mcp.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const echo = { command: process.execPath, args: [path.join(here, 'echo-server.mjs')], app: 'Finder' };
const baseConfig = { model: 'fake', maxAgents: 4, maxSteps: 8, servers: { echo } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A fake model driven by one script per agent. Each script gets the turn number
// and the text of the last message, and returns content blocks.
let uid = 0;
const use = (name, input = {}) => ({ type: 'tool_use', id: `t${++uid}`, name, input });
const say = (text) => ({ type: 'text', text });
function fakeLlm(scripts, delay = 15) {
  const turns = {};
  return {
    async create(params, { signal } = {}) {
      await sleep(delay);
      if (signal?.aborted) throw new Error('aborted');
      const isLead = params.tools?.[0]?.name === 'spawn_agent';
      const who = isLead ? 'lead' : params.system[0].text.match(/^You are "([^"]+)"/)[1];
      const turn = turns[who] = (turns[who] ?? 0) + 1;
      const last = params.messages.at(-1);
      const lastText = typeof last.content === 'string' ? last.content
        : last.content.map((b) => b.type === 'text' ? b.text : (b.content ?? []).map((c) => c.text ?? '').join('')).join('\n');
      const aborted = new Promise((_, rej) => signal?.addEventListener('abort', () => rej(new Error('aborted')), { once: true }));
      const out = await Promise.race([scripts[who]({ turn, lastText, params, system: params.system[0].text }), aborted]);
      if (out && out.content) return out;
      return { content: Array.isArray(out) ? out : [out], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } };
    },
  };
}
function make(scripts, extra = {}) {
  const events = [];
  const swarm = new Swarm({ llm: fakeLlm(scripts), config: baseConfig, workspace: '/tmp', emit: (e) => { events.push(e); extra.onEvent?.(e, swarm); }, ...extra.opts });
  return { swarm, events };
}

// 1. Lead spawns two workers, waits, replans with a third after the first report, then summarizes.
{
  const shouter = (word) => ({ turn, lastText, params }) => {
    if (/New on the shared board from "(Alpha|Beta)"/.test(lastText)) sawBoard = true;
    if (turn === 1) { assert.ok(params.tools.some((t) => t.name === 'echo__shout')); return [say('Shouting.'), use('echo__shout', { text: word })]; }
    if (turn === 2) { assert.ok(lastText.startsWith(word.toUpperCase())); return use('board_post', { note: word.toUpperCase() }); }
    return say(`shouted ${word}`);
  };
  let replanned = false, sawBoard = false;
  const { swarm, events } = make({
    lead: ({ turn, lastText }) => {
      if (turn === 1) return [use('spawn_agent', { name: 'Alpha', goal: 'shout hello', servers: ['echo'] }), use('spawn_agent', { name: 'Beta', goal: 'shout world', servers: ['echo'] })];
      if (!replanned && /"(Alpha|Beta)" finished/.test(lastText)) { replanned = true; return [say('Adding a third.'), use('spawn_agent', { name: 'Gamma', goal: 'shout again', servers: ['echo'] })]; }
      if (/No workers are running/.test(lastText)) return say('All three shouted.');
      return use('wait');
    },
    Alpha: shouter('hello'), Beta: shouter('world'), Gamma: shouter('again'),
  });
  await swarm.run('shout things');
  assert.deepEqual(events.filter((e) => e.type === 'state').map((e) => e.state), ['planning', 'running', 'idle']);
  assert.deepEqual(events.filter((e) => e.type === 'spawn').map((e) => e.agent.name), ['Alpha', 'Beta', 'Gamma']);
  assert.deepEqual(events.filter((e) => e.type === 'board').map((e) => e.note).sort(), ['AGAIN', 'HELLO', 'WORLD']);
  assert.ok(events.some((e) => e.type === 'agent' && e.status === 'acting' && e.server === 'echo'));
  assert.ok(events.some((e) => e.type === 'lead' && e.status === 'waiting'));
  assert.equal(events.find((e) => e.type === 'done').summary, 'All three shouted.');
  assert.ok(!events.some((e) => e.type === 'error'));
  assert.equal(sawBoard, true);
  await swarm.shutdown();
}

// 2. Cancel mid-run returns to idle.
{
  const { swarm, events } = make({ lead: ({ turn }) => turn === 1 ? use('spawn_agent', { name: 'Slow', goal: 'x', servers: [] }) : use('wait'), Slow: () => sleep(5000).then(() => say('late')) });
  const run = swarm.run('anything');
  setTimeout(() => swarm.cancel(), 300);
  await run;
  assert.equal(events.at(-1).state, 'idle');
  assert.ok(events.some((e) => e.type === 'error' && e.message === 'Cancelled.'));
}

// 3. User in the loop: handoff and ask_user on a worker, chat to a worker, chat to the lead,
//    lead redirects a worker, lead ask_user.
{
  const seen = {};
  const { swarm, events } = make({
    lead: ({ turn, lastText }) => {
      if (turn === 1) return use('spawn_agent', { name: 'Solo', goal: 'sign in then pick', servers: [], needs_user: true });
      if (/Message from the user: status\?/.test(lastText)) return [say('One worker, waiting on your sign-in.'), use('message_agent', { agent: 'solo', message: 'be quick' }), use('wait')];
      if (/No workers are running/.test(lastText) && !seen.asked) { seen.asked = true; return use('ask_user', { question: 'Ship it?', options: ['Yes', 'No'] }); }
      if (/The user answered: Yes/.test(lastText)) return say('Shipped.');
      return use('wait');
    },
    Solo: ({ turn, lastText, system }) => {
      if (turn === 1) { assert.ok(system.includes('probably needs the user')); return use('handoff', { reason: 'login wall', steps_for_user: 'Sign in', done_when: 'inbox visible' }); }
      if (turn === 2) { seen.afterHandoff = lastText; return [say('Dark mode it is.'), use('ask_user', { question: 'Which?', options: ['A', 'B'] })]; }
      seen.afterAsk = lastText;
      return say('picked B');
    },
  }, { onEvent: (e, s) => {
    if (e.type === 'ask' && e.kind === 'handoff') setTimeout(() => {
      assert.equal(s.tell('use dark mode', e.agentId), true);
      assert.equal(s.tell('status?'), true);
      setTimeout(() => s.answer(e.qid, ''), 120);
    }, 60);
    if (e.type === 'ask' && e.kind === 'question') setTimeout(() => s.answer(e.qid, e.agentId === 'lead' ? 'Yes' : 'B'), 40);
  } });
  await swarm.run('do the thing');
  assert.ok(events.some((e) => e.type === 'agent' && e.status === 'waiting'));
  assert.match(seen.afterHandoff, /The user replied: Done/);
  assert.match(seen.afterHandoff, /Message from the user: use dark mode/);
  assert.match(seen.afterHandoff, /Message from the lead: be quick/);
  assert.equal(seen.afterAsk, 'The user answered: B');
  assert.deepEqual(events.filter((e) => e.type === 'chat').map((e) => [e.from, e.text]), [['lead', 'One worker, waiting on your sign-in.'], ['a1', 'Dark mode it is.']]);
  assert.equal(events.find((e) => e.type === 'ask' && e.agentId === 'lead').question, 'Ship it?');
  assert.equal(events.find((e) => e.type === 'done').summary, 'Shipped.');
  assert.equal(swarm.tell('too late'), false);
}

// 4. Cancel while a worker waits on the user.
{
  const { swarm, events } = make({
    lead: ({ turn }) => turn === 1 ? use('spawn_agent', { name: 'Solo', goal: 'x', servers: [] }) : use('wait'),
    Solo: () => use('handoff', { reason: 'r', steps_for_user: 's', done_when: 'd' }),
  }, { onEvent: (e, s) => { if (e.type === 'ask') setTimeout(() => s.cancel(), 40); } });
  await swarm.run('x');
  assert.equal(events.at(-1).state, 'idle');
  assert.equal(swarm.pending.size, 0);
  assert.ok(events.some((e) => e.type === 'answered'));
}

// 5. Dependencies, deadlock refusal, tell_lead, tiling config.
{
  const got = {};
  const specs = [];
  const { swarm, events } = make({
    lead: ({ turn, lastText }) => {
      if (turn === 1) return [
        use('spawn_agent', { name: 'Reader', goal: 'read the numbers', servers: ['echo'] }),
        use('spawn_agent', { name: 'Writer', goal: 'write them up', servers: ['echo'], depends_on: ['reader', 'Nobody'] }),
      ];
      if (/"Reader" tells you: there are two parts/.test(lastText)) got.note = true;
      if (/No workers are running/.test(lastText)) return say('merged');
      return use('wait');
    },
    Writer: ({ turn, lastText, system }) => {
      assert.ok(system.includes('You depend on: "Reader"'));
      if (turn === 1) return use('wait_for', { agents: ['Ghost'] });
      if (turn === 2) { got.unknown = lastText; return use('wait_for', { agents: ['Reader'] }); }
      got.report = lastText;
      return say('wrote 1, 2, 3');
    },
    Reader: async ({ turn, lastText, system }) => {
      assert.ok(system.includes('waiting for your result: "Writer"'));
      if (turn === 1) { await sleep(250); return [use('tell_lead', { message: 'there are two parts' }), use('wait_for', { agents: ['Writer'] })]; }
      got.deadlock = lastText;
      return say('numbers are 1, 2, 3');
    },
  }, { opts: {
    config: { ...baseConfig, servers: { echo: { ...echo, tile: 'playwright' } } },
    layout: (n) => Array.from({ length: n }, (_, i) => ({ x: i * 500, y: 100, w: 500, h: 600 })),
    connect: (name, spec) => { specs.push(spec.args); return connectServer(name, { ...spec, args: spec.args.filter((a, i, all) => a !== '--config' && all[i - 1] !== '--config') }); },
  } });
  await swarm.run('read and write');
  assert.match(got.unknown, /No agent named "Ghost"/);
  assert.match(got.deadlock, /Cannot wait: "Writer" is itself waiting on you/);
  assert.match(got.report, /Report from "Reader" \(finished\):\nnumbers are 1, 2, 3/);
  assert.equal(got.note, true);
  assert.ok(events.some((e) => e.type === 'agent' && e.status === 'blocked' && e.label === 'waiting for Reader'));
  assert.deepEqual(events.filter((e) => e.type === 'spawn')[1].agent.dependsOn, ['Reader']);
  const cfgs = specs.filter((a) => a.includes('--config')).map((a) => JSON.parse(fs.readFileSync(a[a.indexOf('--config') + 1], 'utf8')));
  assert.equal(cfgs.length, 2);
  assert.ok(cfgs.some((c) => c.browser.launchOptions.args.includes('--window-position=500,100')));
  assert.equal(cfgs[0].browser.contextOptions.viewport, null);
  await swarm.shutdown();
}

// 6. Lead tries to finish early and is nudged; stop_agent stops a worker; agent limit is enforced.
{
  const got = { nudged: false };
  const { swarm, events } = make({
    lead: ({ turn, lastText }) => {
      if (turn === 1) return ['A', 'B', 'C', 'D', 'E'].map((n) => use('spawn_agent', { name: n, goal: 'idle', servers: [] }));
      if (turn === 2) { got.spawn = lastText; return say('Done already.'); }
      if (/still running/.test(lastText)) { got.nudged = true; return ['A', 'B', 'C', 'D'].map((n) => use('stop_agent', { agent: n })); }
      if (/No workers are running/.test(lastText)) return say('Stopped everything.');
      return use('wait');
    },
    A: () => sleep(4000).then(() => say('x')), B: () => sleep(4000).then(() => say('x')),
    C: () => sleep(4000).then(() => say('x')), D: () => sleep(4000).then(() => say('x')),
  });
  await swarm.run('idle around');
  assert.match(got.spawn, /at most 4 workers can run at once/);
  assert.equal(got.nudged, true);
  assert.equal(events.filter((e) => e.type === 'spawn').length, 4);
  assert.equal(events.filter((e) => e.type === 'agent' && e.status === 'cancelled').length, 4);
  assert.equal(events.find((e) => e.type === 'done').summary, 'Stopped everything.');
}

// 7. Cut-off replies are retried, running out of steps yields an honest report,
//    a user message interrupts the lead mid-call and always gets an answer,
//    a message wakes a worker out of wait_for, and traces are written.
{
  const traceDir = fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), 'swarm-trace-'));
  const got = { cutNote: null, leadCalls: 0, poke: null, stepAsk: null };
  let interrupted = false;
  const { swarm, events } = make({
    lead: async ({ turn, lastText }) => {
      got.leadCalls++;
      if (turn === 1) return [use('spawn_agent', { name: 'Typist', goal: 'type a lot', servers: [] }), use('spawn_agent', { name: 'Looper', goal: 'loop', servers: [] }), use('spawn_agent', { name: 'Sleeper', goal: 'wait', servers: [], depends_on: ['Looper'] })];
      if (turn === 2) { await sleep(400); return say('this slow reply should be thrown away'); }   // user interrupts this one
      if (/without answering the user/.test(lastText)) { got.nudges = (got.nudges ?? 0) + 1; return got.nudges === 1 ? use('wait') : [say('Yes, three workers are busy.'), use('wait')]; }
      if (/Message from the user: are you there\?/.test(lastText) && !interrupted) { interrupted = true; assert.match(lastText, /Your visible reply must begin with/); return use('wait'); }
      if (/No workers are running/.test(lastText)) return say('wrapped up');
      return use('wait');
    },
    Typist: ({ turn, lastText, params }) => {
      if (turn === 1) return { content: [say('Typing'), use('board_post', { note: 'x'.repeat(50) })], stop_reason: 'max_tokens', usage: { input_tokens: 9, output_tokens: 16000 } };
      if (turn === 2) { got.cutNote = lastText; got.retryMax = params.max_tokens; got.cutHistory = JSON.stringify(params.messages); return say('typed it in pieces'); }
    },
    Looper: async ({ lastText, params }) => {
      await sleep(120);
      if (/you must stop now/.test(lastText)) { got.stepAsk = lastText; return say('Half the loops are done; the rest remain.'); }
      return use('board_read');
    },
    Sleeper: ({ turn, lastText }) => {
      if (turn === 1) return use('wait_for', { agents: ['Looper'] });
      if (turn === 2) { got.poke = lastText; return say('woke up and stopped'); }
    },
  }, { opts: { traceDir, config: { ...baseConfig, maxSteps: 5, servers: {} } }, onEvent: (e, s) => {
    if (e.type === 'lead' && e.status === 'thinking' && got.leadCalls === 1 && !got.sent) { got.sent = true; setTimeout(() => { s.tell('are you there?'); s.tell('hey sleeper', 'a3'); }, 120); }
  } });
  await swarm.run('stress');
  assert.match(got.cutNote, /hit the output limit before its tool call was complete/);
  assert.equal(got.retryMax, 8192);                                            // the retry gets 4x the budget
  assert.ok(!got.cutHistory.includes('(cut off)'));                            // no placeholder for the model to copy
  assert.match(got.stepAsk, /used all 5 of your steps/);
  assert.match(got.poke, /Wait interrupted[\s\S]*Message from the user: hey sleeper/);
  assert.equal(events.filter((e) => e.type === 'board').length, 0);            // the cut-off tool call never ran
  assert.ok(!events.some((e) => e.type === 'chat' && /thrown away/.test(e.text)));
  assert.deepEqual(events.filter((e) => e.type === 'chat' && e.from === 'lead').map((e) => e.text), ['Yes, three workers are busy.']);
  assert.equal(got.nudges, 2);
  assert.ok(events.some((e) => e.type === 'agent' && e.id === 'a2' && e.status === 'error' && e.label === 'out of steps'));
  assert.ok(events.some((e) => e.type === 'result' && e.id === 'a2' && /^Not finished\. Half the loops/.test(e.text)));
  const dir = path.join(traceDir, fs.readdirSync(traceDir)[0]);
  const timeline = fs.readFileSync(path.join(dir, 'timeline.log'), 'utf8');
  assert.match(timeline, /\[Typist\] reply #1 stop=max_tokens in=9 out=16000/);
  assert.match(timeline, /\[Looper\] END reason=step_limit/);
  assert.match(timeline, /\[lead\] interrupt/);
  assert.match(timeline, /\[lead\] message \| from user: are you there\?/);
  assert.ok(fs.existsSync(path.join(dir, 'Looper.jsonl')) && fs.existsSync(path.join(dir, 'lead.jsonl')));
}

// 8. Old tool results are shrunk so long jobs stay inside the context window.
{
  let biggest = 0, lastSeen = '';
  const { swarm } = make({
    lead: ({ turn, lastText }) => turn === 1 ? use('spawn_agent', { name: 'Reader', goal: 'read', servers: ['echo'] }) : /No workers are running/.test(lastText) ? say('ok') : use('wait'),
    Reader: ({ turn, params }) => {
      const size = JSON.stringify(params.messages).length;
      biggest = Math.max(biggest, size);
      lastSeen = JSON.stringify(params.messages);
      return turn <= 7 ? use('echo__shout', { text: 'y'.repeat(5000) }) : say('read it all');
    },
  }, { opts: { config: { ...baseConfig, context: { enabled: false } } } });
  await swarm.run('read');
  assert.equal(lastSeen.split('Y'.repeat(5000)).length - 1, 4);   // only the 4 newest results are kept whole
  assert.match(lastSeen, /rest of this older result removed/);
  await swarm.shutdown();
}

// 9. Long-run request features: sent on every call, dropped cleanly if the API rejects them,
//    compaction blocks stay in the history, usage is reported, and the token budget warns the lead.
{
  const got = { withFeatures: 0, without: 0, rejected: 0, sawCompaction: false, budgetNote: false };
  const check = (params) => {
    if (params.context_management) {
      got.withFeatures++;
      assert.deepEqual(params.betas, ['context-management-2025-06-27', 'compact-2026-01-12']);
      assert.deepEqual(params.cache_control, { type: 'ephemeral' });
      assert.deepEqual(params.context_management.edits.map((e) => e.type), ['clear_tool_uses_20250919', 'compact_20260112']);
      assert.equal(params.context_management.edits[1].trigger.value, 60000);
      assert.match(params.context_management.edits[1].instructions, /exact current state/);
    } else got.without++;
  };
  const { swarm, events } = make({
    lead: ({ turn, lastText, params }) => {
      check(params);
      if (/System notice: The job has used its token budget/.test(lastText)) got.budgetNote = true;
      if (turn === 1) return use('spawn_agent', { name: 'Marathon', goal: 'go long', servers: [] });
      return /No workers are running/.test(lastText) ? say('long job done') : use('wait');
    },
    Marathon: ({ turn, params }) => {
      check(params);
      if (turn === 1) return { content: [{ type: 'compaction', content: 'Briefing: you were going long.' }, say('Carrying on'), use('board_read')], stop_reason: 'tool_use', usage: { input_tokens: 600, output_tokens: 50, cache_read_input_tokens: 400 }, context_management: { applied_edits: [{ type: 'clear_tool_uses_20250919', cleared_tool_uses: 3, cleared_input_tokens: 90000 }] } };
      if (turn === 2) { got.sawCompaction = params.messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'compaction')); return { content: [use('board_read')], stop_reason: 'tool_use', usage: { input_tokens: 700, output_tokens: 10 } }; }
      return say('went long');
    },
  }, { opts: { traceDir: fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), 'swarm-trace-')), config: { ...baseConfig, servers: {}, tokenBudget: 1500, context: { compactAt: 60000 } } } });
  await swarm.run('long');
  assert.ok(got.withFeatures >= 4 && got.without === 0);
  assert.equal(got.sawCompaction, true);
  assert.equal(got.budgetNote, true);
  assert.ok(events.some((e) => e.type === 'notice' && /Marathon compacted its history/.test(e.message)));
  const usage = events.filter((e) => e.type === 'usage').at(-1);
  assert.ok(usage.cacheRead === 400 && usage.input >= 1300 && usage.calls >= 5);
  const timeline = fs.readFileSync(path.join(swarm.tracer.dir, 'timeline.log'), 'utf8');
  assert.match(timeline, /\[Marathon\] compaction \| history replaced by a summary: Briefing/);
  assert.match(timeline, /\[Marathon\] context \| cleared 3 old tool results \(90000 tokens\)/);
  assert.match(timeline, /cached=400/);

  // Rejection: the first call with the features gets a 400, the app drops them and carries on.
  let threw = 0;
  const base = fakeLlm({ lead: ({ turn, lastText }) => turn === 1 ? use('spawn_agent', { name: 'Plain', goal: 'x', servers: [] }) : /No workers are running/.test(lastText) ? say('ok without') : use('wait'), Plain: () => say('fine') });
  const ev = [];
  const s2 = new Swarm({ llm: { create: (params, opts) => {
    if (params.context_management) { threw++; return Promise.reject(Object.assign(new Error('context_management: Extra inputs are not permitted'), { status: 400 })); }
    assert.equal(params.betas, undefined); assert.equal(params.cache_control, undefined);
    return base.create(params, opts);
  } }, config: { ...baseConfig, servers: {} }, workspace: '/tmp', emit: (e) => ev.push(e) });
  await s2.run('x');
  assert.equal(threw, 1);
  assert.equal(ev.find((e) => e.type === 'done').summary, 'ok without');
  assert.ok(ev.some((e) => e.type === 'notice' && /trimming history itself/.test(e.message)));

  // Hard stop at 150% of the budget.
  const { swarm: s3, events: ev3 } = make({
    lead: ({ turn }) => turn === 1 ? use('spawn_agent', { name: 'Hog', goal: 'x', servers: [] }) : use('wait'),
    Hog: () => ({ content: [use('board_read')], stop_reason: 'tool_use', usage: { input_tokens: 5000, output_tokens: 1 } }),
  }, { opts: { config: { ...baseConfig, servers: {}, tokenBudget: 10000 } } });
  await s3.run('hog');
  assert.equal(ev3.at(-1).state, 'idle');
  assert.ok(ev3.some((e) => e.type === 'notice' && /50% past its token budget/.test(e.message)));
}

// 10. If the lead still will not answer the user after two nudges, they get a factual status line.
{
  const { swarm, events } = make({
    lead: ({ turn, lastText }) => turn === 1 ? use('spawn_agent', { name: 'Quiet', goal: 'x', servers: [] }) : /No workers are running/.test(lastText) ? say('end') : use('wait'),
    Quiet: () => sleep(700).then(() => say('done quietly')),
  }, { onEvent: (e, s) => { if (e.type === 'spawn') setTimeout(() => s.tell('progress?'), 100); } });
  await swarm.run('x');
  const chat = events.filter((e) => e.type === 'chat').map((e) => e.text);
  assert.deepEqual(chat, ['Status: Quiet: working.']);
}

// 11. Self-improvement: after a job the lead writes a skill; the next job lists it, the lead
//     hands it to a worker, and an update keeps the old revision.
{
  const skillsDir = fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), 'swarm-skills-'));
  const got = { listed: false, workerNotes: false, retroCount: 0, lessons: false };
  const scripts = (job) => ({
    lead: ({ turn, lastText, params }) => {
      if (/do a short retrospective/.test(lastText)) {
        got.retroCount++;
        assert.ok(params.tools.some((t) => t.name === 'save_skill'));
        if (job === 2) { assert.match(lastText, /- site-typing: Use when typing into the editor\./); return use('read_skill', { name: 'site-typing' }); }
        return use('save_skill', { name: 'Site Typing!', description: 'Use when typing into the editor.', body: 'Type in chunks of 800 words using the evaluate tool. Sign-in is needed first.' });
      }
      if (/^# site-typing/.test(lastText)) return use('save_skill', { name: 'site-typing', description: 'Use when typing into the editor.', body: 'Type in chunks of 800 words using the evaluate tool. Sign-in is needed first. Also: wait for the page to settle.' });
      if (/(Created|Updated) skill "site-typing"/.test(lastText)) return say('noted');
      if (turn === 1) {
        if (job === 2) { got.listed = /Skills from earlier jobs[\s\S]*- site-typing: Use when typing into the editor\./.test(lastText); return use('spawn_agent', { name: 'Typist', goal: 'type', servers: [], skills: ['site-typing', 'missing'] }); }
        assert.ok(!/Skills from earlier jobs/.test(lastText));
        return use('spawn_agent', { name: 'Typist', goal: 'type', servers: [] });
      }
      return /No workers are running/.test(lastText) ? say(`job ${job} done`) : use('wait');
    },
    Typist: ({ system }) => {
      got.lessons = /End your final report with a short "Lessons" section/.test(system);
      if (job === 2) got.workerNotes = /# Notes from earlier jobs[\s\S]*## site-typing\nType in chunks of 800 words/.test(system);
      else assert.ok(!/Notes from earlier jobs/.test(system));
      return say('typed. Lessons: chunks work.');
    },
  });
  const ev = [];
  const mk = (job) => new Swarm({ llm: fakeLlm(scripts(job)), config: { ...baseConfig, servers: {} }, workspace: '/tmp', emit: (e) => ev.push(e), skillsDir });
  const a = mk(1);
  await a.run('first');
  assert.equal(ev.find((e) => e.type === 'done').summary, 'job 1 done');
  assert.equal(ev.filter((e) => e.type === 'state').at(-1).state, 'idle');   // the user is not kept waiting
  await a.learning;
  const file = path.join(skillsDir, 'site-typing.md');
  assert.match(fs.readFileSync(file, 'utf8'), /^---\nname: site-typing\ndescription: Use when typing into the editor\.\nrevision: 1\n/);
  assert.deepEqual(ev.filter((e) => e.type === 'skill').map((e) => [e.name, e.created]), [['site-typing', true]]);

  const b = mk(2);
  await b.run('second');
  await b.learning;
  assert.equal(got.listed, true);
  assert.equal(got.workerNotes, true);
  assert.equal(got.lessons, true);
  assert.equal(got.retroCount, 2);
  assert.match(fs.readFileSync(file, 'utf8'), /revision: 2\n[\s\S]*wait for the page to settle/);
  assert.ok(fs.existsSync(path.join(skillsDir, '.history', 'site-typing-r1.md')));
  assert.deepEqual(ev.filter((e) => e.type === 'skill').map((e) => e.created), [true, false]);

  // No retrospective for a cancelled job or one with no workers.
  const c = new Swarm({ llm: fakeLlm({ lead: () => say('just an answer') }), config: { ...baseConfig, servers: {} }, workspace: '/tmp', emit: () => {}, skillsDir });
  await c.run('plain question');
  assert.equal(c.learning, null);
}

// 12. Desktop apps: rules reach only desktop workers, calls to a serial server never overlap,
//     the driven window is tracked from tool inputs, and a missing driver is a soft notice.
{
  const { pickWindow } = await import('../src/windows.js');
  let active = 0, overlap = false;
  const desk = async (name) => ({
    name, pid: null, close: async () => {},
    tools: [{ name: 'click', description: 'click', inputSchema: { type: 'object', properties: {} } }],
    client: { callTool: async () => { active++; if (active > 1) overlap = true; await sleep(60); active--; return { content: [{ type: 'text', text: 'ok' }] }; } },
  });
  const sys = {};
  const { swarm, events } = make({
    lead: ({ turn, lastText }) => {
      if (turn === 1) { assert.match(lastText, /- desktop: Drives Mac apps\. Tools: click/); return [use('spawn_agent', { name: 'Slacker', goal: 'draft', servers: ['desktop'] }), use('spawn_agent', { name: 'Coder', goal: 'edit', servers: ['desktop'] }), use('spawn_agent', { name: 'Plain', goal: 'x', servers: [] })]; }
      return /No workers are running/.test(lastText) ? say('desk done') : use('wait');
    },
    Slacker: ({ turn, system }) => { sys.Slacker = system; return turn <= 3 ? use('desktop__click', { pid: 501, window_id: 77 }) : say('drafted'); },
    Coder: ({ turn, system }) => { sys.Coder = system; return turn === 1 ? use('desktop__click', { app: 'Cursor' }) : turn <= 3 ? use('desktop__click', { pid: 502 }) : say('edited'); },
    Plain: ({ system }) => { sys.Plain = system; return say('nothing'); },
  }, { opts: {
    config: { ...baseConfig, servers: { desktop: { command: 'x', about: 'Drives Mac apps', kind: 'desktop', shared: true, serial: true, tile: 'window' }, ghost: { command: 'definitely-not-installed-xyz', setup: 'See the README.' } } },
    layout: (n) => Array.from({ length: n }, (_, i) => ({ x: i * 600, y: 118, w: 600, h: 700 })),
    connect: (name, spec) => name === 'desktop' ? desk(name) : connectServer(name, spec),
  } });
  await swarm.run('desk');
  assert.equal(overlap, false);
  assert.match(sys.Slacker, /# Working in desktop apps[\s\S]*never press Return or Enter in a chat box/);
  assert.match(sys.Coder, /# Working in desktop apps/);
  assert.ok(!/Working in desktop apps/.test(sys.Plain));
  const [slacker, coder, plain] = swarm.agents;
  assert.deepEqual(slacker.target, { pid: 501, windowId: 77, app: null });
  assert.deepEqual(coder.target, { pid: 502, windowId: null, app: null });      // switching process drops the stale app name
  assert.ok(slacker.slot && coder.slot && !plain.slot && slacker.slot.x !== coder.slot.x);
  assert.ok(events.some((e) => e.type === 'notice' && /"ghost" tools are not installed.*See the README\./.test(e.message)));
  const wins = [{ app: 'Finder', pid: 1, id: 5, x: 0, y: 0, w: 500, h: 400 }, { app: 'Slack', pid: 501, id: 76, x: 9, y: 9, w: 500, h: 400 }, { app: 'Slack', pid: 501, id: 77, x: 50, y: 50, w: 500, h: 400 }, { app: 'Cursor', pid: 502, id: 80, x: 0, y: 0, w: 500, h: 400 }];
  assert.equal(pickWindow(slacker, null, wins, new Map(), 0).id, 77);
  assert.equal(pickWindow(coder, null, wins, new Map(), 1).id, 80);
  assert.equal(pickWindow({ target: { pid: null, windowId: null, app: 'cursor' }, pids: [] }, null, wins, new Map(), 0).id, 80);
  // Windows on another desktop (Space): a showing window wins; an agent whose only window is elsewhere gets that one,
  // marked off screen, so the app hides its cursor instead of parking it over this desktop.
  const spaced = [{ app: 'Slack', pid: 501, id: 90, x: 0, y: 0, w: 500, h: 400, onScreen: false }, { app: 'Slack', pid: 501, id: 91, x: 0, y: 0, w: 500, h: 400, onScreen: true }, { app: 'Notes', pid: 600, id: 95, x: 0, y: 0, w: 500, h: 400, onScreen: false }];
  assert.equal(pickWindow({ target: { pid: 501 }, pids: [] }, null, spaced, new Map(), 0).id, 91);
  assert.equal(pickWindow({ target: { pid: 501, windowId: 90 }, pids: [] }, null, spaced, new Map(), 0).onScreen, false);
  assert.equal(pickWindow({ target: { pid: 600 }, pids: [] }, null, spaced, new Map(), 0).onScreen, false);
  assert.equal(pickWindow({ pids: [] }, 'slack', spaced, new Map(), 0).id, 91);
}

// 13. Cooperation: peer messages, claims, a task for the user elsewhere, pause and resume,
//     stop from the UI, and desktop actions that wait while the user is typing.
{
  const got = {};
  const t0 = Date.now();
  let typingUntil = 0;
  const calls = [];
  const desk = async (name) => ({
    name, pid: null, close: async () => {},
    tools: ['click', 'get_window_state'].map((n) => ({ name: n, description: n, inputSchema: { type: 'object', properties: {} } })),
    client: { callTool: async ({ name: tool }) => { calls.push([tool, Date.now()]); return { content: [{ type: 'text', text: 'ok' }] }; } },
  });
  const { swarm, events } = make({
    lead: ({ turn, lastText }) => {
      if (/System notice: The user stopped "Idler"/.test(lastText)) got.leadTold = true;
      if (turn === 1) return [
        use('spawn_agent', { name: 'Asker', goal: 'get the port', servers: [] }),
        use('spawn_agent', { name: 'Helper', goal: 'help', servers: [], depends_on: ['Asker'] }),
        use('spawn_agent', { name: 'Clicker', goal: 'click', servers: ['desktop'] }),
        use('spawn_agent', { name: 'Idler', goal: 'idle', servers: [] }),
      ];
      return /No workers are running/.test(lastText) ? say('coop done') : use('wait');
    },
    Asker: ({ turn, lastText }) => {
      if (turn === 1) return [use('claim', { resource: 'Word: notes.docx' }), use('user_task', { task: 'Connect the arm', where: 'USB port', done_when: 'the port is listed', reply_hint: 'the port name' })];
      if (turn === 2) { got.taskReply = lastText; return use('tell_agent', { agent: 'helper', message: 'port is ready' }); }
      if (turn === 3) { got.pausedNote = lastText; return say('got the port'); }
    },
    Helper: ({ turn, lastText }) => {
      if (turn === 1) return [use('claim', { resource: 'word: Notes.docx' }), use('wait_for', { agents: ['Asker'] })];
      if (turn === 2) { got.helperSaw = lastText; return use('wait_for', { agents: ['Asker'] }); }
      if (turn === 3) return use('claim', { resource: 'Word: notes.docx' });
      got.claimAfter = lastText;
      return say('helped');
    },
    Clicker: ({ turn }) => turn === 1 ? [use('desktop__get_window_state', { pid: 9 }), use('desktop__click', { pid: 9 })] : say('clicked'),
    Idler: () => sleep(5000).then(() => say('never')),
  }, { opts: {
    config: { ...baseConfig, typingPause: 2, servers: { desktop: { command: 'x', kind: 'desktop', shared: true, serial: true } } },
    connect: (name) => desk(name),
    idle: () => (Date.now() < typingUntil ? 0 : 30),
  }, onEvent: (e, s) => {
    if (e.type === 'spawn' && e.agent.name === 'Clicker') typingUntil = Date.now() + 700;      // the user is typing as the clicker starts
    if (e.type === 'spawn' && e.agent.name === 'Idler') setTimeout(() => assert.equal(s.stopAgent(e.agent.id), true), 150);
    if (e.type === 'ask' && e.kind === 'task') {
      got.card = e;
      setTimeout(() => {
        assert.equal(s.setPaused(e.agentId, true), true);      // pause while it waits on us
        s.answer(e.qid, '/dev/tty.usbmodem1');
        setTimeout(() => s.setPaused(e.agentId, false), 250);
      }, 60);
    }
  } });
  await swarm.run('cooperate');
  assert.deepEqual([got.card.task, got.card.where, got.card.doneWhen, got.card.replyHint], ['Connect the arm', 'USB port', 'the port is listed', 'the port name']);
  assert.match(got.taskReply, /You hold "Word: notes\.docx"[\s\S]*The user replied: \/dev\/tty\.usbmodem1\nCheck the result yourself now/);
  assert.match(got.taskReply, /Notice: The user paused you for \d+ seconds and may have changed things/);   // resumed before its next step
  assert.match(got.helperSaw, /"word: Notes\.docx" is held by "Asker"[\s\S]*Wait interrupted[\s\S]*Message from agent "Asker": port is ready/);
  assert.match(got.claimAfter, /You hold "Word: notes\.docx"/);                                   // released when Asker finished
  assert.equal(got.leadTold, true);
  assert.ok(events.some((e) => e.type === 'agent' && e.status === 'paused' && e.label === 'paused by you'));
  assert.ok(events.some((e) => e.type === 'agent' && e.status === 'paused' && e.label === 'waiting for you to pause'));
  const read = calls.find((c) => c[0] === 'get_window_state')[1], click = calls.find((c) => c[0] === 'click')[1];
  assert.ok(read < typingUntil, 'reading does not wait for the user');
  assert.ok(click >= typingUntil, 'acting waits until the user stops typing');
  // The agents' own input must not count as the user typing.
  swarm.lastDesktopAction = Date.now(); swarm.idle = () => 0;
  assert.equal(swarm.userActive(), false);
  swarm.lastDesktopAction = Date.now() - 10000;
  assert.equal(swarm.userActive(), true);
}

// 14. A message from the user releases a lead that is blocked on its own question.
{
  const got = {};
  const { swarm, events } = make({
    lead: ({ turn, lastText }) => {
      if (turn === 1) return use('ask_user', { question: 'Which one?', options: ['A', 'B'] });
      if (turn === 2) { got.released = lastText; return [say('Reading you now.'), use('ask_user', { question: 'Which one?', options: ['A', 'B'] })]; }
      got.answered = lastText;
      return say('done with B');
    },
  }, { onEvent: (e, s) => {
    if (e.type === 'ask' && !got.first) { got.first = e.qid; setTimeout(() => s.tell('wait, what are the options for?', 'lead', 'Linda'), 40); }
    else if (e.type === 'ask') setTimeout(() => s.answer(e.qid, 'B', 'Linda'), 40);
  } });
  await swarm.run('choose');
  assert.match(got.released, /not answered yet[\s\S]*Message from the user Linda: wait, what are the options for\?/);
  assert.equal(got.answered, 'The user answered: B (from Linda)');
  assert.ok(events.some((e) => e.type === 'answered' && e.qid === got.first));
  assert.deepEqual(events.filter((e) => e.type === 'chat').map((e) => e.text), ['Reading you now.']);
}

// Workers answer the user the way the lead does: the same "answer now" note comes with the message, and a reply
// that acts without a word to the user is thrown away unrun and asked again. Its answer then reaches the chat.
{
  const seen = { shouts: [] };
  const { swarm, events } = make({
    lead: ({ turn, lastText }) => {
      if (turn === 1) return use('spawn_agent', { name: 'Doc', goal: 'make a Pages document', servers: ['echo'] });
      if (/No workers are running/.test(lastText)) return say('Made it.');
      return use('wait');
    },
    Doc: async ({ turn, lastText }) => {
      if (/discarded/.test(lastText)) { seen.again = lastText; return [say("I'm making the Pages document: the Open dialog is up, so I'm clicking New Document."), use('echo__shout', { text: 'go' })]; }
      if (/Message from the user: what are you working on/.test(lastText)) { seen.got = lastText; return use('echo__shout', { text: 'skipped' }); }
      if (turn === 1) { await sleep(150); return use('echo__shout', { text: 'open' }); }
      return say('done');
    },
  }, { onEvent: (e, s) => { if (e.type === 'spawn') setTimeout(() => s.tell('what are you working on', e.agent.id), 40); } });
  await swarm.run('make a doc');
  assert.match(seen.got, /Message from the user: what are you working on\n\n\(Answer the user now\./);
  assert.match(seen.again, /You made tool calls without answering the user, so that reply was discarded/);
  assert.doesNotMatch(seen.again, /SKIPPED/);   // the discarded reply's tool call never ran
  assert.deepEqual(events.filter((e) => e.type === 'chat' && e.from !== 'lead').map((e) => e.text), ["I'm making the Pages document: the Open dialog is up, so I'm clicking New Document."]);
  await swarm.shutdown();
}

// Desktop: a batch of known actions in one reply runs in order, one call each, and the window is read once,
// after the last of them; that reading comes back with the last result (no extra model turn to look).
// A batch stops at its first failure (later steps never run out of order), and a window that opened or closed
// is said plainly instead of showing a stale picture.
{
  const desk = { command: process.execPath, args: [path.join(here, 'fake-desktop.mjs')], kind: 'desktop', shared: true, serial: true, about: 'fake Mac apps' };
  const seen = {};
  const results = (params) => params.messages.at(-1).content.filter((b) => b.type === 'tool_result').map((b) => b.content.map((c) => c.text).join(' | '));
  const keys = (list) => list.map((key) => use('desk__press_key', { pid: 7, window_id: 70, key }));
  const swarm = new Swarm({
    llm: fakeLlm({
      lead: ({ turn, lastText }) => turn === 1 ? use('spawn_agent', { name: 'Calc', goal: 'compute 7+8', servers: ['desk'] })
        : /No workers are running/.test(lastText) ? say('15') : use('wait'),
      Calc: ({ turn, params }) => {
        if (turn === 1) { seen.rules = params.system[0].text; return use('desk__get_window_state', { pid: 7, window_id: 70 }); }
        if (turn === 2) return keys(['7', '+', '8', '=']);
        if (turn === 3) { seen.batch = results(params); return keys(['1', 'X', '2']); }
        if (turn === 4) { seen.failed = results(params); return keys(['n']); }
        if (turn === 5) { seen.opened = results(params); return keys(['w']); }
        seen.closed = results(params);
        return say('15');
      },
    }),
    config: { model: 'fake', maxAgents: 2, maxSteps: 10, servers: { desk } }, workspace: '/tmp', emit: () => {},
  });
  await swarm.run('compute');
  assert.match(seen.rules, /make them all in one reply/);
  // Four known keys: no reading between them, one after the last, attached to its result.
  assert.deepEqual(seen.batch.slice(0, 3), ['Pressed 7', 'Pressed +', 'Pressed 8']);
  assert.match(seen.batch[3], /^Pressed = \| The window now .* \| STATE #2 window=70 display=7\+8=$/);
  // The batch stops at the failed "X": "2" never runs, and the window is read at the failure.
  assert.equal(seen.failed[0], 'Pressed 1');
  assert.match(seen.failed[1], /^press_key failed: no such key \| The window now .* \| STATE #3 window=70 display=7\+8=1$/);
  assert.match(seen.failed[2], /^Not run: an earlier action in this reply failed/);
  // A new window is named; the reading stays on the window the worker was using.
  assert.match(seen.opened[0], /New window opened in this app: "Untitled" \(window_id 71\)\. Shown below is still window_id 70[\s\S]* STATE #4 window=70/);
  // The worker's window closed: it is said so, and the window that is open is read instead.
  assert.match(seen.closed[0], /The window you were working in \(window_id 70\) is no longer open\. This is "Untitled" \(window_id 71\)[\s\S]* STATE #5 window=71/);
  await swarm.shutdown();
}

console.log('smoke test passed');
process.exit(0);
