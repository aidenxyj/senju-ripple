// Games and tools with their own on-screen keyboard or keypad (Wordle, calculators): when a worker presses a key
// that the page shows as a button, click that button instead, so the ghost cursor visibly taps each letter.
import { callTool } from './mcp.js';
import { pointBefore, evalResult } from './point.js';

// Runs in the page. Finds the on-screen key for `key`, but only on a page that shows a keyboard or keypad
// (at least 10 visible one-character keys), so Enter in an ordinary form still means Enter.
const FIND_KEY = (key) => `() => {
  const want = ${JSON.stringify(String(key))};
  const deep = (sel) => { const out = []; const walk = (root) => { for (const e of root.querySelectorAll('*')) { if (e.matches(sel)) out.push(e); if (e.shadowRoot) walk(e.shadowRoot); } }; walk(document); return out; };
  const visible = (el) => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 4 && r.height > 4 && r.bottom > 0 && r.top < innerHeight && s.visibility !== 'hidden' && s.display !== 'none'; };
  const label = (el) => (el.getAttribute('data-key') || el.getAttribute('aria-label') || el.textContent || '').replace(/\\s+/g, ' ').trim();
  const keys = deep('button, [role=button], [data-key]').filter(visible);
  const single = keys.filter((k) => label(k).length === 1);
  if (single.length < 10) return null;
  const SPECIAL = {
    enter: /^(enter|↵|⏎|return|submit|=|equals)$/i,
    backspace: /^(backspace|←|⌫|delete|del|back|backspace key)$/i,
  };
  const name = want.toLowerCase();
  const match = SPECIAL[name] ? (t) => SPECIAL[name].test(t) : (t) => t.toLowerCase() === name;
  const hit = keys.find((k) => match(label(k)));
  if (!hit) return null;
  deep('[data-senju-key]').forEach((e) => e.removeAttribute('data-senju-key'));
  hit.setAttribute('data-senju-key', '1');
  return { selector: '[data-senju-key="1"]', label: label(hit) || want };
}`;

/**
 * Before browser_press_key: if the page has an on-screen key for it, click that key (moving the cursor) and
 * return the click's tool result. Returns null to let the real key press happen instead.
 */
export async function clickOnScreenKey(conn, key, emit, signal) {
  if (!key || (String(key).length !== 1 && !/^(enter|backspace)$/i.test(key))) return null;
  try {
    const found = evalResult((await callTool(conn, 'browser_evaluate', { function: FIND_KEY(key) }, signal))?.content?.map((c) => c.text).join('\n'));
    if (!found?.selector) return null;
    const args = { element: `on-screen key "${found.label}"`, target: found.selector };
    await pointBefore(conn, 'browser_click', args, emit, signal);
    const res = await callTool(conn, 'browser_click', args, signal);
    return res?.isError ? null : res;
  } catch { return null; }
}
