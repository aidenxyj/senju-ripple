// The model client the swarm talks to. Used by the desktop app (solo) and the server (teams).
// It is the repo's adapter/: OpenAI-style chat completions to whatever endpoint the settings name (a hosted API or a
// server you run yourself), taking and returning the message shapes the orchestrator uses, so nothing else changes.
import { makeLlm as makeClient, llmSettings, missingSettings } from '../../adapter/index.js';

export { llmSettings, missingSettings };

/**
 * @param {object|string} [settings]  { baseUrl, apiKey, model, maxContext, vision }, or just an API key; anything left
 *                                     out comes from the env (LLM_*).
 */
export function makeLlm(settings = {}, env = process.env) {
  if (typeof settings === 'string') settings = { apiKey: settings };   // a bare API key, with the rest from the env
  const s = { ...llmSettings(env), ...Object.fromEntries(Object.entries(settings).filter(([, v]) => v != null && v !== '')) };
  const problem = missingSettings(s);
  if (problem) throw new Error(problem);
  // Long jobs meet rate limits and blips, so retry generously (the adapter backs off between tries).
  // serverContext: false tells the swarm that server-side tool-result clearing and compaction are not available
  // over this API (the adapter drops those fields), so it trims old tool results itself with prune().
  const llm = makeClient({ ...s, maxRetries: 8, timeoutMs: 15 * 60 * 1000 });
  return { ...llm, model: s.model, serverContext: false };
}
