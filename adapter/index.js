// Model adapter: a model client in the Messages-style shape the swarm engine expects, speaking OpenAI-style
// chat completions to any compatible endpoint, hosted or self-run.

const IMAGE_OMITTED = '[image omitted]';
const RETRY_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const CONTEXT_ERROR = /maximum context length|context length|context window|too many tokens|reduce the length/i;
const MAX_TOKENS_ERROR = /max_tokens.*(not supported|unsupported)|use .?max_completion_tokens/i;

/**
 * @param {object} o
 * @param {string} o.baseUrl     the endpoint's OpenAI-style base URL (usually ends in /v1)
 * @param {string} [o.apiKey]   sent as a bearer token; optional, since local servers often need none
 * @param {string} o.model       the endpoint's model name (used for every call; params.model is ignored)
 * @param {boolean} [o.vision]  pass images in tool results through to the model; off: each becomes "[image omitted]"
 * @param {number} [o.maxContext] tokens the endpoint accepts; requests clearly over it fail fast
 * @param {object|null} [o.provider] provider routing for multi-provider routers; none by default (a single vLLM server has no providers).
 * @param {number} [o.maxRetries]
 * @param {number} [o.minOutputTokens] floor for max_tokens, since reasoning spends from the same budget
 * @param {Function} [o.fetch]   injectable for tests
 */
export function makeLlm({
  baseUrl, apiKey = '', model, maxContext = Infinity, vision = false,
  provider = null, maxRetries = 5, minOutputTokens = 1024,
  fetch: fetchImpl = globalThis.fetch, timeoutMs = 10 * 60 * 1000,
} = {}) {
  if (!baseUrl || !model) throw new Error('makeLlm needs baseUrl and model');
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const headers = { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) };
  // Some endpoints reject max_tokens and want max_completion_tokens. Learned on the first refusal.
  let completionTokens = false;

  async function create(params, { signal } = {}) {
    const body = toOpenAI(params, { model, minOutputTokens, vision });
    if (provider) body.provider = provider;
    if (completionTokens) renameMaxTokens(body);

    // Fail fast on requests that cannot fit, using a deliberately generous estimate (4 chars/token).
    if (Number.isFinite(maxContext) && estimateTokens(body) > maxContext) return contextExceeded();

    for (let attempt = 0; ; attempt++) {
      throwIfAborted(signal);
      let res, json;
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: anySignal(signal, timeoutMs),
        });
        json = await res.json().catch(() => ({}));
      } catch (err) {
        throwIfAborted(signal);
        if (attempt < maxRetries) { await backoff(attempt, signal); continue; }
        throw withStatus(new Error(`model: network error: ${err?.message ?? err}`), 0);
      }

      const errMsg = json?.error?.message ?? (res.ok ? '' : `HTTP ${res.status}`);
      if (!res.ok || json?.error) {
        const status = Number(json?.error?.code) || res.status;
        if (CONTEXT_ERROR.test(errMsg)) return contextExceeded();
        if (!completionTokens && 'max_tokens' in body && MAX_TOKENS_ERROR.test(errMsg)) { completionTokens = true; renameMaxTokens(body); continue; }
        if ((RETRY_STATUS.has(status) || status === 0) && attempt < maxRetries) { await backoff(attempt, signal); continue; }
        throw withStatus(new Error(`model: ${errMsg}`), status);
      }
      const out = fromOpenAI(json);
      // Providers occasionally return an empty choice list; treat as transient.
      if (!out && attempt < maxRetries) { await backoff(attempt, signal); continue; }
      if (!out) throw withStatus(new Error('model: response had no choices'), 502);
      return out;
    }
  }

  return { create };
}

// ---------- request: Messages shape -> OpenAI shape ----------

export function toOpenAI(params, { model, minOutputTokens = 0, vision = false } = {}) {
  const messages = [];
  const system = systemText(params.system);
  if (system) messages.push({ role: 'system', content: system });

  for (const m of params.messages ?? []) {
    if (typeof m.content === 'string') { messages.push({ role: m.role, content: m.content }); continue; }
    const blocks = m.content ?? [];
    if (m.role === 'assistant') {
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      const calls = blocks.filter((b) => b.type === 'tool_use').map((b) => ({
        id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
      }));
      // thinking, redacted_thinking and compaction blocks belong to one vendor's format and are dropped.
      if (!text && !calls.length) { messages.push({ role: 'assistant', content: '(no reply)' }); continue; }
      messages.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    // User turn: tool results become `tool` messages, which must come straight after the assistant's tool_calls.
    // Tool messages carry text only, so with vision on, a tool result's images follow in a user message.
    const rest = [];
    const images = [];
    for (const b of blocks) {
      if (b.type === 'tool_result') {
        const text = resultText(b.content);
        messages.push({ role: 'tool', tool_call_id: b.tool_use_id, content: b.is_error ? `Error: ${text || 'tool failed'}` : (text || '(empty result)') });
        if (vision && Array.isArray(b.content)) for (const c of b.content) { const part = imagePart(c); if (part) images.push(part); }
      } else if (b.type === 'text') rest.push(b.text);
      else if (vision && imagePart(b)) images.push(imagePart(b));
      else if (b.type === 'image' || b.type === 'document') rest.push(IMAGE_OMITTED);
    }
    if (images.length) messages.push({ role: 'user', content: [...(rest.length ? [{ type: 'text', text: rest.join('\n') }] : []), ...images] });
    else if (rest.length) messages.push({ role: 'user', content: rest.join('\n') });
  }

  const body = {
    model,
    messages,
    max_tokens: Math.max(params.max_tokens ?? 4096, minOutputTokens),
  };
  if (params.tools?.length) {
    body.tools = params.tools
      .filter((t) => t.input_schema || !t.type) // server tools (web_search etc.) have a `type` and no schema
      .map((t) => ({ type: 'function', function: { name: t.name, description: t.description ?? '', parameters: t.input_schema ?? { type: 'object', properties: {} } } }));
    if (!body.tools.length) delete body.tools;
  }
  const tc = params.tool_choice;
  if (tc && body.tools) {
    if (tc.type === 'auto') body.tool_choice = 'auto';
    else if (tc.type === 'any') body.tool_choice = 'required';
    else if (tc.type === 'none') body.tool_choice = 'none';
    else if (tc.type === 'tool') body.tool_choice = { type: 'function', function: { name: tc.name } };
  }
  if (params.temperature != null) body.temperature = params.temperature;
  if (params.top_p != null) body.top_p = params.top_p;
  if (params.stop_sequences?.length) body.stop = params.stop_sequences;
  // betas, context_management, cache_control, metadata, thinking: vendor-specific, dropped.
  return body;
}

function systemText(system) {
  if (!system) return '';
  if (typeof system === 'string') return system;
  return system.filter((b) => b.type === 'text').map((b) => b.text).join('\n\n');
}

// An image block as an OpenAI image_url part, or null.
function imagePart(b) {
  if (b?.type !== 'image') return null;
  const src = b.source ?? {};
  if (src.type === 'base64' && src.data) return { type: 'image_url', image_url: { url: `data:${src.media_type ?? 'image/png'};base64,${src.data}` } };
  if (src.type === 'url' && src.url) return { type: 'image_url', image_url: { url: src.url } };
  return null;
}

function renameMaxTokens(body) {
  if (!('max_tokens' in body)) return;
  body.max_completion_tokens = body.max_tokens;
  delete body.max_tokens;
}

function resultText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  return content.map((c) => (c.type === 'text' ? c.text : c.type === 'image' || c.type === 'document' ? IMAGE_OMITTED : '')).filter(Boolean).join('\n');
}

// ---------- response: OpenAI shape -> Messages shape ----------

const STOP = { stop: 'end_turn', tool_calls: 'tool_use', function_call: 'tool_use', length: 'max_tokens', content_filter: 'end_turn' };

export function fromOpenAI(json) {
  const choice = json?.choices?.[0];
  if (!choice) return null;
  const msg = choice.message ?? {};
  const content = [];
  const text = stripReasoning(msg.content ?? '').trim();
  if (text) content.push({ type: 'text', text });
  for (const tc of msg.tool_calls ?? []) {
    content.push({ type: 'tool_use', id: tc.id || `call_${Math.random().toString(36).slice(2, 10)}`, name: tc.function?.name ?? '', input: parseArgs(tc.function?.arguments) });
  }
  let stop_reason = STOP[choice.finish_reason] ?? 'end_turn';
  // Some providers say "stop" even when they returned tool calls.
  if (content.some((b) => b.type === 'tool_use') && stop_reason === 'end_turn') stop_reason = 'tool_use';
  const u = json.usage ?? {};
  const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    id: json.id,
    type: 'message',
    role: 'assistant',
    model: json.model,
    content,
    stop_reason,
    usage: {
      input_tokens: Math.max(0, (u.prompt_tokens ?? 0) - cached),
      output_tokens: u.completion_tokens ?? 0,
      cache_read_input_tokens: cached,
      cache_creation_input_tokens: 0,
    },
  };
}

// Reasoning arrives in message.reasoning (dropped by not reading it). Guard against inline tags anyway.
function stripReasoning(text) {
  return String(text).replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*?<\/think>/i, '');
}

// Arguments arrive as a JSON string. Unparseable ones pass through as { _raw } for guard.repair.
export function parseArgs(args) {
  if (args == null || args === '') return {};
  if (typeof args === 'object') return args;
  try {
    const v = JSON.parse(args);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : { _raw: args };
  } catch {
    return { _raw: args };
  }
}

// ---------- helpers ----------

function contextExceeded() {
  return { type: 'message', role: 'assistant', content: [], stop_reason: 'model_context_window_exceeded', usage: { input_tokens: 0, output_tokens: 0 } };
}

export function estimateTokens(body) {
  return Math.ceil(JSON.stringify(body.messages).length / 4) + (body.max_tokens ?? body.max_completion_tokens ?? 0);
}

function withStatus(err, status) { err.status = status; return err; }

function throwIfAborted(signal) {
  if (signal?.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
}

function anySignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function backoff(attempt, signal) {
  const ms = Math.min(30000, 500 * 2 ** attempt) * (0.5 + Math.random());
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); const e = new Error('aborted'); e.name = 'AbortError'; reject(e); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * The model settings in an env: LLM_BASE_URL, LLM_API_KEY, LLM_MODEL, LLM_MAX_CONTEXT, LLM_VISION.
 */
export function llmSettings(env = process.env) {
  const get = (name) => env[`LLM_${name}`] ?? '';
  return {
    baseUrl: get('BASE_URL'),
    apiKey: get('API_KEY'),
    model: get('MODEL'),
    maxContext: Number(get('MAX_CONTEXT')) || Infinity,
    vision: /^(1|true|yes|on)$/i.test(env.LLM_VISION ?? ''),
  };
}

/** What is missing from the model settings, as a sentence, or '' when they are complete. */
export function missingSettings(s) {
  const missing = [!s.baseUrl && 'LLM_BASE_URL', !s.model && 'LLM_MODEL'].filter(Boolean);
  return missing.length ? `Set ${missing.join(' and ')} (any OpenAI-compatible endpoint; see .env.example).` : '';
}

/** A client from the env's model settings (see llmSettings). */
export function llmFromEnv(env = process.env, extra = {}) {
  const s = llmSettings(env);
  const problem = missingSettings(s);
  if (problem) throw new Error(problem);
  return makeLlm({ ...s, ...extra });
}
