// Unit tests for guard/.   cd guard && npm test
import assert from 'node:assert/strict';
import { repair, parseLoose, createGuard, guardLlm, reviewTurn, NUDGE_SPAWN, NUDGE_POST, NUDGE_ACT, NUDGE_SAID } from './index.js';

let failures = 0;
const test = (name, fn) => {
  try { fn(); } catch (err) { failures++; console.error(`FAIL ${name}\n  ${err.message.split('\n').join('\n  ')}`); }
};

// ---- repair ------------------------------------------------------------------------------------

const SH = { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] };
const WRITE = { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] };
const CLICK = {
  type: 'object',
  properties: { element: { type: 'string' }, target: { type: 'string' }, doubleClick: { type: 'boolean' }, button: { type: 'string', enum: ['left', 'right', 'middle'] } },
  required: ['target'],
};
const SCROLL = { type: 'object', properties: { amount: { type: 'integer' }, ratio: { type: 'number' }, ids: { type: 'array', items: { type: 'string' } } }, required: ['amount'] };
const raw = (name, text) => ({ type: 'tool_use', id: 't1', name, input: { _raw: text } });
const fixed = (r) => { assert.ok(r.call, `expected a call, got ${JSON.stringify(r)}`); return r.call.input; };

test('valid input passes through unchanged, other fields kept', () => {
  const r = repair({ type: 'tool_use', id: 'x', name: 'sh', input: { cmd: 'senju look' } }, SH);
  assert.deepEqual(r.call, { type: 'tool_use', id: 'x', name: 'sh', input: { cmd: 'senju look' } });
});
test('_raw that is valid JSON', () => assert.deepEqual(fixed(repair(raw('sh', '{"cmd": "senju look"}'), SH)), { cmd: 'senju look' }));
test('trailing comma', () => assert.deepEqual(fixed(repair(raw('sh', '{"cmd": "senju look",}'), SH)), { cmd: 'senju look' }));
test('single quotes', () => assert.deepEqual(fixed(repair(raw('sh', "{'cmd': 'senju click e12'}"), SH)), { cmd: 'senju click e12' }));
test('single quotes with a double quote inside', () =>
  assert.deepEqual(fixed(repair(raw('sh', `{'cmd': 'senju type e3 "hi"'}`), SH)), { cmd: 'senju type e3 "hi"' }));
test('apostrophe inside double quotes survives', () =>
  assert.deepEqual(fixed(repair(raw('sh', `{"cmd": "senju type e3 \\"it's ok\\"",}`), SH)), { cmd: `senju type e3 "it's ok"` }));
test('missing closing brace', () => assert.deepEqual(fixed(repair(raw('sh', '{"cmd": "senju look"'), SH)), { cmd: 'senju look' }));
test('missing closing quote and brace', () => assert.deepEqual(fixed(repair(raw('sh', '{"cmd": "senju look'), SH)), { cmd: 'senju look' }));
test('unquoted keys', () => assert.deepEqual(fixed(repair(raw('write', '{path: "/tmp/a", content: "x"}'), WRITE)), { path: '/tmp/a', content: 'x' }));
test('unquoted-key fix leaves string contents alone', () =>
  assert.deepEqual(fixed(repair(raw('write', '{path: "/tmp/a", content: "a, b: c",}'), WRITE)), { path: '/tmp/a', content: 'a, b: c' }));
test('code fence and prose around the object', () =>
  assert.deepEqual(fixed(repair(raw('sh', 'Here you go:\n```json\n{"cmd": "senju look"}\n```'), SH)), { cmd: 'senju look' }));
test('prose after the object', () => assert.deepEqual(fixed(repair(raw('sh', '{"cmd": "senju look"} I will look first.'), SH)), { cmd: 'senju look' }));
test('Python literals', () => assert.deepEqual(fixed(repair(raw('click', "{'target': 'e4', 'doubleClick': True}"), CLICK)), { target: 'e4', doubleClick: true }));
test('Python-looking words inside strings are left alone', () =>
  assert.deepEqual(fixed(repair(raw('sh', `{'cmd': 'senju type e1 "True story"',}`), SH)), { cmd: 'senju type e1 "True story"' }));
test('smart quotes', () => assert.deepEqual(fixed(repair(raw('sh', '{“cmd”: “senju look”}'), SH)), { cmd: 'senju look' }));
test('bare command for a one-string tool', () => assert.deepEqual(fixed(repair(raw('sh', 'senju look --full'), SH)), { cmd: 'senju look --full' }));
test('bare key: value for a one-string tool', () => assert.deepEqual(fixed(repair(raw('sh', 'cmd: senju open https://example.com'), SH)), { cmd: 'senju open https://example.com' }));
test('multi-line bare command is kept whole', () =>
  assert.deepEqual(fixed(repair(raw('sh', 'senju click e1\nsenju type e2 "x"'), SH)), { cmd: 'senju click e1\nsenju type e2 "x"' }));
test('input given as a JSON string instead of an object', () =>
  assert.deepEqual(fixed(repair({ name: 'write', input: '{"path": "/a", "content": "b"}' }, WRITE)), { path: '/a', content: 'b' }));
test('coerces numbers, integers, booleans, enums and arrays', () => {
  assert.deepEqual(fixed(repair({ name: 'scroll', input: { amount: '3', ratio: '0.5', ids: 'e1' } }, SCROLL)), { amount: 3, ratio: 0.5, ids: ['e1'] });
  assert.deepEqual(fixed(repair({ name: 'click', input: { target: 'e1', doubleClick: 'false', button: 'Left' } }, CLICK)), { target: 'e1', doubleClick: false, button: 'left' });
  assert.deepEqual(fixed(repair({ name: 'scroll', input: { amount: 3.0, ids: '["e1","e2"]' } }, SCROLL)), { amount: 3, ids: ['e1', 'e2'] });
});
test('null for an optional key is dropped', () => assert.deepEqual(fixed(repair({ name: 'click', input: { target: 'e1', button: null } }, CLICK)), { target: 'e1' }));
test('missing required key is an error that shows the shape', () => {
  const r = repair({ name: 'write_file', input: { path: '/a' } }, WRITE);
  assert.ok(r.error);
  assert.match(r.error, /missing "content"/);
  assert.match(r.error, /\{"path":"...","content":"..."\}/);
});
test('wrong type that cannot be coerced is an error', () => {
  const r = repair({ name: 'scroll', input: { amount: 'lots' } }, SCROLL);
  assert.match(r.error, /"amount" should be integer/);
});
test('bad enum is an error listing the options', () => assert.match(repair({ name: 'click', input: { target: 'e1', button: 'side' } }, CLICK).error, /"left", "right", "middle"/));
test('hopeless raw for a multi-argument tool is an error', () => {
  const r = repair(raw('write_file', 'write hello to /tmp/a'), WRITE);
  assert.match(r.error, /not valid JSON/);
  assert.match(r.error, /write_file/);
});
test('empty arguments for a tool with no required keys are fine', () => assert.deepEqual(fixed(repair(raw('look', ''), { type: 'object', properties: {} })), {}));
test('parseLoose never throws', () => { for (const s of ['', '{', '}}}', '"', "'", '[1,', null, 42]) parseLoose(s); });

// ---- check: confirm ----------------------------------------------------------------------------

const verdict = (g, action, agent = 'w1') => { const v = g.check(agent, action); return v.allow ? 'allow' : v.deny ? 'deny' : `confirm:${v.card.kind}`; };

test('unnamed buttons: judged by icon hints, then fail closed in a composer or next to delete', () => {
  const g = createGuard();
  const click = (element) => verdict(g, { verb: 'click', args: ['e9'], element: { role: 'button', name: '', ...element } });
  assert.equal(click({ hints: 'btn icon-send' }), 'confirm:send');
  assert.equal(click({ hints: 'PaperPlaneIcon' }), 'confirm:send');
  assert.equal(click({ hints: 'icon trashCan' }), 'confirm:delete');
  assert.equal(click({ hints: 'ic-bin' }), 'confirm:delete');
  assert.equal(click({ hints: 'aria-label Delete event' }), 'confirm:delete');
  assert.equal(click({ name: '➤', hints: 'svg', drafted: true }), 'confirm:send', 'an arrow in a composer with text typed');
  assert.equal(click({ hints: 'svg', deleteNear: true }), 'confirm:delete');
  assert.equal(click({ hints: 'svg', drafted: false, deleteNear: false }), 'allow', 'nothing suggests a send or delete');
  assert.equal(click({}), 'allow', 'no hints were read (no browser): nothing to judge');
  assert.equal(verdict(g, { verb: 'click', args: ['e9'], element: { role: 'button', name: 'Settings', hints: 'icon-send', drafted: true } }), 'allow', 'a real name wins');
  const card = g.check('w1', { verb: 'click', args: ['e9'], element: { role: 'button', name: '', hints: 'svg', drafted: true } }).card;
  assert.match(card.detail, /unnamed button \(svg\) in a message box with text typed/);
});

test('type --submit and Enter: a send in a message box, never in a search box', () => {
  const g = createGuard();
  const submit = (element) => verdict(g, { verb: 'type', args: ['e3', 'hi'], flags: { submit: true }, element: { role: 'textbox', name: '', hints: '', ...element } });
  assert.equal(submit({ name: 'Message' }), 'confirm:send');
  assert.equal(submit({ field: { label: 'Write a reply', multiline: false } }), 'confirm:send');
  assert.equal(submit({ field: { label: '', multiline: true } }), 'confirm:send', 'a multiline box');
  assert.equal(submit({ field: { label: 'q', multiline: false }, where: '/messenger?with=Bob Messenger: Bob' }), 'confirm:send', 'any field on a messages page');
  assert.equal(submit({ name: 'Search', field: { label: 'Search mail', search: true }, where: '/mail/inbox' }), 'allow');
  assert.equal(submit({ role: 'searchbox', name: 'Query' }), 'allow');
  assert.equal(submit({ name: 'Password', field: { label: 'password', multiline: false }, where: '/login Sign in' }), 'allow');
  assert.equal(verdict(g, { verb: 'type', args: ['e3', 'hi'], element: { role: 'textbox', name: 'Message' } }), 'allow', 'no --submit: typing sends nothing');
  assert.equal(verdict(g, 'senju type e3 "hi" --submit'), 'allow', 'a bare line has no element to judge');
  assert.equal(verdict(g, { verb: 'key', args: ['enter'], element: { role: '', name: '', hints: '', field: { label: 'Message', multiline: false } } }), 'confirm:send');
  assert.equal(verdict(g, { verb: 'key', args: ['enter'], element: { role: '', name: '', hints: '', field: { label: 'Search', search: true } } }), 'allow');
  assert.equal(verdict(g, 'senju key enter'), 'allow');
});

test('ordinary senju commands are allowed', () => {
  const g = createGuard();
  for (const line of ['senju look', 'senju look --full', 'senju click e12', 'senju type e3 "hello"', 'senju open https://example.com', 'senju key cmd+s',
    'senju board post "found the price"', 'senju board read', 'senju wait Research', 'senju ask "which file?"', 'senju done "saved it"']) {
    assert.equal(verdict(g, line), 'allow', line);
  }
});
test('clicks are judged by the element eyes/ reports', () => {
  const g = createGuard();
  const click = (name, role = 'button') => verdict(g, { verb: 'click', args: ['e5'], element: { id: 'e5', role, name } });
  assert.equal(click('Send'), 'confirm:send');
  assert.equal(click('Send now'), 'confirm:send');
  assert.equal(click('Post'), 'confirm:send');
  assert.equal(click('Pay $12.00'), 'confirm:pay');
  assert.equal(click('Place your order'), 'confirm:pay');
  assert.equal(click('Proceed to checkout'), 'confirm:pay');
  assert.equal(click('Buy now'), 'confirm:pay');
  assert.equal(click('Delete'), 'confirm:delete');
  assert.equal(click('Move to Trash'), 'confirm:delete');
  assert.equal(click('Remove item'), 'confirm:delete');
  assert.equal(click('Sign up'), 'allow');
  assert.equal(click('Submit'), 'allow');
  assert.equal(click('Reply'), 'allow');
  assert.equal(click('Messages', 'link'), 'allow');
  assert.equal(click('Search'), 'allow');
  assert.equal(verdict(g, 'senju click e5'), 'allow', 'no element info: nothing to judge');
});
test('keys that send or delete', () => {
  const g = createGuard();
  assert.equal(verdict(g, 'senju key cmd+enter'), 'confirm:send');
  assert.equal(verdict(g, 'senju key shift+cmd+d'), 'confirm:send');
  assert.equal(verdict(g, 'senju key Command+Backspace'), 'confirm:delete');
  assert.equal(verdict(g, 'senju key enter'), 'allow');
  assert.equal(verdict(g, 'senju key cmd+c'), 'allow');
});
test('plain tool calls: browser, files, mail and shell tools', () => {
  const g = createGuard();
  const call = (name, input = {}) => verdict(g, { name, input });
  assert.equal(call('browser__browser_click', { element: 'Send button', target: 'e9' }), 'confirm:send');
  assert.equal(call('browser__browser_click', { element: 'Complete order', target: 'e9' }), 'confirm:pay');
  assert.equal(call('browser__browser_click', { element: 'Sign up button', target: '#submit' }), 'allow');
  assert.equal(call('browser__browser_press_key', { key: 'Meta+Enter' }), 'confirm:send');
  assert.equal(call('browser__browser_navigate', { url: 'https://example.com/delete-account' }), 'allow');
  assert.equal(call('browser__browser_snapshot'), 'allow');
  assert.equal(call('browser__browser_drop', { target: 'e1' }), 'allow');
  assert.equal(call('files__write_file', { path: '/a', content: 'b' }), 'allow');
  assert.equal(call('files__read_text_file', { path: '/a' }), 'allow');
  assert.equal(call('files__delete_file', { path: '/a' }), 'confirm:delete');
  assert.equal(call('gmail__send_email', { to: 'a@b.c' }), 'confirm:send');
  assert.equal(call('slack__post_message', { text: 'hi' }), 'confirm:send');
  assert.equal(call('slack__list_messages'), 'allow');
  assert.equal(call('terminal__run', { command: 'ls -la' }), 'allow');
  assert.equal(call('terminal__run', { command: 'rm -rf build' }), 'confirm:delete');
  assert.equal(call('terminal__run', { command: 'cd x && git reset --hard' }), 'confirm:delete');
  assert.equal(call('terminal__run', { command: 'echo hi | mail -s x a@b.c' }), 'confirm:send');
  assert.equal(call('terminal__run', { command: 'npm run format' }), 'allow');
});
test('a model asking to skip confirmation does not change the verdict', () => {
  const g = createGuard();
  assert.equal(verdict(g, { name: 'gmail__send_email', input: { to: 'a@b.c', confirmed: true, skip_confirmation: true } }), 'confirm:send');
});
test('sh with several lines: the strictest verdict wins', () => {
  const g = createGuard();
  assert.equal(verdict(g, { name: 'sh', input: { cmd: 'senju look\nsenju key cmd+enter' } }), 'confirm:send');
  assert.equal(verdict(g, { name: 'sh', input: { cmd: 'senju look\nsenju click e2' } }), 'allow');
});
test('the confirm card says who and what', () => {
  const g = createGuard();
  const v = g.check({ id: 'a3', name: 'Research' }, { verb: 'click', args: ['e5'], element: { role: 'button', name: 'Send' } });
  assert.equal(v.confirm, true);
  assert.equal(v.card.kind, 'send');
  assert.equal(v.card.agent, 'Research');
  assert.match(v.card.title, /Research wants to send a message/);
  assert.match(v.card.detail, /senju click e5 on "Send"/);
});

// ---- check: loops ------------------------------------------------------------------------------

test('same action, same result, three times: the fourth is denied', () => {
  const g = createGuard();
  for (let i = 0; i < 3; i++) {
    assert.equal(verdict(g, 'senju click e7'), 'allow', `try ${i + 1}`);
    g.record('w1', 'senju click e7', 'ok\nnothing happened');
  }
  const v = g.check('w1', 'senju click e7');
  assert.equal(v.deny, true);
  assert.match(v.reason, /3 times in a row/);
  assert.match(v.reason, /Try something different/);
  assert.equal(verdict(g, 'senju look'), 'allow', 'a different action is fine');
});
test('whitespace differences in the result do not hide a loop', () => {
  const g = createGuard();
  for (const r of ['ok\n  no change', 'ok no change', 'ok\nno change\n']) g.record('w1', 'senju look', r);
  assert.equal(verdict(g, 'senju look'), 'deny');
});
test('a changing result is not a loop', () => {
  const g = createGuard();
  for (const r of ['ok page 1', 'ok page 2', 'ok page 3']) g.record('w1', 'senju key pagedown', r);
  assert.equal(verdict(g, 'senju key pagedown'), 'allow');
});
test('a different action in between breaks the streak', () => {
  const g = createGuard();
  g.record('w1', 'senju click e7', 'ok');
  g.record('w1', 'senju click e7', 'ok');
  g.record('w1', 'senju look', 'ok');
  g.record('w1', 'senju click e7', 'ok');
  assert.equal(verdict(g, 'senju click e7'), 'allow');
});
test('loops are tracked per agent', () => {
  const g = createGuard();
  for (let i = 0; i < 3; i++) g.record('w1', 'senju click e7', 'ok');
  assert.equal(verdict(g, 'senju click e7', 'w1'), 'deny');
  assert.equal(verdict(g, 'senju click e7', 'w2'), 'allow');
  assert.equal(verdict(g, 'senju click e7', { id: 'w1', name: 'Alpha' }), 'deny', 'agent objects key by id');
});
test('loops work for plain tool calls, ignoring key order', () => {
  const g = createGuard();
  for (let i = 0; i < 3; i++) g.record('w1', { name: 'browser__browser_click', input: { target: 'e1', element: 'Next' } }, [{ type: 'text', text: 'same' }]);
  assert.equal(verdict(g, { name: 'browser__browser_click', input: { element: 'Next', target: 'e1' } }), 'deny');
});
test('a loop on a send is denied, not confirmed again', () => {
  const g = createGuard();
  const send = { verb: 'click', args: ['e5'], element: { role: 'button', name: 'Send' } };
  for (let i = 0; i < 3; i++) g.record('w1', send, 'error: the message box is empty');
  assert.equal(verdict(g, send), 'deny');
});
test('reset clears history', () => {
  const g = createGuard();
  for (let i = 0; i < 3; i++) g.record('w1', 'senju look', 'ok');
  g.reset('w1');
  assert.equal(verdict(g, 'senju look'), 'allow');
});

// ---- guardLlm: turn rules -------------------------------------------------------------------------

const LEAD_TOOLS = [{ name: 'spawn_agent', input_schema: { type: 'object', properties: { name: { type: 'string' }, goal: { type: 'string' } }, required: ['name', 'goal'] } },
  { name: 'wait', input_schema: { type: 'object', properties: {} } }];
const WORKER_TOOLS = [{ name: 'board_post', input_schema: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'] } },
  { name: 'files__write_file', input_schema: WRITE }];
const SH_TOOLS = [{ name: 'sh', input_schema: SH }];
const tu = (name, input, id = `c${Math.random().toString(36).slice(2, 7)}`) => ({ type: 'tool_use', id, name, input });
const txt = (text) => ({ type: 'text', text });
const reply = (content) => ({ content, stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn', usage: { input_tokens: 100, output_tokens: 10 } });
// A fake model that plays back replies in order and records what it was sent.
function scripted(replies) {
  const sent = [];
  return { sent, async create(params) { sent.push(params); return replies[Math.min(sent.length - 1, replies.length - 1)]; } };
}
const run = (llm, params, opts) => guardLlm(llm, opts).create(params, {});
// A history in which the worker has already done some work (so the act-first rules are satisfied).
const worked = (name, input) => [{ role: 'user', content: 'Begin' }, { role: 'assistant', content: [tu(name, input, 'w0')] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'w0', content: 'ok' }] }];
const lastUserText = (params) => params.messages.at(-1).content.filter?.((b) => b.type === 'text').map((b) => b.text).join('\n') ?? params.messages.at(-1).content;

const asyncTests = [];
const atest = (name, fn) => asyncTests.push([name, fn]);

atest('lead that answers without spawning is asked again', async () => {
  const llm = scripted([reply([txt('HELLO WORLD')]), reply([tu('spawn_agent', { name: 'A', goal: 'shout' })])]);
  const res = await run(llm, { tools: LEAD_TOOLS, messages: [{ role: 'user', content: 'Goal: shout hello' }] });
  assert.equal(llm.sent.length, 2);
  assert.equal(res.content[0].name, 'spawn_agent');
  assert.match(lastUserText(llm.sent[1]), /You have not started any workers/);
  assert.deepEqual(res.usage, { input_tokens: 200, output_tokens: 20 }, 'usage covers both calls');
});
atest('lead that already spawned may finish', async () => {
  const llm = scripted([reply([txt('All done.')])]);
  const messages = [{ role: 'user', content: 'Goal' }, { role: 'assistant', content: [tu('spawn_agent', { name: 'A', goal: 'g' }, 's1')] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 's1', content: 'started' }] }];
  await run(llm, { tools: LEAD_TOOLS, messages });
  assert.equal(llm.sent.length, 1);
});
atest('a stubborn lead goes through after maxRetries', async () => {
  const llm = scripted([reply([txt('no')])]);
  const res = await run(llm, { tools: LEAD_TOOLS, messages: [{ role: 'user', content: 'Goal' }] }, { maxRetries: 2 });
  assert.equal(llm.sent.length, 3);
  assert.equal(res.content[0].text, 'no');
});
atest('worker that finishes without posting is asked to post first', async () => {
  const llm = scripted([reply([txt('Done: wrote the file.')]), reply([tu('board_post', { note: 'wrote /a' })])]);
  const res = await run(llm, { tools: WORKER_TOOLS, messages: worked('files__write_file', { path: '/a', content: 'b' }) });
  assert.equal(llm.sent.length, 2);
  assert.equal(res.content[0].name, 'board_post');
  assert.equal(lastUserText(llm.sent[1]), NUDGE_POST);
});
atest('worker that posted earlier may finish', async () => {
  const llm = scripted([reply([txt('Done.')])]);
  const messages = [...worked('files__write_file', { path: '/a', content: 'b' }), { role: 'assistant', content: [tu('board_post', { note: 'x' }, 'p1')] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'p1', content: 'posted' }] }];
  await run(llm, { tools: WORKER_TOOLS, messages });
  assert.equal(llm.sent.length, 1);
});
atest('shell workers: senju done without a board post is nudged, with both in one cmd it is not', async () => {
  const lone = scripted([reply([tu('sh', { cmd: 'senju done "saved"' })]), reply([tu('sh', { cmd: 'senju board post "saved /a"\nsenju done "saved"' })])]);
  const res = await run(lone, { tools: SH_TOOLS, messages: worked('sh', { cmd: 'senju click e3' }) });
  assert.equal(lone.sent.length, 2);
  assert.match(res.content[0].input.cmd, /board post/);
  const sent = lone.sent[1].messages;
  assert.equal(sent.at(-1).content[0].type, 'tool_result', 'the unrun sh call gets a result so the history stays valid');
  const both = scripted([reply([tu('sh', { cmd: 'senju board post "x"\nsenju done "y"' })])]);
  await run(both, { tools: SH_TOOLS, messages: worked('sh', { cmd: 'senju click e3' }) });
  assert.equal(both.sent.length, 1);
  const working = scripted([reply([tu('sh', { cmd: 'senju look' })])]);
  await run(working, { tools: SH_TOOLS, messages: [{ role: 'user', content: 'Begin' }] });
  assert.equal(working.sent.length, 1, 'only finishing turns are checked');
});
atest('namespaced shell (browser__sh, as in the app): an earlier board post counts, so finishing is not nudged', async () => {
  const tools = [{ name: 'browser__sh', input_schema: SH }, { name: 'board_post', input_schema: { type: 'object' } }];
  const history = [...worked('browser__sh', { cmd: 'senju click e13' }),
    { role: 'assistant', content: [tu('browser__sh', { cmd: 'senju board post "sent Let\'s meet to Bob"' }, 'p1')] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'p1', content: 'ok\nposted' }] }];
  const llm = scripted([reply([txt('Final report: sent it.')])]);
  await run(llm, { tools, messages: history });
  assert.equal(llm.sent.length, 1, 'no nudge loop');
  const did = worked('browser__sh', { cmd: 'senju click e13' });
  assert.equal(reviewTurn({ tools, messages: did }, reply([tu('browser__sh', { cmd: 'senju done "x"' })]))?.rule, 'worker-must-post');
  assert.equal(reviewTurn({ tools, messages: did }, reply([tu('browser__sh', { cmd: 'senju board post "x" && senju done "y"' })])), null, 'chained post && done');
});
atest('a worker that ends before doing any work is told to start, not to post (seen live)', async () => {
  const tools = [{ name: 'browser__sh', input_schema: SH }, { name: 'board_post', input_schema: { type: 'object' } }, { name: 'wait_for', input_schema: { type: 'object' } }];
  const begin = [{ role: 'user', content: 'Begin your subtask now.' }];
  const llm = scripted([reply([txt("I'll post the result first, then finish.")]), reply([tu('browser__sh', { cmd: 'senju open https://www.google.com/search?q=calculator' })])]);
  const res = await run(llm, { tools, messages: begin });
  assert.equal(llm.sent.length, 2);
  assert.equal(lastUserText(llm.sent[1]), NUDGE_ACT);
  assert.match(res.content[0].input.cmd, /senju open/);
  assert.equal(reviewTurn({ tools, messages: begin }, reply([tu('browser__sh', { cmd: 'senju board post "20"\nsenju done "20"' })]))?.rule, 'worker-must-act', 'posting and done are not work');
  assert.equal(reviewTurn({ tools, messages: begin }, reply([tu('browser__sh', { cmd: 'senju look' })])), null, 'acting is fine');
  assert.equal(reviewTurn({ tools, messages: worked('browser__sh', { cmd: 'senju board read' }) }, reply([txt('Nothing to do.')]))?.rule, 'worker-must-act', 'reading the board is not work');
  assert.equal(reviewTurn({ tools, messages: begin }, reply([txt('x')]), { workerMustAct: false })?.rule, 'worker-must-post', 'can be switched off');
});
atest('a worker that announces a step but calls no tool is told to make the call', async () => {
  const tools = [{ name: 'browser__sh', input_schema: SH }, { name: 'board_post', input_schema: { type: 'object' } }];
  const did = [...worked('browser__sh', { cmd: 'senju open https://example.com' }), { role: 'assistant', content: [tu('board_post', { note: 'x' }, 'p9')] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'p9', content: 'posted' }] }];
  for (const text of ["I'll click the = button now.", 'Let me look at the page again.', 'Now I open the calculator:', 'Next, I type 10.']) {
    assert.equal(reviewTurn({ tools, messages: did }, reply([txt(text)]))?.rule, 'said-not-did', text);
  }
  assert.equal(reviewTurn({ tools, messages: did }, reply([txt('Final report: 10 + 10 = 20 on the Google calculator.')])), null, 'a real report ends the subtask');
  assert.equal(reviewTurn({ tools, messages: did }, reply([txt("I'll summarise. " + 'x'.repeat(500))])), null, 'long replies are reports');
});
atest('rules can be switched off', async () => {
  const llm = scripted([reply([txt('HELLO')])]);
  await run(llm, { tools: LEAD_TOOLS, messages: [{ role: 'user', content: 'Goal' }] }, { leadMustSpawn: false });
  assert.equal(llm.sent.length, 1);
});
atest('a cut-off reply (max_tokens) is not nudged', () => {
  assert.equal(reviewTurn({ tools: LEAD_TOOLS, messages: [] }, { content: [txt('I will')], stop_reason: 'max_tokens' }), null);
});

// ---- guardLlm: repair ----------------------------------------------------------------------------

atest('fixable arguments are repaired in place, no extra call', async () => {
  const llm = scripted([reply([tu('files__write_file', { _raw: "{'path': '/a', 'content': 'b',}" }), tu('board_post', { note: 'x' })])]);
  const res = await run(llm, { tools: WORKER_TOOLS, messages: [{ role: 'user', content: 'Begin' }] });
  assert.equal(llm.sent.length, 1);
  assert.deepEqual(res.content[0].input, { path: '/a', content: 'b' });
});
atest('a bare tool name that matches one namespaced tool is renamed, no extra call', async () => {
  const llm = scripted([reply([tu('write_file', { path: '/a', content: 'b' }), tu('board_post', { note: 'x' })])]);
  const res = await run(llm, { tools: WORKER_TOOLS, messages: [{ role: 'user', content: 'Begin' }] });
  assert.equal(llm.sent.length, 1);
  assert.equal(res.content[0].name, 'files__write_file');
});
atest('unfixable arguments and unknown tools get error results and a retry', async () => {
  const llm = scripted([
    reply([tu('files__write_file', { _raw: 'write b to /a' }, 'x1'), tu('files__delete', { path: '/a' }, 'x2'), tu('board_post', { note: 'ok' }, 'x3')]),
    reply([tu('files__write_file', { path: '/a', content: 'b' })]),
  ]);
  const res = await run(llm, { tools: WORKER_TOOLS, messages: [{ role: 'user', content: 'Begin' }] });
  assert.equal(llm.sent.length, 2);
  const results = llm.sent[1].messages.at(-1).content;
  assert.equal(results.length, 3, 'every call in the bad reply gets a result');
  assert.match(results[0].content, /not valid JSON/);
  assert.match(results[1].content, /no tool named "files__delete"/);
  assert.match(results[2].content, /Not run/);
  assert.ok(results.every((r) => r.is_error));
  assert.deepEqual(res.content[0].input, { path: '/a', content: 'b' });
});

for (const [name, fn] of asyncTests) {
  try { await fn(); } catch (err) { failures++; console.error(`FAIL ${name}\n  ${err.message.split('\n').join('\n  ')}`); }
}

if (failures) { console.error(`${failures} guard test(s) failed`); process.exit(1); }
console.log('guard tests passed');
