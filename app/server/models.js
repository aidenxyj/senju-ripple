// A person's own model settings: { baseUrl, model, apiKey } for any OpenAI-compatible chat completions endpoint.
// They are stored as one JSON string in the encrypted api_key_enc column (schema.sql needs no change). Rows saved
// before settings existed hold a bare API key; those read as { apiKey }, with base URL and model from the server env.
import { checkSettings } from '../web/shared/model-settings.js';

const clean = (v) => String(v ?? '').trim();

/** What a stored string means: { baseUrl, model, apiKey } (blank fields come from the server env), or null. */
export function parseSaved(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'object') return { baseUrl: clean(raw.baseUrl), model: clean(raw.model), apiKey: clean(raw.apiKey) };
  try {
    const o = JSON.parse(raw);
    if (o && typeof o === 'object' && !Array.isArray(o)) return parseSaved(o);
  } catch { /* a bare key from before */ }
  return { baseUrl: '', model: '', apiKey: clean(raw) };
}

export const serialize = (s) => JSON.stringify({ baseUrl: clean(s.baseUrl).replace(/\/+$/, ''), model: clean(s.model), apiKey: clean(s.apiKey) });

/** What the browser may see: never the key. */
export function publicView(s) {
  return s ? { saved: true, baseUrl: s.baseUrl, model: s.model, hasKey: Boolean(s.apiKey) } : { saved: false, baseUrl: '', model: '', hasKey: false };
}

/**
 * Settings typed into the web app, merged with what was saved. A blank key keeps the saved one, but only for the same
 * base URL, so a key is never sent to an endpoint it was not saved for. Returns { settings } or { error }.
 */
export function fromForm(body, saved) {
  const baseUrl = clean(body?.baseUrl).replace(/\/+$/, '');
  const model = clean(body?.model);
  let apiKey = clean(body?.apiKey);
  if (!apiKey && saved?.apiKey && (saved.baseUrl || '') === baseUrl) apiKey = saved.apiKey;
  const error = checkSettings({ baseUrl, model, apiKey });
  return error ? { error } : { settings: { baseUrl, model, apiKey } };
}
