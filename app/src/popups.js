// Cookie banners, newsletter pop-ups and ad overlays that cover a page the moment it opens.
// After a worker opens a page, find one, click its button through browser_click (so the ghost cursor visibly
// goes there and clicks), and hand the worker the page as it is afterwards. Best effort: never throws.
import { callTool } from './mcp.js';
import { pointBefore, evalResult } from './point.js';

// Runs in the page. Returns { selector, label, kind } for the button to click, or null.
// Only buttons inside an overlay (a dialog, or a fixed or sticky box) count, so nothing in the page itself is
// clicked. Accept-style words count only in a cookie or consent box; close-style words in any overlay.
const FIND = `() => {
  const ACCEPT = /^(accept|accept all|accept all cookies|accept cookies|allow all|allow all cookies|allow cookies|agree|i agree|i accept|agree and close|agree & close|got it|ok|okay|yes, i agree|consent)$/i;
  const CLOSE = /^(close|close dialog|close modal|close popup|close banner|dismiss|no thanks|no, thanks|not now|maybe later|skip|×|✕|✖|x|close ad|reject all|decline|continue without accepting)$/i;
  const KNOWN = ['#onetrust-accept-btn-handler', '#truste-consent-button', '#didomi-notice-agree-button', '#sp-cc-accept', 'button#L2AGLb', '.fc-cta-consent', '.cc-allow', '.cc-dismiss', '[data-testid="uc-accept-all-button"]', '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll'];
  const visible = (el) => {
    const r = el.getBoundingClientRect(), s = getComputedStyle(el);
    return r.width > 4 && r.height > 4 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
  };
  const label = (el) => (el.getAttribute('aria-label') || el.innerText || el.value || el.title || '').replace(/\\s+/g, ' ').trim();
  // Up through parents and out of shadow roots (web-component games put their dialogs there).
  const up = (n) => n.parentElement || (n.getRootNode && n.getRootNode().host) || null;
  const overlay = (el) => {
    for (let n = el; n && n !== document.body && n !== document.documentElement; n = up(n)) {
      const s = getComputedStyle(n);
      if (n.getAttribute('role') === 'dialog' || n.getAttribute('role') === 'alertdialog' || n.getAttribute('aria-modal') === 'true' || s.position === 'fixed' || s.position === 'sticky'
        || /modal|dialog|popup|overlay|lightbox/i.test(n.tagName + ' ' + (n.id || '') + ' ' + (typeof n.className === 'string' ? n.className : ''))) return n;
    }
    return null;
  };
  // Every element, including those inside open shadow roots. Playwright's CSS selectors reach into them too.
  const deep = (sel) => { const out = []; const walk = (root) => { for (const e of root.querySelectorAll('*')) { if (e.matches(sel)) out.push(e); if (e.shadowRoot) walk(e.shadowRoot); } }; walk(document); return out; };
  const closeClass = (el) => /(^|[-_\s])(close|dismiss)([-_\s]|$)/i.test((typeof el.className === 'string' ? el.className : el.className?.baseVal ?? '') + ' ' + (el.id || ''));
  const consent = (box) => /cookie|consent|gdpr|privacy|tracking/i.test((box.id || '') + ' ' + (box.className?.baseVal ?? box.className ?? '') + ' ' + (box.innerText || '').slice(0, 400));
  const mark = (el, kind) => { el.setAttribute('data-senju-pop', '1'); return { selector: '[data-senju-pop="1"]', label: label(el).slice(0, 40) || kind, kind }; };
  deep('[data-senju-pop]').forEach((e) => e.removeAttribute('data-senju-pop'));
  for (const sel of KNOWN) { const el = document.querySelector(sel); if (el && visible(el)) return mark(el, 'cookie banner'); }
  const buttons = deep('button, [role=button], a, input[type=button], input[type=submit], [aria-label*="close" i], [class*="close" i], [class*="dismiss" i]').filter(visible);
  let close = null;
  for (const el of buttons) {
    const box = overlay(el); if (!box) continue;
    const text = label(el);
    if (ACCEPT.test(text) && consent(box)) return mark(el, 'cookie banner');
    const small = el.getBoundingClientRect().width < 90;
    if (!close && (CLOSE.test(text) || /^close\\b/i.test(el.getAttribute('aria-label') || '') || (small && !text && closeClass(el)))) close = el;
  }
  return close ? mark(close, 'pop-up') : null;
}`;

const MAX_POPUPS = 2;      // a cookie banner and then a newsletter box is common; never loop longer
const SECOND_LOOK_MS = 300; // banners often appear just after the page loads

/**
 * After browser_navigate: close up to two overlays, moving the cursor for each click.
 * Returns null when nothing was closed, else { closed: [labels], result } with the last click's tool result
 * (the page as it is now).
 */
export async function clearPopups(conn, emit, signal) {
  const closed = [];
  let result = null;
  try {
    for (let i = 0; i < MAX_POPUPS && !signal?.aborted; i++) {
      let found = evalResult((await callTool(conn, 'browser_evaluate', { function: FIND }, signal))?.content?.map((c) => c.text).join('\n'));
      if (!found && i === 0) {
        await new Promise((r) => setTimeout(r, SECOND_LOOK_MS));
        found = evalResult((await callTool(conn, 'browser_evaluate', { function: FIND }, signal))?.content?.map((c) => c.text).join('\n'));
      }
      if (!found?.selector) break;
      const args = { element: `${found.kind} button "${found.label}"`, target: found.selector };
      await pointBefore(conn, 'browser_click', args, emit, signal);
      const res = await callTool(conn, 'browser_click', args, signal);
      if (res?.isError) break;
      closed.push(`${found.kind} ("${found.label}")`);
      result = res;
    }
  } catch { /* leave the page as it is */ }
  return closed.length ? { closed, result } : null;
}
