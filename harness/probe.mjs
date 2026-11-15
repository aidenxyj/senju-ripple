// Probe: raw requests to the Ripple endpoint, printed as-is.
// Usage: node --env-file=.env harness/probe.mjs [plain|tool|reasoning|context <tokens>] [--provider <slug>]
// Never prints the API key.

const { RIPPLE_BASE_URL, RIPPLE_API_KEY, RIPPLE_MODEL } = process.env;
if (!RIPPLE_BASE_URL || !RIPPLE_API_KEY) throw new Error('set RIPPLE_BASE_URL and RIPPLE_API_KEY in .env');
const model = RIPPLE_MODEL || 'ricursiveai/ripple-65b-preview';

const args = process.argv.slice(2);
const pIdx = args.indexOf('--provider');
const provider = pIdx >= 0 ? args.splice(pIdx, 2)[1] : null;
const mode = args[0] || 'plain';

async function call(body) {
  if (provider) body.provider = { order: [provider], allow_fallbacks: false };
  const t0 = Date.now();
  const res = await fetch(`${RIPPLE_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${RIPPLE_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, ...body }),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, ms: Date.now() - t0, json };
}

const sh = {
  type: 'function',
  function: {
    name: 'sh',
    description: 'Run shell commands. Each line is one command.',
    parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] },
  },
};

let out;
if (mode === 'plain') {
  out = await call({ max_tokens: 300, messages: [{ role: 'user', content: 'Say hi in five words.' }] });
} else if (mode === 'tool') {
  out = await call({
    max_tokens: 1000,
    tools: [sh],
    messages: [
      { role: 'system', content: 'You are a worker. Act only through the sh tool.' },
      { role: 'user', content: 'List the files in /tmp, then report how many there are.' },
    ],
  });
} else if (mode === 'toolresult') {
  out = await call({
    max_tokens: 1000,
    tools: [sh],
    messages: [
      { role: 'system', content: 'You are a worker. Act only through the sh tool.' },
      { role: 'user', content: 'List the files in /tmp, then report how many there are.' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'sh', arguments: '{"cmd":"ls /tmp"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'a.txt\nb.log\nc.json' },
    ],
  });
} else if (mode === 'reasoning') {
  out = await call({
    max_tokens: 2000,
    reasoning: { enabled: true },
    messages: [{ role: 'user', content: 'What is 17 * 23? Answer with the number only.' }],
  });
} else if (mode === 'context') {
  const tokens = Number(args[1] || 100000);
  // ~4 chars per token of filler; the needle checks the model actually saw the start.
  const filler = 'lorem ipsum dolor sit amet '.repeat(Math.ceil((tokens * 4) / 27));
  out = await call({
    max_tokens: 20,
    messages: [{ role: 'user', content: `The secret word is PELICAN.\n${filler}\nWhat is the secret word? One word.` }],
  });
} else {
  throw new Error(`unknown mode ${mode}`);
}

const { json } = out;
console.log(JSON.stringify({ mode, provider, status: out.status, ms: out.ms, served_by: json.provider, usage: json.usage, error: json.error, choice: json.choices?.[0] }, null, 2));
