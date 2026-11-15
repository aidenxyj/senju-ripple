// Turn-level rules: the guard as a wrapper around a model client.
//
//   guardLlm(llm, opts) -> { create(params, { signal }) }      same shape as adapter/ and the swarm engine's client
//
// Every reply goes through three steps before the Swarm sees it:
//   1. Repair: each tool call's arguments are fixed with repair() against that tool's input_schema.
//      If any call cannot be fixed (or names a tool that does not exist), the model is asked again,
//      with an error result for each call so it knows what to change.
//   2. Lead must delegate: a lead that ends its turn before it has ever called spawn_agent is asked again
//      to start workers instead of answering the goal itself.
//   3. Worker acts before done: a worker that ends its turn before it has done any of the work (only board
//      or wait calls so far) is asked to start, and one that announces a next step ("I'll open ...") with no
//      tool call is asked to make that call. A reply without a tool call ends a worker's subtask.
//   4. Worker posts before done: a worker that finishes without ever posting to the shared board is
//      asked to post first. Works for the board_post tool and for `senju board post` / `senju done` in sh.
// At most `maxRetries` extra calls per reply. If the model still breaks a rule, its last reply goes through
// unchanged and the Swarm's own handling takes over. Usage is summed over every call made.
import { repair } from './repair.js';

export const NUDGE_SPAWN = 'You have not started any workers yet, and replying without a tool call ends the job. ' +
  'Do not do the work or answer from your own knowledge. Call spawn_agent now to start the workers this goal needs, then call wait.';
export const NUDGE_ACT = 'You have not done any of the work yet, and a reply without a tool call ends your subtask. ' +
  'Start now: make the first tool call the goal needs (in sh, for example senju open <url>), then go on step by step. Report only after you have done the work.';
export const NUDGE_SAID = 'You said what you will do next but called no tool, and a reply without a tool call ends your subtask. Make that call now.';
export const NUDGE_POST = 'Before you finish, post your key result on the shared board so the other workers and the lead can use it ' +
  '(one or two lines: what you found or did, with exact values). Use board_post, or `senju board post "..."` in sh. Then finish.';

const toolUses = (content) => (Array.isArray(content) ? content.filter((b) => b?.type === 'tool_use') : []);
const isSh = (name) => name === 'sh' || (typeof name === 'string' && name.endsWith('__sh'));
const shCmd = (block) => (isSh(block.name) && typeof block.input?.cmd === 'string' ? block.input.cmd : '');
const postsToBoard = (block) => block.name === 'board_post' || /(^|\n|&&|;)\s*(senju\s+)?board\s+post\b/.test(shCmd(block));
const saysDone = (block) => /(^|\n|&&|;)\s*(senju\s+)?done\b/.test(shCmd(block));

// Calls that only coordinate (the board, waiting, messages). Anything else, or an sh line other than
// senju board/done/wait/help, is work.
const COORD_TOOLS = new Set(['board_post', 'board_read', 'wait_for', 'wait', 'tell_agent', 'tell_lead', 'claim', 'release']);
const COORD_SH = /^\s*(senju\s+)?(board|done|wait|help)\b/;
function isWork(block) {
  if (COORD_TOOLS.has(block.name)) return false;
  if (isSh(block.name)) return shCmd(block).split(/\n|&&|;/).some((l) => l.trim() && !COORD_SH.test(l));
  return true;
}
const textOf = (content) => (Array.isArray(content) ? content.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('\n') : String(content ?? '')).trim();
// A short reply that only says what comes next ("I'll open Chrome.", "Let me look at the page:").
function announces(text) {
  if (!text || text.length > 400) return false;
  return /^(ok(ay)?[,.]?\s+)?(i'?ll|i will|i'?m going to|let me|let's|now,? i|next,? i|first,? i|i need to|starting|opening|going to)\b/i.test(text) || /:\s*$/.test(text);
}

function priorCalls(messages) {
  const out = [];
  for (const m of messages ?? []) if (m.role === 'assistant') out.push(...toolUses(m.content));
  return out;
}

// -> null when the turn is fine, or { rule, nudge }
export function reviewTurn(params, res, { leadMustSpawn = true, workerMustPost = true, workerMustAct = true } = {}) {
  const tools = params.tools ?? [];
  const calls = toolUses(res.content);
  const before = priorCalls(params.messages);
  const isLead = tools.some((t) => t.name === 'spawn_agent');
  if (isLead) {
    if (leadMustSpawn && calls.length === 0 && res.stop_reason !== 'max_tokens' && !before.some((c) => c.name === 'spawn_agent')) {
      return { rule: 'lead-must-spawn', nudge: NUDGE_SPAWN };
    }
    return null;
  }
  if (workerMustAct && res.stop_reason !== 'max_tokens') {
    const finishing = calls.length === 0 || calls.some(saysDone);
    if (finishing && !before.some(isWork) && !calls.some(isWork) && tools.some((t) => !COORD_TOOLS.has(t.name))) return { rule: 'worker-must-act', nudge: NUDGE_ACT };
    if (calls.length === 0 && announces(textOf(res.content))) return { rule: 'said-not-did', nudge: NUDGE_SAID };
  }
  const canPost = tools.some((t) => t.name === 'board_post' || isSh(t.name));
  if (workerMustPost && canPost && res.stop_reason !== 'max_tokens') {
    const finishing = calls.length === 0 || calls.some(saysDone);
    const posted = before.some(postsToBoard) || calls.some(postsToBoard);
    if (finishing && !posted) return { rule: 'worker-must-post', nudge: NUDGE_POST };
  }
  return null;
}

// -> { content, errors: [{ id, error }] }   content has repaired inputs; errors lists the calls that could not be fixed
export function repairTurn(params, res) {
  const schemas = new Map((params.tools ?? []).map((t) => [t.name, t.input_schema]));
  const errors = [];
  const content = (res.content ?? []).map((block) => {
    if (block?.type !== 'tool_use') return block;
    // A bare MCP tool name (read_file for files__read_file) that matches exactly one namespaced tool.
    if (!schemas.has(block.name)) {
      const hits = [...schemas.keys()].filter((n) => n.endsWith(`__${block.name}`));
      if (hits.length === 1) block = { ...block, name: hits[0] };
    }
    if (!schemas.has(block.name)) {
      const names = [...schemas.keys()];
      errors.push({ id: block.id, error: `There is no tool named "${block.name}". Use one of: ${names.slice(0, 40).join(', ')}${names.length > 40 ? ', ...' : ''}.` });
      return block;
    }
    const r = repair(block, schemas.get(block.name));
    if (r.error) { errors.push({ id: block.id, error: r.error }); return block; }
    return r.call;
  });
  return { content, errors };
}

const addUsage = (a, b) => ({
  ...a,
  input_tokens: (a?.input_tokens ?? 0) + (b?.input_tokens ?? 0),
  output_tokens: (a?.output_tokens ?? 0) + (b?.output_tokens ?? 0),
});

export function guardLlm(llm, { maxRetries = 2, leadMustSpawn = true, workerMustPost = true, workerMustAct = true, onEvent = null } = {}) {
  return {
    async create(params, opts) {
      let messages = params.messages;
      let usage = null;
      let res;
      for (let attempt = 0; ; attempt++) {
        res = await llm.create({ ...params, messages }, opts);
        usage = usage ? addUsage(usage, res.usage) : res.usage;
        const last = attempt >= maxRetries;
        const fixed = repairTurn(params, res);
        if (fixed.errors.length) {
          onEvent?.({ type: 'repair-failed', errors: fixed.errors, attempt });
          if (last) break;
          const bad = new Map(fixed.errors.map((e) => [e.id, e.error]));
          const results = toolUses(res.content).map((b) => ({
            type: 'tool_result', tool_use_id: b.id, is_error: true,
            content: bad.get(b.id) ?? 'Not run, because another call in this reply had invalid arguments. Send it again with the fixed call.',
          }));
          messages = [...messages, { role: 'assistant', content: res.content }, { role: 'user', content: results }];
          continue;
        }
        res = { ...res, content: fixed.content };
        const issue = reviewTurn({ ...params, messages }, res, { leadMustSpawn, workerMustPost, workerMustAct });
        if (!issue) break;
        onEvent?.({ type: 'nudge', rule: issue.rule, attempt });
        if (last) break;
        // Keep the model's words, drop its tool calls (none ran), and ask again.
        const said = (res.content ?? []).filter((b) => b.type === 'text' && b.text?.trim());
        const results = toolUses(res.content).map((b) => ({ type: 'tool_result', tool_use_id: b.id, is_error: true, content: 'Not run yet.' }));
        messages = [
          ...messages,
          { role: 'assistant', content: [...(said.length ? said : [{ type: 'text', text: '(no reply)' }]), ...toolUses(res.content)] },
          { role: 'user', content: [...results, { type: 'text', text: issue.nudge }] },
        ];
      }
      return { ...res, usage };
    },
  };
}
