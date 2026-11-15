// harness/: wires guard/, context/, sched/ and adapter/ into the swarm engine's Swarm so it runs on Ripple.
// Order per call: Swarm -> guard.guardLlm -> context.fit -> sched.limit -> adapter.
// With `shell`, workers act on those servers through one senju `sh` tool (shell/) instead of raw MCP tools.
//
//   const llm = await makeRippleStack({ env: process.env })
//   const swarm = await makeRippleSwarm({ config, workspace, emit })
import { Swarm } from '../app/src/orchestrator.js';
import { rippleFromEnv } from '../adapter/index.js';
import { limitLlm } from '../sched/index.js';
import * as guardMod from '../guard/index.js';
import { guardLlm } from '../guard/index.js';
import { connectServer } from '../app/src/mcp.js';
import { createShell, shellConnection } from '../shell/index.js';
import * as eyes from '../eyes/index.js';

/** Loads context/ if it is present; null otherwise. */
async function loadContext() {
  try { return await import('../context/index.js'); } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND') return null;
    throw err;
  }
}

/**
 * Model stack every Ripple call goes through: guardLlm -> context.fit -> sched.limit -> adapter.
 * @param {object} o
 * @param {object} [o.env]            RIPPLE_* settings (process.env by default)
 * @param {object} [o.llm]            base model client; defaults to the Ripple adapter (tests pass a fake)
 * @param {number} [o.concurrency]    at most this many model calls in flight (default 4)
 * @param {number} [o.contextBudget]  input tokens per call, system + tools + messages (default 32000, see docs/ripple-notes.md)
 * @param {object|null} [o.context] context/ module to use; null turns trimming off; default loads ../context/
 * @param {boolean|object} [o.guard] guardLlm options; false turns guard off (for --no-guard baselines)
 * @param {Function} [o.onGuard]      guard events (repair-failed, nudge)
 * @param {Function} [o.onCall]       ({ who, ms, stop, inTokens, trimmedFrom, trimmedTo }) after each call, for traces and evals
 */
export async function makeRippleStack({ env = process.env, llm, concurrency = 4, contextBudget = 32000, onCall, context: ctxOpt, guard = true, onGuard } = {}) {
  const base = llm ?? rippleFromEnv(env);
  const context = ctxOpt === undefined ? await loadContext() : ctxOpt;
  const limited = limitLlm(base, concurrency);
  const inner = {
    async create(params, opts) {
      let messages = params.messages;
      let trimmedFrom = null;
      if (context) {
        const before = context.countMessages?.(messages);
        messages = context.fit(messages, { maxTokens: contextBudget, system: params.system, tools: params.tools });
        if (messages !== params.messages) trimmedFrom = before;
      }
      const t0 = Date.now();
      const res = await limited.create({ ...params, messages }, opts);
      onCall?.({
        who: whoOf(params),
        ms: Date.now() - t0,
        stop: res.stop_reason,
        inTokens: (res.usage?.input_tokens ?? 0) + (res.usage?.cache_read_input_tokens ?? 0),
        trimmedFrom,
        trimmedTo: trimmedFrom != null ? context.countMessages?.(messages) : null,
        tools: res.content.filter((b) => b.type === 'tool_use').map((b) => b.name),
      });
      return res;
    },
  };
  const outer = guard ? guardLlm(inner, { ...(guard === true ? {} : guard), onEvent: onGuard }) : inner;
  return { hasContext: Boolean(context), hasGuard: Boolean(guard), create: (params, opts) => outer.create(params, opts) };
}

/** Which agent a request belongs to: 'lead' or the worker's name (from its system prompt). */
export function whoOf(params) {
  if (params.tools?.some((t) => t.name === 'spawn_agent')) return 'lead';
  const sys = Array.isArray(params.system) ? params.system[0]?.text : params.system;
  return String(sys ?? '').match(/^You are "([^"]+)"/)?.[1] ?? 'worker';
}

/** Ripple-safe Swarm config: no server-side context management (Ripple has none), so the swarm engine's client-side trim stays on as a backstop. */
export function rippleConfig(config = {}) {
  return { maxAgents: 4, maxSteps: 60, ...config, model: config.model ?? 'ripple', context: { ...(config.context ?? {}), enabled: false } };
}

/**
 * A Swarm `connect` override: servers named in `shellServers` reach workers as one tool, `<server>__sh`,
 * running senju commands (shell/) on the real MCP connection. Other servers connect as usual.
 * `getSwarm` returns the Swarm, for the hooks (confirm and ask go to the person; board and wait go to the swarm).
 */
export function shellConnect(getSwarm, { shellServers = ['browser'], connect = connectServer, guard, approvals = createApprovals(), kept = null, autoWaitSignIn = true, signInTimeoutMs } = {}) {
  const wanted = new Set(shellServers);
  return async (name, spec, agent) => {
    if (!wanted.has(name)) return connect(name, spec, agent);
    // The catalog load (no agent) only needs the tool list, so it skips starting a browser.
    if (!agent) return shellConnection(createShell({ conn: null, guard: guard ?? noSecretsGuard() }), { name });
    const real = await connect(name, spec, agent);
    const shell = createShell({ conn: real, agent: { id: agent.id, name: agent.name }, guard: guard ?? noSecretsGuard(), hooks: shellHooks(getSwarm, agent, approvals) });
    const sc = shellConnection(shell, { name, conn: real });
    if (autoWaitSignIn) {
      // Any sh call that lands on a sign-in page waits there for the person instead of returning the login wall.
      const call = sc.client.callTool.bind(sc.client);
      sc.client.callTool = async (req, ...rest) => {
        const tool = `${name}__sh`;
        const st = signInState.get(agent.name) ?? { onSignIn: false, tool };
        signInState.set(agent.name, st);
        const wait = async (first) => {
          const out = await waitForSignIn({ swarm: getSwarm(), agent, conn: real, shell, first, signal: agent.abort?.signal, ...(signInTimeoutMs ? { timeoutMs: signInTimeoutMs } : {}) });
          st.onSignIn = /^ok\nThe page needed a sign-in/.test(out) ? false : st.onSignIn;
          return { content: [{ type: 'text', text: out }], isError: false };
        };
        // senju done while on a sign-in page: do not stop, wait for the person first.
        if (st.onSignIn && /\bsenju\s+done\b/.test(String(req?.arguments?.cmd ?? ''))) return wait(`page: sign-in\n`);
        const res = await call(req, ...rest);
        const text = (res.content ?? []).map((c) => c.text ?? '').join('\n');
        if (/^(?:page|title|url): /m.test(text)) st.onSignIn = isSignInPage(text);
        if (res.isError || !isSignInPage(text)) return res;
        st.onSignIn = true;
        return wait(text);
      };
    }
    // keepBrowsers: a finished worker's window stays on screen; it is closed with the next job or at shutdown.
    if (kept) sc.close = async () => { kept.add(real); };
    return sc;
  };
}

// ---- Sign-ins: the person types credentials, never the model (handoff, then take over).
const SECRET_FIELD = /pass(word|code|phrase)?\b|\bpin\b|one.?time|verification code|security code|2fa|otp|\bcvv\b|\bcvc\b|card number/i;
const ASKS_FOR_SECRET = /\b(password|passcode|credentials?|log.?in details|sign.?in details|username and password|email and password|verification code|2fa|otp|one.?time code|card number|cvv)\b/i;

/** guard for the shell that also refuses typing into password, code and card fields. Wraps guard/'s shared guard. */
export function noSecretsGuard(base = guardMod) {
  return {
    check(agent, action) {
      const el = action?.element;
      if (action?.verb === 'type' && el && (el.secret || SECRET_FIELD.test(`${el.name ?? ''} ${el.placeholder ?? ''} ${el.role ?? ''}`))) {
        return { deny: true, reason: `"${el.name || 'this field'}" is a password, code or card field. Never type into it. Call handoff and ask the person to sign in themselves in this window; then senju look to continue.` };
      }
      return base.check(agent, action);
    },
    record: (...a) => base.record?.(...a),
    reset: (...a) => base.reset?.(...a),
  };
}

/** Turns a worker's ask_user that asks for a password or login details into a handoff: the person signs in in the window instead. */
export function withNoCredentialAsks(stack) {
  return {
    ...stack,
    async create(params, opts) {
      const res = await stack.create(params, opts);
      if (!Array.isArray(res?.content)) return res;
      let changed = false;
      const content = res.content.map((b) => {
        if (b.type !== 'tool_use' || b.name !== 'ask_user' || !ASKS_FOR_SECRET.test(String(b.input?.question ?? ''))) return b;
        changed = true;
        return { ...b, name: 'handoff', input: {
          reason: 'This needs a sign-in. You type your details into the page yourself; Senju never sees them.',
          steps_for_user: 'In the browser window this agent is using, sign in (email, password and any code), then click Done here.',
          done_when: 'the page no longer shows a sign-in form',
        } };
      });
      return changed ? { ...res, content } : res;
    },
  };
}

// ---- Sign-in walls: a worker never stops at a login page. It raises the sign-in to the person and waits.
const LOGIN_URL = /(\/log-?in\b|\/sign-?in\b|\/sign_in\b|\/sso\b|\/sso-login|\/saml|\/idp\/|\/cas\/|\/oauth|\/auth\/|duosecurity\.com|accounts\.google\.com\/(v3\/)?signin|login\.microsoftonline|^https?:\/\/(login|signin|sso|idp|auth|weblogin)\.)/i;
const LOGIN_TITLE = /\b(log ?in|sign ?in|single sign-on|two-step|2-step|verify (it'?s|that it'?s) you|authenticat|duo security)\b/i;
const PASSWORD_FIELD = /\btextbox "[^"]*pass(word|code)[^"]*"/i;

/** Where a senju output says the page is now: { title, url } (for a diff, the new side of "a -> b"). */
export function pageOf(text) {
  const t = String(text ?? '');
  const last = (re) => { const m = [...t.matchAll(re)].at(-1); return m ? m[1].split(' -> ').at(-1).replace(/^"|"$/g, '').trim() : ''; };
  return { title: last(/^(?:page|title): (.+)$/gm), url: last(/^url: (.+)$/gm) };
}

/** True when a senju output shows a sign-in, SSO or two-factor page. */
export function isSignInPage(text) {
  const { title, url } = pageOf(text);
  if (!title && !url && !PASSWORD_FIELD.test(String(text))) return false;
  return LOGIN_URL.test(url) || LOGIN_TITLE.test(title) || PASSWORD_FIELD.test(String(text));
}

/**
 * Hold at a sign-in wall: raise a sign-in card to the person (with its Done button), watch the page every `everyMs`,
 * and continue as soon as it is past the sign-in (twice in a row), or once the person clicks Done and the page agrees.
 * Returns the signed-in page for the worker to carry on from.
 */
export async function waitForSignIn({ swarm, agent, conn, shell, first, signal, everyMs = 2000, timeoutMs = 15 * 60 * 1000, observe = eyes.observe }) {
  const { title, url } = pageOf(first);
  const where = title || url || 'a sign-in page';
  const prev = { status: agent.status, label: agent.label };
  const setStatus = (status, label) => { Object.assign(agent, { status, label }); swarm.emit({ type: 'agent', id: agent.id, status, label, server: agent.server, paused: agent.paused }); };
  setStatus('waiting', 'waiting for you to sign in');
  let answered = false;
  const human = swarm.requestHuman(agent.id, {
    kind: 'handoff',
    reason: `${agent.name} reached a sign-in page: ${where}.`,
    steps: 'Sign in yourself in that browser window, including any two-factor step. Senju never sees your password. Click Done when you are in; Senju also notices by itself and carries on.',
    doneWhen: 'the page is past the sign-in',
  }, signal).then(() => { answered = true; }, () => { answered = true; });
  const qid = `q${swarm.qseq}`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const t0 = Date.now();
  let clear = 0, signedIn = false;
  try {
    while (Date.now() - t0 < timeoutMs) {
      if (signal?.aborted) throw new Error('cancelled');
      await sleep(everyMs);
      let text = '';
      try { text = (await observe(conn, undefined, { maxChars: 6000 })).text; } catch { continue; }
      clear = isSignInPage(text) ? 0 : clear + 1;
      if (clear >= 2 || (answered && clear >= 1)) { signedIn = true; break; }
    }
  } finally {
    if (!answered) swarm.answer(qid, signedIn ? 'Signed in (Senju noticed)' : 'Timed out waiting for the sign-in');
    setStatus(prev.status === 'waiting' ? 'acting' : (prev.status ?? 'acting'), prev.label ?? '');
  }
  await human;
  if (!signedIn) return `${first}\n\nThe person did not sign in within ${Math.round(timeoutMs / 60000)} minutes. Report that you are blocked at the sign-in page.`;
  const fresh = await shell.run('senju look');
  return `ok\nThe page needed a sign-in, and the person has now signed in. You are past it: carry on with the task from here. Do not report the sign-in as a blocker.\n${fresh.replace(/^ok\n?/, '')}`;
}

/** Per worker: is its browser on a sign-in page right now? (shell outputs set it; a worker may not finish while it is.) */
export const signInState = new Map();   // worker name -> { onSignIn, tool }

/**
 * A worker that tries to finish (a reply with no tool call) while its browser is on a sign-in page is not allowed to
 * stop: its reply becomes a `senju look`, which raises the sign-in to the person and waits there.
 */
export function withNoStopAtSignIn(stack, state = signInState) {
  return {
    ...stack,
    async create(params, opts) {
      const res = await stack.create(params, opts);
      const who = whoOf(params);
      const st = state.get(who);
      if (who === 'lead' || !st?.onSignIn || !Array.isArray(res?.content) || res.content.some((b) => b.type === 'tool_use')) return res;
      return { ...res, stop_reason: 'tool_use', content: [...res.content.filter((b) => b.type === 'text'), { type: 'tool_use', id: `signin_${Date.now()}`, name: st.tool, input: { cmd: 'senju look' } }] };
    },
  };
}

// ---- Waiting is not done. Workers get a `waiting` tool; a worker that says it is waiting may not finish.
export const WAITING_TOOL = {
  name: 'waiting',
  description: 'Wait, without finishing your subtask. Use it whenever you cannot go on until another worker reports (for: "worker", worker: its name) or until the person does something (for: "user", what: exactly what they need to do, and where). It returns the worker\'s report or the person\'s answer, and then you carry on with your subtask. Waiting is never the same as being done: do not report or call senju done while you are waiting for something.',
  input_schema: {
    type: 'object',
    properties: {
      for: { type: 'string', enum: ['worker', 'user'], description: 'who you are waiting for' },
      worker: { type: 'string', description: 'for: "worker": the worker\'s name' },
      what: { type: 'string', description: 'for: "user": what the person needs to do, and in which window' },
      reason: { type: 'string', description: 'why you need it, in a few words' },
    },
    required: ['for'],
  },
};
const WAITING_NOTE = 'Waiting is not done. If you cannot go on until another worker reports or until the person does something, call the waiting tool and carry on afterwards. Never end your subtask, report, or run senju done while you are still waiting for something.';
const SAYS_WAITING = /\b(i(?:'m| am| will| 'll)? (?:now )?(?:be )?wait(?:ing)?|waiting (?:for|on|until)|wait (?:for|until|on)|once (?:\w+ ){0,4}(?:finishes|is done|has finished|reports|replies|signs? in|uploads?|approves?|confirms?)|after (?:\w+ ){0,4}(?:finishes|signs? in|reports)|until (?:the (?:user|person)|you) (?:\w+ ){0,3}(?:sign|upload|approve|confirm|log)|blocked (?:on|until|waiting))\b/i;

/**
 * Gives every worker the `waiting` tool and runs it inside the model call: it waits (for a worker through the
 * Swarm's waitFor, for the person through a card with Done), then asks the model again with the result, so the
 * worker carries on instead of finishing. A worker that tries to finish while saying it is waiting is told to call
 * waiting instead. The lead keeps its own wait tool.
 */
export function withWaiting(stack, getSwarm, { maxWaits = 6 } = {}) {
  return {
    ...stack,
    async create(params, opts = {}) {
      const who = whoOf(params);
      if (who === 'lead' || !params.tools) return stack.create(params, opts);
      const tools = params.tools.some((t) => t.name === 'waiting') ? params.tools : [...params.tools, WAITING_TOOL];
      const system = Array.isArray(params.system) ? [...params.system, { type: 'text', text: WAITING_NOTE }] : `${params.system ?? ''}\n\n${WAITING_NOTE}`;
      let messages = params.messages;
      const waited = [];
      let nudged = false;
      for (let round = 0; ; round++) {
        const res = await stack.create({ ...params, system, tools, messages }, opts);
        const content = Array.isArray(res?.content) ? res.content : [];
        const waits = content.filter((b) => b.type === 'tool_use' && b.name === 'waiting');
        const others = content.filter((b) => b.type === 'tool_use' && b.name !== 'waiting');
        const text = content.filter((b) => b.type === 'text').map((b) => b.text).join(' ');
        // Finishing while saying it is waiting: not allowed, once per turn.
        if (!waits.length && !others.length && !nudged && SAYS_WAITING.test(text) && round < maxWaits) {
          nudged = true;
          messages = [...messages, { role: 'assistant', content: content.length ? content : [{ type: 'text', text: '(waiting)' }] },
            { role: 'user', content: 'You said you are waiting, so you are not done. Do not finish: call the waiting tool now (for: "worker" with its name, or for: "user" with what they need to do).' }];
          continue;
        }
        if (!waits.length || round >= maxWaits) return waited.length ? withWaitNotes(res, waited) : res;
        // Run the waits here (they never reach the Swarm), then ask again with their results.
        const results = [];
        for (const w of waits) results.push({ type: 'tool_result', tool_use_id: w.id, content: [{ type: 'text', text: await runWait(getSwarm(), who, w.input ?? {}, opts.signal) }] });
        // Other calls in the same reply did not run: say so, the model sends them again if still needed.
        for (const o of others) results.push({ type: 'tool_result', tool_use_id: o.id, is_error: true, content: [{ type: 'text', text: 'Not run: you were waiting first. Send it again now if you still need it.' }] });
        waited.push(...waits.map((w, i) => `${describeWait(w.input)} -> ${String(results[i].content[0].text).slice(0, 300)}`));
        messages = [...messages, { role: 'assistant', content }, { role: 'user', content: results }];
      }
    },
  };
}

const describeWait = (i = {}) => (i.for === 'worker' ? `waited for worker "${i.worker ?? '?'}"` : `waited for the person: ${i.what ?? i.reason ?? ''}`);
// The waits happened inside this call, so the Swarm's history does not show them; a short note keeps the worker's memory.
function withWaitNotes(res, waited) {
  const note = { type: 'text', text: `(While working I ${waited.join('; ')}.)` };
  return { ...res, content: [note, ...(res.content ?? [])] };
}

async function runWait(swarm, who, input, turnSignal) {
  const agent = swarm?.find?.(who);
  if (!agent) return `error: no worker named "${who}"`;
  const signal = turnSignal && agent.abort?.signal ? AbortSignal.any([turnSignal, agent.abort.signal]) : (turnSignal ?? agent.abort?.signal ?? new AbortController().signal);
  const set = (status, label) => { Object.assign(agent, { status, label }); swarm.emit({ type: 'agent', id: agent.id, status, label, server: agent.server, paused: agent.paused }); };
  const before = { status: agent.status, label: agent.label };
  try {
    if (input.for === 'worker') {
      const name = String(input.worker ?? '').trim();
      if (!name) return 'error: say which worker to wait for (worker: its name).';
      set('blocked', `waiting for ${name}`);
      return await swarm.waitFor(agent, [name], signal);
    }
    const what = String(input.what ?? input.reason ?? '').trim();
    if (!what) return 'error: say what the person needs to do (what: ...).';
    set('waiting', 'waiting for you');
    const reply = await swarm.requestHuman(agent.id, { kind: 'task', task: what, where: '', doneWhen: '', replyHint: input.reason ? String(input.reason) : '' }, signal);
    return `The person replied: ${reply}. Check the result yourself, then carry on.`;
  } finally {
    if (!signal.aborted) set(before.status === 'waiting' || before.status === 'blocked' ? 'acting' : (before.status ?? 'acting'), before.label ?? '');
  }
}

/**
 * How long an action waits for its ghost cursor (the overlay glides in about 0.2 to 0.35 s; the browser call that
 * follows adds about 0.1 s, so the click lands as the cursor arrives). Keys do not wait: the cursor is already
 * there. Opening a page also waits while the overlay types the url into the address bar (point.typeMs).
 */
export const POINT_LEAD_MS = 160;
export const pointLeadMs = (point) => (point?.verb === 'key' ? 0 : POINT_LEAD_MS + (point?.verb === 'open' ? Number(point.typeMs) || 0 : 0));

export function shellHooks(getSwarm, agent, approvals = createApprovals()) {
  const swarm = () => getSwarm();
  const signal = () => agent.abort?.signal ?? new AbortController().signal;
  const ask = (payload) => swarm().requestHuman(agent.id, payload, signal());
  return {
    async confirm(card) {
      if (approvals.has(agent.name, card.kind)) return true;   // the person already approved all of this kind for this worker
      const all = `Approve all ${PLURAL[card.kind] ?? 'of these'}`;
      const reply = await ask({ kind: 'question', question: `${card.title}: ${card.detail}`, options: [all, 'Approve this one', 'Decline'] });
      if (/^\s*approve all|^\s*all\b|yes to all/i.test(reply)) { approvals.grant(agent.name, card.kind); return true; }
      return /^\s*(approve|yes|y|ok|go)\b/i.test(reply) && !/declin/i.test(reply);
    },
    ask: async (question) => `The person answered: ${await ask({ kind: 'question', question: String(question), options: [] })}`,
    boardPost(note) {
      const s = swarm(), text = String(note);
      s.board.push({ from: agent.name, note: text });
      s.emit({ type: 'board', from: agent.name, note: text });
      for (const other of s.live()) if (other.id !== agent.id) other.inbox.push({ from: 'board', name: agent.name, text });
      return 'posted';
    },
    boardRead: () => swarm().board.map((b) => ({ from: b.from, note: b.note })),
    wait: (worker) => swarm().waitFor(agent, [String(worker)], signal()),
    done: () => 'Now reply with your final report as plain text, with no tool call. That ends your subtask.',
    // shell/ calls this just before click, type or select with the element's centre (window and screen px).
    // The app glides this agent's ghost cursor there; waiting a moment lets it arrive before the click lands.
    async pointAt(point) {
      swarm().emit({ type: 'point', agentId: agent.id, point });
      const ms = pointLeadMs(point);
      if (ms) await new Promise((r) => setTimeout(r, ms));
    },
  };
}

/**
 * Approvals the person gave "for all" during one job, per worker: kinds (send, pay, delete).
 * Once a kind is granted to a worker, guard's confirm cards for that worker and kind pass without another click.
 */
export function createApprovals() {
  // Keyed by worker: one worker's "Approve all sends" never lets another worker send.
  const grants = new Map();   // worker name -> Set(kind)
  const of = (who) => { if (!grants.has(who)) grants.set(who, new Set()); return grants.get(who); };
  return {
    grants,
    has: (who, kind) => grants.get(who)?.has(kind) ?? false,
    grant: (who, ...kinds) => kinds.forEach((k) => k && of(who).add(k)),
    reset: () => grants.clear(),
  };
}

const KIND_WORDS = { delete: /\b(delet|remov|trash|discard|eras)/i, send: /\b(send|sent|email|mail|message|reply|post|forward)/i, pay: /\b(pay|buy|purchas|order|checkout)/i };
const PLURAL = { delete: 'deletes', send: 'sends', pay: 'payments' };
export const kindsIn = (text) => Object.keys(KIND_WORDS).filter((k) => KIND_WORDS[k].test(String(text ?? '')));
const approvesAll = (answer) => /^\s*(the user answered:\s*)?(approve all|yes to all|all|approve|yes|ok|go)\b/i.test(String(answer ?? '')) && !/declin|\bno\b|don't|do not/i.test(String(answer ?? ''));

/**
 * Watches each worker request: when the worker asked the person with ask_user about sends/deletes/payments
 * and the person approved, those kinds are granted for the rest of the job (one click for the whole batch).
 */
export function withBatchApprovals(stack, approvals) {
  return {
    ...stack,
    create(params, opts) {
      const msgs = params.messages ?? [];
      const who = whoOf(params);
      for (let i = msgs.length - 1; i >= 1 && i >= msgs.length - 4; i--) {
        const m = msgs[i], prev = msgs[i - 1];
        if (m.role !== 'user' || !Array.isArray(m.content) || prev?.role !== 'assistant' || !Array.isArray(prev.content)) continue;
        for (const use of prev.content.filter((b) => b.type === 'tool_use' && b.name === 'ask_user')) {
          const res = m.content.find((b) => b.type === 'tool_result' && b.tool_use_id === use.id);
          const text = typeof res?.content === 'string' ? res.content : (res?.content ?? []).map((c) => c.text ?? '').join('');
          if (res && approvesAll(text)) approvals.grant(who, ...kindsIn(use.input?.question));
        }
      }
      return stack.create(params, opts);
    },
  };
}

/** Told to every agent that has a senju sh tool. Ripple is terminal-trained, so it chains commands and reaches for screenshots. */
export const SHELL_NOTE = `How you see and act: through the sh tool only. There are no screenshots and no images: \`senju look\` is how you see the screen, and every action already prints what changed. Never plan or ask for a screenshot. Put each senju command on its own line; do not chain with && or ;. It is not a real shell: ls, cat and other programs do not exist. If a command is not in \`senju help\`, it does not exist.\n\nSends, payments and deletes need the person's approval, so batch them: first look and find every item the goal covers, then call ask_user once listing all of them (for example \"Delete these 5 drafts: A, B, C, D, E\") with the options [\"Approve all\", \"Decline\"]. After \"Approve all\", do every one of them in a single sh call, one command per line. They will not ask again. Never ask once per item.\n\nSign-ins, two-factor codes and CAPTCHAs: never ask for or type a password or code, not even if asked. Call handoff so the person signs in themselves in your window. When handoff returns, senju look. If the page looks unchanged, reload it with senju open <the same url> and look again before handing off a second time.`;

/** Adds SHELL_NOTE to the system prompt of every call whose tools include a senju sh tool, and tells the lead too. */
export function withShellNote(stack) {
  const LEAD_NOTE = 'Workers act through a senju shell with no screenshots or images. Never ask a worker for a screenshot; ask it to report what `senju look` shows. Go straight to work: for a goal one or two workers can do, spawn the workers that do it, with the full goal, at once. Do not spawn a reconnaissance or explore-first worker. Tell workers to batch approvals: find every item first, then ask the person once for all of them.';
  return {
    ...stack,
    create(params, opts) {
      const isLead = params.tools?.some((t) => t.name === 'spawn_agent');
      const hasSh = params.tools?.some((t) => t.name.endsWith('__sh'));
      const note = isLead ? LEAD_NOTE : hasSh ? SHELL_NOTE : null;
      if (!note) return stack.create(params, opts);
      const system = Array.isArray(params.system) ? [...params.system, { type: 'text', text: note }] : `${params.system ?? ''}\n\n${note}`;
      return stack.create({ ...params, system }, opts);
    },
  };
}

/**
 * A Swarm whose every model call goes through the Ripple stack. Extra opts pass through to Swarm.
 * `shell: true` (or a list of server names, default ['browser']) gives workers the senju sh tool for those servers.
 * `keepBrowsers: true` keeps a finished worker's browser window open until the next job starts or shutdown (the app uses it).
 */
export async function makeRippleSwarm({ config, workspace = process.cwd(), emit = () => {}, stack, shell = null, connect, keepBrowsers = false, ...rest } = {}) {
  const base = stack ?? await makeRippleStack();
  const approvals = createApprovals();
  const llm = shell ? withWaiting(withShellNote(withNoStopAtSignIn(withNoCredentialAsks(withBatchApprovals(base, approvals)))), () => swarm) : withWaiting(base, () => swarm);
  let swarm = null;
  const kept = keepBrowsers ? new Set() : null;
  const closeKept = async () => { if (!kept) return; const all = [...kept]; kept.clear(); await Promise.all(all.map((c) => c.close?.().catch?.(() => {}))); };
  const conn = shell ? shellConnect(() => swarm, { connect, approvals, kept, ...(Array.isArray(shell) ? { shellServers: shell } : shell === true ? {} : shell) }) : connect;
  // Grants last one job: a new goal starts with nothing approved. Kept browser windows from the last job close then too.
  const onEvent = (e) => { if (e?.type === 'reset') { approvals.reset(); signInState.clear(); closeKept(); } return emit(e); };
  swarm = new Swarm({ llm, config: rippleConfig(config), workspace, emit: onEvent, ...(conn ? { connect: conn } : {}), ...rest });
  swarm.approvals = approvals;
  swarm.closeBrowsers = closeKept;
  const shutdown = swarm.shutdown.bind(swarm);
  swarm.shutdown = async () => { await shutdown(); await closeKept(); };
  return swarm;
}
