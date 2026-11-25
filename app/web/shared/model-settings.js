// Checks the model settings typed into a form, shared by the desktop app (main process and launcher), the hub server
// and the web app. Senju talks to any OpenAI-compatible chat completions endpoint: a base URL, a model name, and a key
// if the endpoint wants one. Plain code, no DOM and no Node APIs, so every side can import it.

/**
 * Returns '' when the settings look usable, otherwise a sentence for the person.
 * Only shape checks: whether the endpoint answers is learned on the first call.
 */
export function checkSettings({ baseUrl = '', model = '', apiKey = '' } = {}) {
  if (!/^https?:\/\/\S+$/i.test(String(baseUrl).trim())) return 'Enter the endpoint\'s base URL, starting with http:// or https://.';
  if (!String(model).trim()) return 'Enter the model name the endpoint expects.';
  if (/\s/.test(String(apiKey).trim())) return 'An API key has no spaces in it.';
  return '';
}
