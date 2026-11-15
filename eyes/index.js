// eyes/: turn a page (later: a Mac app window) into short text with stable element ids.
//
//   observe(conn, target, { maxChars }) -> { text, elements: [{ id, role, name, value, ref, flags }], hash, page, lines }
//   diff(previous, next)                -> text   ('no change' when nothing changed)
//   resolve(conn, target, id)           -> { ref, role, name } | null   (for shell/)
//
// See README.md for the text format and the target forms each source accepts.

import * as browser from './sources/browser.js';
import { extract, assignIds, render, hashState, newIdState, diff as diffViews } from './view.js';

export { parseSnapshot, parseBrowserOutput, parseTabs } from './parse.js';
export { extract, assignIds, render, hashState, elementLine, newIdState } from './view.js';

// A source turns (conn, target) into { page, tree }. Add a desktop source (cua-driver)
// here later; it only has to produce the same tree shape (see parse.js).
const SOURCES = [browser];

export const DEFAULT_MAX_CHARS = 6000;

// Per connection, per target: id state that keeps element ids stable between calls.
const STATE = new WeakMap();

function sourceFor(conn) {
  const src = SOURCES.find((s) => s.matches(conn));
  if (!src) throw new Error(`eyes: no source for MCP server "${conn?.name ?? '?'}" (supported: ${SOURCES.map((s) => s.name).join(', ')})`);
  return src;
}

function stateFor(conn, key, create = true) {
  let m = STATE.get(conn);
  if (!m) { if (!create) return null; m = new Map(); STATE.set(conn, m); }
  let s = m.get(key);
  if (!s && create) { s = newIdState(); m.set(key, s); }
  return s ?? null;
}

/**
 * Look at a page and describe it as text.
 * @param {object} conn  MCP connection from app/src/mcp.js connectServer()
 * @param {*} target     which page; see sources/browser.js (undefined = current tab)
 * @param {{maxChars?: number}} [opts]
 */
export async function observe(conn, target, { maxChars = DEFAULT_MAX_CHARS } = {}) {
  const src = sourceFor(conn);
  const { page, tree } = await src.snapshot(conn, target);
  const { nodes, lines } = extract(tree);
  const elements = assignIds(stateFor(conn, src.targetKey(target)), nodes);
  return {
    text: render(page, elements, lines, maxChars),
    elements,
    hash: hashState(page, elements, lines),
    page,
    lines,
  };
}

/** What changed between two observe() results, or exactly `no change`. */
export function diff(previous, next, opts) {
  return diffViews(previous, next, opts);
}

/**
 * Map an eyes id (e.g. `e12`) to what the MCP server needs to act on it.
 * For the browser: pass `ref` as `target` to browser_click / browser_type /
 * browser_select_option / browser_hover, and `name` as the human-readable `element`.
 * Valid for the last observe() of this (conn, target). Returns null for unknown ids.
 */
export function resolve(conn, target, id) {
  const src = sourceFor(conn);
  const s = stateFor(conn, src.targetKey(target), false);
  const e = s?.elements.find((x) => x.id === id);
  return e ? { ref: e.ref, role: e.role, name: e.name } : null;
}

/** Drop id state for one target, or for the whole connection with forget(conn). */
export function forget(conn, ...rest) {
  const m = STATE.get(conn);
  if (!m) return;
  if (rest.length === 0) STATE.delete(conn);
  else m.delete(sourceFor(conn).targetKey(rest[0]));
}
