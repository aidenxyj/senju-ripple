// Ghost cursors on what an agent is doing in its browser window.
// Just before a browser action, measure where it lands and emit { type: 'point', agentId, point }, then wait a
// moment so the cursor in the overlay gets there before the action does. Best effort: it never blocks the action.
import { callTool } from './mcp.js';

// Runs in the page on the element: scroll it into view (as the click would), then return its centre in CSS px
// from the top-left of the browser window (x, y, past the tab and address bars), the same point on the screen
// (screenX, screenY), the window's outer size, the element's size (w, h) and the height of the tab and address
// bars (chromeTop).
const MEASURE = `(el) => {
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  const r = el.getBoundingClientRect();
  const side = Math.max(0, (window.outerWidth - window.innerWidth) / 2);
  const top = Math.max(0, window.outerHeight - window.innerHeight - side);
  const x = Math.round(side + r.left + r.width / 2), y = Math.round(top + r.top + r.height / 2);
  return { x, y, screenX: Math.round(window.screenX + x), screenY: Math.round(window.screenY + y), windowW: window.outerWidth, windowH: window.outerHeight,
    w: Math.round(r.width), h: Math.round(r.height), chromeTop: Math.round(top) };
}`;

// Typing that people can watch: the text appears a few letters at a time, at most TYPE_MAX_MS in all, then the
// real browser_type sets it exactly. Field types that cannot hold part of a value are filled at once.
export const TYPE_MS_PER_CHAR = 16;
export const TYPE_MAX_MS = 900;
export const typeMs = (chars) => Math.min(TYPE_MAX_MS, Math.max(0, chars) * TYPE_MS_PER_CHAR);
const typeOut = (text) => `async (el) => {
  const text = ${JSON.stringify(text)};
  const editable = el.isContentEditable;
  const kind = (el.getAttribute('type') || 'text').toLowerCase();
  if (!editable && !(el instanceof HTMLTextAreaElement) && !(el instanceof HTMLInputElement && ['text', 'search', 'email', 'url', 'tel', 'password', ''].includes(kind))) return 'skipped';
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = editable ? null : Object.getOwnPropertyDescriptor(proto, 'value').set;
  const put = (v) => { if (editable) el.textContent = v; else setter.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
  el.focus();
  const steps = Math.max(1, Math.min(text.length, Math.floor(${TYPE_MAX_MS} / ${TYPE_MS_PER_CHAR})));
  for (let i = 1; i <= steps; i++) {
    put(text.slice(0, Math.round((text.length * i) / steps)));
    await new Promise((r) => setTimeout(r, ${TYPE_MS_PER_CHAR}));
  }
  return 'typed';
}`;

// The value from a browser_evaluate reply: the JSON under "### Result".
export function evalResult(text) {
  const m = String(text ?? '').match(/### Result\s*\n([\s\S]*?)(?:\n### |$)/);
  try { return m ? JSON.parse(m[1]) : null; } catch { return null; }
}

export const POINT_LEAD_MS = 160;   // head start for the cursor's glide
const MEASURE_MAX_MS = 2000;
export const pointLeadMs = (point) => (point?.verb === 'key' ? 0 : POINT_LEAD_MS + (point?.verb === 'open' ? Number(point.typeMs) || 0 : 0));

const ELEMENT_VERBS = { browser_click: 'click', browser_hover: 'click', browser_select_option: 'select', browser_type: 'type' };
const text = (res) => (res?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
const sleep = (ms, signal) => new Promise((resolve) => {
  if (ms <= 0 || signal?.aborted) return resolve();
  const t = setTimeout(resolve, ms);
  signal?.addEventListener?.('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});
const within = (promise, ms) => { let t; return Promise.race([promise, new Promise((r) => { t = setTimeout(() => r(null), ms); })]).finally(() => clearTimeout(t)); };

/**
 * Call before a Playwright MCP tool runs. Emits the point for that action and waits for the cursor.
 * @param {object} conn       the worker's browser connection
 * @param {string} tool       e.g. browser_click
 * @param {object} args       the tool's input
 * @param {(point: object) => void} emit
 * @param {AbortSignal} [signal]
 */
export async function pointBefore(conn, tool, args, emit, signal) {
  try {
    let point = null;
    const ref = args?.target ?? args?.ref;
    if (ELEMENT_VERBS[tool] && ref) {
      const verb = ELEMENT_VERBS[tool];
      const element = String(args.element ?? 'element');
      const res = await within(callTool(conn, 'browser_evaluate', { element, target: ref, ref, function: MEASURE }, signal), MEASURE_MAX_MS);
      const at = res && !res.isError ? evalResult(text(res)) : null;
      if (!at || !Number.isFinite(at.x)) return;
      const typed = verb === 'type' ? String(args.text ?? '') : '';
      point = { verb, ...at, ...(verb === 'type' ? { chars: typed.length, typeMs: typeMs(typed.length) } : {}) };
      emit(point);
      await sleep(pointLeadMs(point), signal);
      if (typed && !args.slowly) {
        // Let people watch it type; browser_type still sets the exact text and fires the real events.
        await within(callTool(conn, 'browser_evaluate', { element, target: ref, ref, function: typeOut(typed) }, signal).catch(() => null), TYPE_MAX_MS + 1500);
      }
      return;
    }
    if (tool === 'browser_navigate' && args?.url) point = { verb: 'open', url: String(args.url), typeMs: typeMs(String(args.url).length) };
    else if (tool === 'browser_navigate_back') point = { verb: 'back' };
    else if (tool === 'browser_press_key') point = { verb: 'key', key: String(args?.key ?? '') };
    if (!point) return;
    emit(point);
    await sleep(pointLeadMs(point), signal);
  } catch { /* the action still runs */ }
}
