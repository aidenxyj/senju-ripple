// Harness tests, no network: node harness/test.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeStack, makeSwarm, whoOf } from './index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const echo = { command: process.execPath, args: [path.join(here, '../app/test/echo-server.mjs')], app: 'Finder' };
let uid = 0;
const use = (name, input = {}) => ({ type: 'tool_use', id: `t${++uid}`, name, input });
const reply = (content) => ({ content, stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } });

// 1. Every call carries adapter-safe params, goes through fit, and is reported.
{
  const seen = [], calls = [];
  const fitCalls = [];
  const fakeContext = {
    countMessages: (m) => m.length * 1000,
    fit: (messages, opts) => { fitCalls.push(opts.maxTokens); return messages.length > 2 ? [messages[0], ...messages.slice(-1)] : messages; },
  };
  const llm = { async create(params) {
    seen.push(params);
    const who = whoOf(params);
    if (who === 'lead') {
      const last = JSON.stringify(params.messages.at(-1));
      if (/No workers are running/.test(last)) return reply([{ type: 'text', text: 'Done: HELLO.' }]);
      return reply(params.messages.length === 1 ? [use('spawn_agent', { name: 'Alpha', goal: 'shout hello', servers: ['echo'] })] : [use('wait')]);
    }
    return reply(params.messages.length === 1 ? [use('echo__shout', { text: 'hello' })] : [{ type: 'text', text: 'shouted HELLO' }]);
  } };
  const stack = await makeStack({ llm, context: fakeContext, contextBudget: 16000, onCall: (c) => calls.push(c) });
  const events = [];
  const swarm = await makeSwarm({ stack, config: { servers: { echo }, maxSteps: 8 }, workspace: '/tmp', emit: (e) => events.push(e) });
  await swarm.run('shout hello');
  await swarm.shutdown();
  assert.ok(!events.some((e) => e.type === 'error'), JSON.stringify(events.filter((e) => e.type === 'error')));
  assert.equal(events.find((e) => e.type === 'done')?.summary, 'Done: HELLO.');
  assert.ok(seen.every((p) => !p.betas && !p.context_management), 'server-side context management is off');
  assert.ok(fitCalls.length === seen.length && fitCalls.every((n) => n === 16000), 'fit ran on every call with the budget');
  assert.deepEqual([...new Set(calls.map((c) => c.who))].sort(), ['Alpha', 'lead']);
  assert.ok(calls.some((c) => c.trimmedFrom != null), 'trims are reported');
  console.log('ok - swarm runs through the stack with fit, sched and reporting');
}

// 2. Without context/ the stack still works and passes messages through untouched.
{
  const msgs = [{ role: 'user', content: 'hi' }];
  let got;
  const stack = await makeStack({ llm: { create: async (p) => { got = p.messages; return reply([{ type: 'text', text: 'x' }]); } }, context: null });
  await stack.create({ messages: msgs, system: 'You are "W".' });
  assert.equal(got, msgs);
  assert.equal(stack.hasContext, false);
  console.log('ok - no context/ means no trimming');
}
console.log('harness tests passed');

// 3. withShellNote adds the note only to calls that have a senju sh tool (and a short one to the lead).
{
  const { withShellNote, SHELL_NOTE } = await import('./index.js');
  const seen = [];
  const s = withShellNote({ create: async (p) => { seen.push(p.system); return { content: [], stop_reason: 'end_turn', usage: {} }; } });
  await s.create({ system: [{ type: 'text', text: 'W' }], tools: [{ name: 'browser__sh' }], messages: [] });
  await s.create({ system: [{ type: 'text', text: 'X' }], tools: [{ name: 'echo__shout' }], messages: [] });
  await s.create({ system: [{ type: 'text', text: 'L' }], tools: [{ name: 'spawn_agent' }], messages: [] });
  assert.equal(seen[0].at(-1).text, SHELL_NOTE);
  assert.equal(seen[1].length, 1);
  assert.match(seen[2].at(-1).text, /screenshot/);
  console.log('ok - shell note goes to sh workers and the lead only');
}

// 4. Batch approvals: "Approve all" on one card, or on a worker's ask_user, covers the rest of that kind for the job.
{
  const { createApprovals, shellHooks, withBatchApprovals } = await import('./index.js');
  const approvals = createApprovals();
  const asked = [];
  const answers = ['Approve all deletes'];
  const fakeSwarm = { requestHuman: async (_id, p) => { asked.push(p); return answers.shift() ?? 'Decline'; } };
  const hooks = shellHooks(() => fakeSwarm, { id: 'a1', name: 'W' }, approvals);
  const card = (kind) => ({ kind, title: `W wants to ${kind}`, detail: 'x' });
  assert.equal(await hooks.confirm(card('delete')), true);
  assert.equal(await hooks.confirm(card('delete')), true);
  assert.equal(await hooks.confirm(card('delete')), true);
  assert.equal(asked.length, 1, 'one click for three deletes');
  assert.deepEqual(asked[0].options, ['Approve all deletes', 'Approve this one', 'Decline']);
  assert.equal(await hooks.confirm(card('send')), false, 'sends are not covered by a delete grant');
  const other = shellHooks(() => fakeSwarm, { id: 'a2', name: 'Other' }, approvals);
  answers.push('Decline');
  assert.equal(await other.confirm(card('delete')), false, "one worker's grant does not cover another worker");
  approvals.reset();
  let seen;
  const stack = withBatchApprovals({ create: async (p) => { seen = p; return {}; } }, approvals);
  await stack.create({ system: [{ type: 'text', text: 'You are "W", a worker.' }], messages: [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'q1', name: 'ask_user', input: { question: 'Delete these 5 drafts and send "Weekly summary"?', options: ['Approve all', 'Decline'] } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'q1', content: [{ type: 'text', text: 'The user answered: Approve all' }] }] },
  ] });
  assert.ok(approvals.has('W', 'delete') && approvals.has('W', 'send'), 'an approved ask_user batch grants its kinds to that worker');
  assert.equal(approvals.has('Other', 'delete'), false);
  approvals.reset();
  await stack.create({ system: [{ type: 'text', text: 'You are "W", a worker.' }], messages: [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'q2', name: 'ask_user', input: { question: 'Delete these drafts?' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'q2', content: 'The user answered: Decline' }] },
  ] });
  assert.equal(approvals.has('W', 'delete'), false, 'a decline grants nothing');
  console.log('ok - batch approvals: one click covers a kind for the job');
}

// 5. pointAt (shell/) becomes a 'point' swarm event for the app's ghost cursor, then waits for the glide.
{
  const { shellHooks, POINT_LEAD_MS } = await import('./index.js');
  const events = [];
  const hooks = shellHooks(() => ({ emit: (e) => events.push(e) }), { id: 'a7', name: 'W' });
  const t0 = Date.now();
  await hooks.pointAt({ verb: 'click', id: 'e4', x: 100, y: 200, screenX: 400, screenY: 500, windowW: 1200, windowH: 800 });
  assert.ok(Date.now() - t0 >= POINT_LEAD_MS - 20, 'the action waits for the cursor');
  assert.deepEqual(events, [{ type: 'point', agentId: 'a7', point: { verb: 'click', id: 'e4', x: 100, y: 200, screenX: 400, screenY: 500, windowW: 1200, windowH: 800 } }]);
  const { pointLeadMs } = await import('./index.js');
  assert.equal(pointLeadMs({ verb: 'key' }), 0, 'a key does not wait');
  assert.equal(pointLeadMs({ verb: 'open', typeMs: 300 }), POINT_LEAD_MS + 300, 'open waits while the url is typed');
  assert.ok(POINT_LEAD_MS <= 200, 'short enough to keep actions fast');
  console.log('ok - pointAt emits a point event for the ghost cursor');
}

// 6. Sign-ins: the model never types into secret fields, and never asks the person for credentials.
{
  const { noSecretsGuard, withNoCredentialAsks } = await import('./index.js');
  const g = noSecretsGuard({ check: () => ({ allow: true }) });
  assert.ok(g.check('W', { verb: 'type', args: ['e2', 'hunter2'], element: { role: 'textbox', name: 'Password' } }).deny);
  assert.ok(g.check('W', { verb: 'type', args: ['e3', '123456'], element: { role: 'textbox', name: 'Verification code' } }).deny);
  assert.ok(g.check('W', { verb: 'type', args: ['e1', 'ada@x.com'], element: { role: 'textbox', name: 'Email' } }).allow);
  assert.ok(g.check('W', { verb: 'click', args: ['e4'], element: { role: 'button', name: 'Show password' } }).allow, 'only typing is blocked');
  const stack = withNoCredentialAsks({ create: async () => ({ content: [
    { type: 'text', text: 'I need your details.' },
    { type: 'tool_use', id: 'q', name: 'ask_user', input: { question: 'What is your Shopnet email and password?' } },
    { type: 'tool_use', id: 'r', name: 'ask_user', input: { question: 'Which size do you want?' } },
  ], stop_reason: 'tool_use' }) });
  const res = await stack.create({});
  assert.equal(res.content[1].name, 'handoff');
  assert.match(res.content[1].input.steps_for_user, /sign in/);
  assert.equal(res.content[2].name, 'ask_user', 'ordinary questions are left alone');
  console.log('ok - no typing into password fields; credential questions become handoffs');
}

// 7. keepBrowsers: a finished worker's browser stays open; it closes when the next job starts, and at shutdown.
{
  const { makeStack, makeSwarm } = await import('./index.js');
  let opened = 0, closed = 0;
  const fakeConnect = async (name) => { opened++; return { name, tools: [], pid: null, client: { callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }) }, close: async () => { closed++; } }; };
  const llm = { async create(params) {
    const lead = params.tools?.some((t) => t.name === 'spawn_agent');
    const last = JSON.stringify(params.messages.at(-1));
    if (lead) {
      if (/No workers are running/.test(last)) return { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: {} };
      return params.messages.length === 1
        ? { content: [{ type: 'tool_use', id: `s${Math.random()}`, name: 'spawn_agent', input: { name: 'W', goal: 'look', servers: ['browser'] } }], stop_reason: 'tool_use', usage: {} }
        : { content: [{ type: 'tool_use', id: `w${Math.random()}`, name: 'wait', input: {} }], stop_reason: 'tool_use', usage: {} };
    }
    return { content: [{ type: 'text', text: 'looked' }], stop_reason: 'end_turn', usage: {} };
  } };
  const stack = await makeStack({ llm, context: null, guard: false });
  const swarm = await makeSwarm({ stack, shell: true, keepBrowsers: true, connect: fakeConnect, workspace: '/tmp', config: { servers: { browser: { command: 'x', app: 'Chrome' } }, maxSteps: 4 } });
  await swarm.run('job 1');
  assert.ok(opened >= 1 && closed === 0, `browser kept open after the worker finished (opened ${opened}, closed ${closed})`);
  await swarm.run('job 2');
  assert.ok(closed >= 1, 'job 1 browser closed when job 2 started');
  await swarm.shutdown();
  assert.equal(closed, opened, 'everything is closed at shutdown');
  console.log('ok - keepBrowsers keeps finished windows until the next job or shutdown');
}

// 8. Sign-in walls: the harness raises a sign-in card and waits; it carries on by itself once the page is past it,
//    and a worker may not stop while its page is a sign-in page.
{
  const { isSignInPage, waitForSignIn, withNoStopAtSignIn, signInState } = await import('./index.js');
  assert.equal(isSignInPage('ok\npage: Log in to Overleaf\nurl: https://www.overleaf.com/login?\ne36 textbox "Password" = ""'), true);
  assert.equal(isSignInPage('ok\npage: Canvas Login Stanford University\nurl: https://canvas-gateway.stanford.edu/goCanvas.html'), true);
  assert.equal(isSignInPage('ok\npage: Overleaf\nurl: https://www.overleaf.com/\ne1 link "Log in" -> /login'), false, 'a Log in link alone is not a wall');
  assert.equal(isSignInPage('ok\npage: Dashboard\nurl: https://canvas.stanford.edu/'), false);

  const asks = [], answers = [], statuses = [];
  const fakeSwarm = { qseq: 0, emit: (e) => statuses.push(e.status), answer: (q, t) => { answers.push([q, t]); fakeSwarm._resolve?.(t); },
    requestHuman(id, p) { this.qseq++; asks.push(p); return new Promise((r) => { this._resolve = r; }); } };
  let polls = 0;
  const observe = async () => ({ text: ++polls < 3 ? 'page: Log in\nurl: https://x.com/login\ne1 textbox "Password"' : 'page: Home\nurl: https://x.com/home' });
  const shell = { run: async () => 'ok\npage: Home\nurl: https://x.com/home' };
  const agent = { id: 'a1', name: 'W', status: 'acting', label: '' };
  const out = await waitForSignIn({ swarm: fakeSwarm, agent, conn: {}, shell, first: 'ok\npage: Log in\nurl: https://x.com/login', everyMs: 5, observe });
  assert.equal(asks.length, 1);
  assert.equal(asks[0].kind, 'handoff', 'the sign-in is raised to the person as a card (with Done)');
  assert.match(out, /has now signed in[\s\S]*page: Home/);
  assert.deepEqual(answers, [['q1', 'Signed in (Senju noticed)']], 'the card resolves itself once the page is past the sign-in');
  assert.deepEqual([statuses[0], statuses.at(-1)], ['waiting', 'acting']);

  signInState.set('W', { onSignIn: true, tool: 'browser__sh' });
  const stack = withNoStopAtSignIn({ create: async () => ({ content: [{ type: 'text', text: 'Blocked at the login page, done.' }], stop_reason: 'end_turn' }) });
  const res = await stack.create({ system: [{ type: 'text', text: 'You are "W", a worker.' }], tools: [{ name: 'browser__sh' }], messages: [] });
  assert.equal(res.stop_reason, 'tool_use');
  assert.deepEqual(res.content.at(-1), { ...res.content.at(-1), name: 'browser__sh', input: { cmd: 'senju look' } }, 'stopping at a sign-in becomes a look, which waits');
  signInState.clear();
  console.log('ok - sign-in walls: raise a card, wait, carry on by itself; no stopping at a login page');
}

// 9. Waiting is not done: a worker's waiting call runs inside the model call (worker or person), then the worker carries on;
//    a worker that tries to finish while saying it is waiting is told to call waiting instead.
{
  const { withWaiting, WAITING_TOOL } = await import('./index.js');
  const events = [];
  const beta = { id: 'b', name: 'Beta', status: 'thinking', label: '', abort: new AbortController() };
  const fakeSwarm = {
    find: (n) => (n === 'Beta' ? beta : null), emit: (e) => events.push(e),
    waitFor: async (_a, names) => `Report from "${names[0]}" (done):\nHELLO`,
    requestHuman: async (_id, p) => { events.push({ ask: p }); return 'Done'; },
  };
  const sys = [{ type: 'text', text: 'You are "Beta", a worker.' }];
  const seen = [];
  const replies = [
    { content: [{ type: 'tool_use', id: 'w1', name: 'waiting', input: { for: 'worker', worker: 'Alpha' } }], stop_reason: 'tool_use' },
    { content: [{ type: 'tool_use', id: 'w2', name: 'waiting', input: { for: 'user', what: 'Upload the PDF in the Canvas window' } }], stop_reason: 'tool_use' },
    { content: [{ type: 'tool_use', id: 'x', name: 'browser__sh', input: { cmd: 'senju look' } }], stop_reason: 'tool_use' },
  ];
  const stack = withWaiting({ create: async (p) => { seen.push(p); return replies.shift(); } }, () => fakeSwarm);
  const res = await stack.create({ system: sys, tools: [{ name: 'browser__sh' }], messages: [{ role: 'user', content: 'go' }] });
  assert.ok(seen[0].tools.some((t) => t.name === WAITING_TOOL.name), 'workers get the waiting tool');
  assert.equal(res.content.at(-1).name, 'browser__sh', 'after waiting, the worker carries on with real work');
  assert.match(res.content[0].text, /waited for worker "Alpha"[\s\S]*waited for the person/);
  const results = seen[2].messages.filter((m) => m.role === 'user' && Array.isArray(m.content)).flatMap((m) => m.content).map((b) => b.content?.[0]?.text ?? '');
  assert.ok(results.some((t) => /HELLO/.test(t)) && results.some((t) => /person replied: Done/.test(t)));
  assert.ok(events.some((e) => e.ask?.kind === 'task' && /Upload the PDF/.test(e.ask.task)), 'waiting for the person raises a card');
  assert.ok(events.some((e) => e.status === 'blocked' && /waiting for Alpha/.test(e.label)));

  // Finishing while saying it is waiting -> nudged to call waiting.
  const r2 = [
    { content: [{ type: 'text', text: "I'm waiting for Alpha to finish the outline, then I'll write it up." }], stop_reason: 'end_turn' },
    { content: [{ type: 'tool_use', id: 'w3', name: 'waiting', input: { for: 'worker', worker: 'Alpha' } }], stop_reason: 'tool_use' },
    { content: [{ type: 'text', text: 'Wrote it up: HELLO.' }], stop_reason: 'end_turn' },
  ];
  const seen2 = [];
  const s2 = withWaiting({ create: async (p) => { seen2.push(p); return r2.shift(); } }, () => fakeSwarm);
  const out2 = await s2.create({ system: sys, tools: [], messages: [{ role: 'user', content: 'go' }] });
  assert.match(JSON.stringify(seen2[1].messages.at(-1)), /not done/);
  assert.match(out2.content.at(-1).text, /Wrote it up/);
  // The lead is untouched.
  const s3 = withWaiting({ create: async (p) => p }, () => fakeSwarm);
  const p3 = await s3.create({ tools: [{ name: 'spawn_agent' }], messages: [] });
  assert.ok(!p3.tools.some((t) => t.name === 'waiting'));
  console.log('ok - waiting tool: waits for a worker or the person, then carries on; waiting is never done');
}
