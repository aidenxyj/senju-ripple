// context/: keep one conversation inside a token budget.
//
//   fit(messages, { maxTokens }) -> messages
//   countTokens(text) -> number
//
// Messages are in the swarm engine's Messages shape: { role, content } where content
// is a string or an array of text / image / tool_use / tool_result blocks.
//
// fit never drops the system prompt (it is passed separately and never edited), the
// goal (the first user message) or the newest turn (the last message, plus the
// assistant tool_use it answers). It never splits a tool_use from its tool_result.
// When the conversation is over budget it works in three stages, stopping as soon
// as the estimate fits:
//   1. trim old observations: tool_result contents become a one-line placeholder,
//      oldest first, keeping the newest `keepToolResults` intact for as long as possible;
//   2. summarise: the oldest middle messages collapse into one extractive summary
//      appended to the goal message (deterministic, no model call);
//   3. truncate: if the goal and newest turn alone are still too big, cut the middle
//      out of the longest texts in them (newest observation first, goal last).
// fit is pure: the input array and its messages are never mutated. Messages it does
// not change are returned by reference.

import { countTokens, countMessage, countMessages, countSystem, countTools, countContent, CHARS_PER_TOKEN } from './tokens.js';

export { countTokens, countMessage, countMessages, countBlock, countContent, CHARS_PER_TOKEN } from './tokens.js';

export const TRIMMED = '[old observation trimmed]';
export const SUMMARY_TAG = '[context summary]';
const TRUNC_MARK = (n) => `\n[... ${n} chars trimmed to fit the context ...]\n`;
const MIN_SUMMARY_TOKENS = 40;

const isToolResultMsg = (m) => m?.role === 'user' && Array.isArray(m.content) && m.content.some((b) => b?.type === 'tool_result');
const blocksOf = (content) => (typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []);
const isSummaryBlock = (b) => b?.type === 'text' && typeof b.text === 'string' && b.text.startsWith(SUMMARY_TAG);
const oneLine = (s, max) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** Plain text of a tool_result's content (string or blocks). Images become a marker. */
function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((c) => (c?.type === 'text' ? c.text : c?.type === 'image' ? '[image]' : '')).join('\n');
}

/** First non-empty line of an observation, e.g. `ok` or `error: no such element`. */
function firstLine(text, max = 100) {
  let s = String(text ?? '');
  if (s.startsWith(TRIMMED)) s = s.slice(TRIMMED.length);
  const line = s.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return oneLine(line, max);
}

const isTrimmed = (content) => {
  const t = typeof content === 'string' ? content : Array.isArray(content) && content.length === 1 && content[0]?.type === 'text' ? content[0].text : null;
  return typeof t === 'string' && t.startsWith(TRIMMED);
};

/** Copy of a message with its tool_result contents (and loose images) replaced by placeholders. */
function trimMessage(m) {
  let n = 0;
  const content = m.content.map((b) => {
    if (b?.type === 'image') { n++; return { type: 'text', text: '[old image trimmed]' }; }
    if (b?.type !== 'tool_result' || isTrimmed(b.content)) return b;
    const head = firstLine(resultText(b.content));
    const text = head ? `${TRIMMED} ${head}` : TRIMMED;
    if (countTokens(text) + 4 >= countContent(b.content)) return b;   // already tiny
    n++;
    return { ...b, content: [{ type: 'text', text }] };
  });
  return { message: n ? { ...m, content } : m, trimmed: n };
}

const trimmable = (m) => m?.role === 'user' && Array.isArray(m.content)
  && m.content.some((b) => b?.type === 'image' || (b?.type === 'tool_result' && !isTrimmed(b.content)));

/** Short input of a tool call: the command for `sh`, compact JSON otherwise. */
function describeInput(input) {
  if (input && typeof input === 'object' && Object.keys(input).length === 1 && typeof input.cmd === 'string') return oneLine(input.cmd, 160);
  return oneLine(JSON.stringify(input ?? {}), 160);
}

/** Summary lines for message i (its tool results are reported with the tool_use that asked for them). */
function linesFor(messages, i) {
  const m = messages[i];
  const out = [];
  const blocks = blocksOf(m?.content);
  if (m?.role === 'assistant') {
    const next = messages[i + 1];
    const results = new Map();
    if (isToolResultMsg(next)) for (const b of next.content) if (b?.type === 'tool_result') results.set(b.tool_use_id, b);
    for (const b of blocks) {
      if (b?.type === 'text' && b.text.trim()) out.push(`- you said: ${oneLine(b.text, 200)}`);
      else if (b?.type === 'tool_use') {
        const r = results.get(b.id);
        const got = r ? `${r.is_error ? 'error: ' : ''}${firstLine(resultText(r.content)) || '(empty)'}` : '(no result)';
        out.push(`- ${b.name} ${describeInput(b.input)} -> ${got}`);
      } else if (b?.type === 'compaction' && b.content) out.push(`- earlier summary: ${oneLine(b.content, 400)}`);
    }
  } else {
    const prev = messages[i - 1];
    const asked = new Set(prev?.role === 'assistant' ? blocksOf(prev.content).filter((b) => b?.type === 'tool_use').map((b) => b.id) : []);
    for (const b of blocks) {
      if (isSummaryBlock(b)) out.push(...summaryLines(b.text));
      else if (b?.type === 'text' && b.text.trim()) out.push(`- user: ${oneLine(b.text, 300)}`);
      else if (b?.type === 'tool_result' && !asked.has(b.tool_use_id)) out.push(`- result: ${firstLine(resultText(b.content))}`);
    }
  }
  return out;
}

/** The step lines inside an earlier summary block. */
function summaryLines(text) {
  return String(text).split('\n').filter((l) => l.startsWith('- '));
}

/** Summary text for the given lines, in at most `maxTokens`; the oldest lines go first. */
function renderSummary(lines, count, maxTokens) {
  const header = `${SUMMARY_TAG} ${count} earlier message${count === 1 ? ' was' : 's were'} condensed to save space. What happened, oldest first:`;
  const render = (from) => [header, ...(from > 0 ? [`- (${from} earlier step${from === 1 ? '' : 's'} omitted)`] : []), ...lines.slice(from)].join('\n');
  // Drop oldest lines until it fits. Binary search on the first kept line.
  if (countTokens(render(0)) + 3 <= maxTokens) return render(0);
  let lo = 1, hi = lines.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (countTokens(render(mid)) + 3 <= maxTokens) hi = mid; else lo = mid + 1;
  }
  const text = render(lo);
  return countTokens(text) + 3 <= maxTokens ? text : truncateText(text, Math.max(1, maxTokens - 3));
}

/** Cut the middle out of `text` so it is at most `maxTokens` by the estimate. */
export function truncateText(text, maxTokens) {
  const s = String(text ?? '');
  if (countTokens(s) <= maxTokens) return s;
  let keep = Math.max(0, Math.floor(maxTokens * CHARS_PER_TOKEN) - 60);
  for (;;) {
    const head = Math.ceil(keep * 2 / 3);
    const tail = keep - head;
    const out = keep <= 0 ? TRUNC_MARK(s.length).trim() : `${s.slice(0, head)}${TRUNC_MARK(s.length - keep)}${tail ? s.slice(s.length - tail) : ''}`;
    if (countTokens(out) <= maxTokens || keep <= 0) return out;
    keep = Math.floor(keep * 0.8) - 1;
  }
}

/**
 * Where the newest turn starts: the last message, or the assistant message whose
 * tool calls the last message answers.
 */
function newestTurnStart(messages, goalIdx) {
  let t = messages.length - 1;
  if (t > goalIdx && isToolResultMsg(messages[t]) && messages[t - 1]?.role === 'assistant') t--;
  return Math.max(t, goalIdx);
}

/**
 * Fit a conversation into a token budget and say what was done.
 * @param {Array<{role: string, content: any}>} messages
 * @param {object} opts
 * @param {number} opts.maxTokens        budget for system + tools + messages (estimated)
 * @param {string|object[]} [opts.system] system prompt, counted against the budget, never edited
 * @param {object[]} [opts.tools]         tool definitions, counted against the budget
 * @param {number} [opts.keepToolResults=4] newest tool-result messages kept whole as long as possible
 * @param {number} [opts.summaryTokens]   cap on the summary (default 15% of maxTokens, 300..4000)
 * @returns {{ messages: object[], tokens: number, fits: boolean, trimmed: number, summarized: number, truncated: number, summary: object|null }}
 */
export function fitReport(messages, opts = {}) {
  const { maxTokens, system, tools, keepToolResults = 4 } = opts;
  if (!Array.isArray(messages)) throw new TypeError('fit: messages must be an array');
  if (!(typeof maxTokens === 'number' && maxTokens > 0)) throw new TypeError('fit: maxTokens must be a positive number');
  const summaryCap = opts.summaryTokens ?? Math.min(4000, Math.max(300, Math.floor(maxTokens * 0.15)));
  const fixed = countSystem(system) + countTools(tools);
  const report = { messages: messages.slice(), tokens: 0, fits: true, trimmed: 0, summarized: 0, truncated: 0, summary: null };
  let out = report.messages;
  let tok = out.map(countMessage);
  const sum = (from = 0, to = tok.length) => { let n = 0; for (let i = from; i < to; i++) n += tok[i]; return n; };
  let total = fixed + sum();
  const done = () => { report.messages = out; report.tokens = total; report.fits = total <= maxTokens; return report; };
  if (total <= maxTokens || out.length === 0) return done();

  const firstUser = out.findIndex((m) => m?.role === 'user');
  const goalIdx = firstUser === -1 ? 0 : firstUser;
  const tailStart = newestTurnStart(out, goalIdx);

  // Stage 1: trim old observations, oldest first, the newest `keepToolResults` last.
  const candidates = [];
  for (let i = goalIdx + 1; i < tailStart; i++) if (trimmable(out[i])) candidates.push(i);
  const split = Math.max(0, candidates.length - keepToolResults);
  for (const i of [...candidates.slice(0, split), ...candidates.slice(split)]) {
    if (total <= maxTokens) break;
    const { message, trimmed } = trimMessage(out[i]);
    if (!trimmed) continue;
    out[i] = message;
    const t = countMessage(message);
    total += t - tok[i];
    tok[i] = t;
    report.trimmed += trimmed;
  }
  if (total <= maxTokens) return done();

  // Stage 2: summarise the oldest middle messages into the goal message.
  // A cut at k summarises messages goalIdx+1 .. k-1. Message k must not hold a
  // tool_result (its tool_use would be summarised away). If k is a plain user
  // message it is merged into the goal message so roles still alternate.
  const goal = out[goalIdx];
  const goalBlocks = blocksOf(goal.content).filter((b) => !isSummaryBlock(b));
  const prevSummary = blocksOf(goal.content).filter(isSummaryBlock).flatMap((b) => summaryLines(b.text));
  const lines = out.map((_, i) => (i > goalIdx && i < tailStart ? linesFor(messages, i) : []));
  const goalBaseTokens = countMessage({ content: goalBlocks });
  const cuts = [];
  for (let k = goalIdx + 2; k <= tailStart; k++) if (out[k]?.role === 'assistant' || (out[k]?.role === 'user' && !isToolResultMsg(out[k]))) cuts.push(k);

  const build = (k, allowed) => {
    const stepLines = [...prevSummary];
    for (let i = goalIdx + 1; i < k; i++) stepLines.push(...lines[i]);
    const text = renderSummary(stepLines, k - goalIdx - 1, allowed);
    const merged = out[k]?.role === 'user';
    const content = [...goalBlocks, { type: 'text', text }, ...(merged ? blocksOf(out[k].content) : [])];
    const head = out.slice(0, goalIdx);
    const next = [...head, { ...goal, content }, ...out.slice(merged ? k + 1 : k)];
    return { next, text, merged, blockIndex: goalBlocks.length };
  };

  let chosen = null;
  for (const pass of [1, 2]) {
    for (const k of cuts) {
      const rest = sum(k) + fixed + goalBaseTokens + sum(0, goalIdx);
      const available = maxTokens - rest - 4;
      if (available < MIN_SUMMARY_TOKENS) continue;
      const allowed = Math.min(summaryCap, available);
      if (pass === 1) {
        const full = countTokens(renderSummary([...prevSummary, ...lines.slice(goalIdx + 1, k).flat()], k - goalIdx - 1, Infinity)) + 3;
        if (available < Math.min(summaryCap, full)) continue;
      }
      const b = build(k, allowed);
      const t = countMessages(b.next) + fixed;
      if (t <= maxTokens) { chosen = { k, ...b, allowed }; break; }
    }
    if (chosen) break;
  }
  if (!chosen && cuts.length) {
    const k = cuts.at(-1);
    chosen = { k, ...build(k, MIN_SUMMARY_TOKENS), allowed: MIN_SUMMARY_TOKENS };
  }
  if (chosen) {
    out = chosen.next;
    report.summarized = chosen.k - goalIdx - 1;
    report.summary = { messageIndex: goalIdx, blockIndex: chosen.blockIndex, from: goalIdx + 1, to: chosen.k, maxTokens: chosen.allowed };
    tok = out.map(countMessage);
    total = fixed + sum();
    if (total <= maxTokens) return done();
  }

  // Stage 3: only the goal (+summary) and the newest turn are left and they are
  // still too big. Cut the middle out of the longest texts: the summary first,
  // then the newest turn's observations, then its other texts, then the goal.
  // The newest turn's length in `out`; one less if its first message was merged into the goal.
  const tailLen = messages.length - tailStart - (chosen?.merged && chosen.k === tailStart ? 1 : 0);
  const tailFrom = out.length - tailLen;
  out = out.map((m, i) => (i === goalIdx || i >= tailFrom ? structuredClone(m) : m));
  const gi = goalIdx;
  const slots = [];
  const addSlots = (m, rank, filter = () => true) => {
    if (typeof m.content === 'string') { if (filter(null)) slots.push({ rank, get: () => m.content, set: (s) => { m.content = s; } }); return; }
    for (const b of m.content ?? []) {
      if (!filter(b)) continue;
      if (b?.type === 'text') slots.push({ rank, get: () => b.text, set: (s) => { b.text = s; } });
      else if (b?.type === 'tool_result') {
        if (typeof b.content === 'string') slots.push({ rank, get: () => b.content, set: (s) => { b.content = s; } });
        else for (const c of b.content ?? []) {
          if (c?.type === 'text') slots.push({ rank, get: () => c.text, set: (s) => { c.text = s; } });
          else if (c?.type === 'image') slots.push({ rank, get: () => '', set: () => {}, image: () => { c.type = 'text'; c.text = '[image trimmed]'; delete c.source; } });
        }
      } else if (b?.type === 'image') slots.push({ rank, get: () => '', set: () => {}, image: () => { b.type = 'text'; b.text = '[image trimmed]'; delete b.source; } });
    }
  };
  addSlots(out[gi], 0, (b) => b && isSummaryBlock(b));
  for (let i = tailFrom; i < out.length; i++) if (i !== gi) addSlots(out[i], 1, (b) => b === null || b.type === 'tool_result' || b.type === 'image');
  for (let i = tailFrom; i < out.length; i++) if (i !== gi) addSlots(out[i], 2, (b) => b === null || b.type === 'text');
  addSlots(out[gi], 3, (b) => b === null || !isSummaryBlock(b));
  const recount = () => { total = fixed + countMessages(out); };
  recount();
  for (const rank of [0, 1, 2, 3]) {
    const group = slots.filter((s) => s.rank === rank);
    for (const s of group) if (s.image && total > maxTokens) { s.image(); report.truncated++; recount(); }
    while (total > maxTokens) {
      // Longest first, so one huge page dump goes before several small notes.
      const s = group.filter((x) => !x.image && !x.done).sort((a, b) => countTokens(b.get()) - countTokens(a.get()))[0];
      if (!s) break;
      const cur = countTokens(s.get());
      const floor = rank === 3 ? 30 : 0;
      const target = Math.max(floor, cur - (total - maxTokens) - 2);
      const next = truncateText(s.get(), target);
      s.done = target === floor || next === s.get();
      if (next !== s.get()) { s.set(next); report.truncated++; recount(); }
    }
    if (total <= maxTokens) break;
  }
  return done();
}

/**
 * Fit a conversation into `maxTokens` (estimated). See the top of this file.
 * The 2-argument form counts only the messages; pass `system` (and `tools`)
 * to count them against the budget too. Returns a new array; never mutates.
 * @param {Array<{role: string, content: any}>} messages
 * @param {{ maxTokens: number, system?: any, tools?: object[], keepToolResults?: number, summaryTokens?: number }} opts
 */
export function fit(messages, opts) {
  return fitReport(messages, opts).messages;
}

/** The summarised range rendered as a plain transcript, for a model to summarise. */
export function renderTranscript(messages, { maxChars = 120000, resultChars = 1500 } = {}) {
  const parts = [];
  for (const m of messages) {
    for (const b of blocksOf(m?.content)) {
      if (isSummaryBlock(b)) parts.push(`Earlier summary:\n${b.text}`);
      else if (b?.type === 'text' && b.text.trim()) parts.push(`${m.role}: ${b.text}`);
      else if (b?.type === 'tool_use') parts.push(`${m.role} called ${b.name} ${JSON.stringify(b.input ?? {})}`);
      else if (b?.type === 'tool_result') parts.push(`${b.is_error ? 'error' : 'result'}: ${truncateText(resultText(b.content), Math.floor(resultChars / CHARS_PER_TOKEN))}`);
      else if (b?.type === 'compaction' && b.content) parts.push(`Earlier summary:\n${b.content}`);
    }
  }
  const text = parts.join('\n');
  return text.length > maxChars ? truncateText(text, Math.floor(maxChars / CHARS_PER_TOKEN)) : text;
}

/**
 * Like fit, but when it has to summarise, asks `summarize(transcript) -> Promise<string>`
 * (for example a cheap model call) for the summary text instead of the extractive one.
 * Falls back to the extractive summary if summarize throws or its answer does not fit.
 */
export async function fitAsync(messages, { summarize, ...opts } = {}) {
  const report = fitReport(messages, opts);
  if (!report.summary || typeof summarize !== 'function') return report.messages;
  const { messageIndex, blockIndex, from, to, maxTokens: allowed } = report.summary;
  const goal = messages[messageIndex];
  let text;
  try {
    text = await summarize(renderTranscript([{ role: 'user', content: blocksOf(goal.content).filter(isSummaryBlock) }, ...messages.slice(from, to)]));
  } catch { return report.messages; }
  if (typeof text !== 'string' || !text.trim()) return report.messages;
  const body = `${SUMMARY_TAG} ${to - from} earlier messages were condensed to save space:\n${text.trim()}`;
  const next = report.messages.slice();
  const m = next[messageIndex];
  const content = m.content.slice();
  content[blockIndex] = { type: 'text', text: truncateText(body, Math.max(1, allowed - 3)) };
  next[messageIndex] = { ...m, content };
  const fixed = countSystem(opts.system) + countTools(opts.tools);
  return fixed + countMessages(next) <= Math.max(opts.maxTokens, report.tokens) ? next : report.messages;
}

/**
 * Check a message list against the Messages-format rules fit relies on. Returns a list of
 * problems (empty when valid): roles alternate starting with user, every tool_result
 * answers a tool_use in the message just before it, and every tool_use is answered
 * in the message just after it (unless it is in the last message).
 */
export function checkMessages(messages) {
  const problems = [];
  messages.forEach((m, i) => {
    if (m?.role !== 'user' && m?.role !== 'assistant') problems.push(`message ${i}: bad role ${m?.role}`);
    if (i === 0 && m?.role !== 'user') problems.push('message 0: must be from the user');
    if (i > 0 && m?.role === messages[i - 1]?.role) problems.push(`message ${i}: two ${m.role} messages in a row`);
    const blocks = blocksOf(m?.content);
    if (!blocks.length) problems.push(`message ${i}: empty content`);
    if (m?.role === 'user') {
      const prev = messages[i - 1];
      const asked = new Set(prev?.role === 'assistant' ? blocksOf(prev.content).filter((b) => b?.type === 'tool_use').map((b) => b.id) : []);
      for (const b of blocks) if (b?.type === 'tool_result' && !asked.has(b.tool_use_id)) problems.push(`message ${i}: tool_result ${b.tool_use_id} has no tool_use before it`);
    } else if (m?.role === 'assistant' && i < messages.length - 1) {
      const next = messages[i + 1];
      const answered = new Set(next?.role === 'user' ? blocksOf(next.content).filter((b) => b?.type === 'tool_result').map((b) => b.tool_use_id) : []);
      for (const b of blocks) if (b?.type === 'tool_use' && !answered.has(b.id)) problems.push(`message ${i}: tool_use ${b.id} has no tool_result after it`);
    }
  });
  return problems;
}
