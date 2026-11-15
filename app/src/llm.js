// The Ripple client the swarm talks to. Used by the desktop app (solo) and the server (teams).
// It is the repo's adapter/ (OpenAI-style chat completions to vLLM on a Vast.ai B200, see tools/vast/), which takes and returns
// the same message shapes the orchestrator uses, so nothing else changes. Ripple is text only: the adapter
// replaces images in tool results with "[image omitted]".
import { makeRippleLlm } from '../../adapter/index.js';

export const RIPPLE_MODEL = 'ricursiveai/ripple-65b-preview';

export function makeLlm(apiKey, env = process.env) {
  if (!env.RIPPLE_BASE_URL) throw new Error('Set RIPPLE_BASE_URL to your Vast B200 (python3 tools/vast/ripple_b200.py env <instance>).');
  // Long jobs meet rate limits and blips, so retry generously (the adapter backs off between tries).
  // serverContext: false tells the swarm that the server-side tool-result clearing and
  // compaction do not exist here (the adapter drops those fields without an error), so it trims
  // old tool results itself with prune().
  const llm = makeRippleLlm({
    baseUrl: env.RIPPLE_BASE_URL,
    apiKey,
    model: env.RIPPLE_MODEL || RIPPLE_MODEL,
    maxContext: Number(env.RIPPLE_MAX_CONTEXT) || 131072,   // vLLM's --max-model-len on the B200
    maxRetries: 8,
    timeoutMs: 15 * 60 * 1000,
  });
  return { ...llm, serverContext: false };
}
