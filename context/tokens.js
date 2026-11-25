// Token estimates for Messages-shaped messages. These are estimates only: the
// real counts come back from the endpoint as `usage`. They lean high on purpose,
// so a conversation that fits by this estimate also fits for real.

// Fitted against one model's real usage.prompt_tokens (a 65B model with a ~100k BPE vocabulary) on 13 samples of nine kinds of text
// (prose, code, JSON, raw Playwright snapshots, eyes/ output, page dumps and price
// tables full of numbers). A flat chars/3.5 ran 15-30% low on snapshot-like text,
// because digits and punctuation tokenize short. Per class: each run of whitespace
// (about one per word) 1.14, each digit 0.45, each punctuation mark 0.73, each
// non-ASCII char 1. That lands within -9%..+15% of the real count on every sample;
// SAFETY then lifts it so it errs high (prose ends up ~25% high, snapshots ~4%).
export const WEIGHTS = { word: 0, digit: 0.45, punct: 0.73, space: 1.14, wide: 1 };
export const SAFETY = 1.2;
export const CHARS_PER_TOKEN = 3.5;   // kept for callers that only need a rough char budget
export const MIN_CHARS_PER_TOKEN = 5; // floor for long runs without spaces (ids, base64, URLs)
export const IMAGE_TOKENS = 1600;     // one screenshot; adapter/ replaces images with text unless LLM_VISION is on
const MESSAGE_OVERHEAD = 4;           // role and message framing
const BLOCK_OVERHEAD = 3;             // block type framing
const ID_TOKENS = 8;                  // a tool_use id such as toolu_01AbC...

const CLASSES = /[A-Za-z]+|\d|\s+|[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]|[^\x00-\x7f]/g;

/**
 * Estimate the tokens in a piece of text, leaning high (see WEIGHTS and SAFETY).
 * Non-strings are JSON-encoded.
 * @param {unknown} text
 * @returns {number}
 */
export function countTokens(text) {
  if (text == null) return 0;
  const s = typeof text === 'string' ? text : JSON.stringify(text) ?? '';
  if (!s) return 0;
  let n = 0, alnum = 0;
  for (const [t] of s.matchAll(CLASSES)) {
    const c = t.charCodeAt(0);
    if (c > 127) n += WEIGHTS.wide;
    else if (c <= 32) n += WEIGHTS.space;
    else if (c >= 48 && c <= 57) { n += WEIGHTS.digit; alnum++; }
    else if ((c | 32) >= 97 && (c | 32) <= 122) { n += WEIGHTS.word; alnum += t.length; }
    else n += WEIGHTS.punct;
  }
  return Math.ceil(Math.max(n, alnum / MIN_CHARS_PER_TOKEN) * SAFETY);
}

/** Tokens in one content block (text, image, tool_use, tool_result, or anything else). */
export function countBlock(block) {
  if (typeof block === 'string') return countTokens(block);
  if (!block || typeof block !== 'object') return 0;
  switch (block.type) {
    case 'text': return BLOCK_OVERHEAD + countTokens(block.text);
    case 'image': return IMAGE_TOKENS;
    case 'tool_use': return BLOCK_OVERHEAD + ID_TOKENS + countTokens(block.name) + countTokens(JSON.stringify(block.input ?? {}));
    case 'tool_result': return BLOCK_OVERHEAD + ID_TOKENS + countContent(block.content);
    case 'thinking': return BLOCK_OVERHEAD + countTokens(block.thinking);
    case 'compaction': return BLOCK_OVERHEAD + countTokens(block.content);
    default: return BLOCK_OVERHEAD + countTokens(JSON.stringify(block));
  }
}

/** Tokens in a message's `content`, or a tool_result's `content`: a string or an array of blocks. */
export function countContent(content) {
  if (content == null) return 0;
  if (typeof content === 'string') return countTokens(content);
  if (Array.isArray(content)) return content.reduce((n, b) => n + countBlock(b), 0);
  return countBlock(content);
}

/** Tokens in one `{ role, content }` message. */
export function countMessage(message) {
  return MESSAGE_OVERHEAD + countContent(message?.content);
}

/** Tokens in a system prompt: a string or an array of text blocks. */
export function countSystem(system) {
  return system == null ? 0 : countContent(system);
}

/** Tokens in a tool list `[{ name, description, input_schema }]`. */
export function countTools(tools) {
  return Array.isArray(tools) && tools.length ? countTokens(JSON.stringify(tools)) : 0;
}

/**
 * Estimate a whole request. The system prompt and tools are passed separately,
 * the way the Messages API takes them; leave them out to count only the messages.
 * @param {Array<{role: string, content: any}>} messages
 * @param {{ system?: string | object[], tools?: object[] }} [opts]
 */
export function countMessages(messages, { system, tools } = {}) {
  let n = countSystem(system) + countTools(tools);
  for (const m of messages ?? []) n += countMessage(m);
  return n;
}
