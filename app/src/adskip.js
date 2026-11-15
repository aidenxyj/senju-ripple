// Video ads on YouTube: the "Skip" button only shows up some seconds into an ad, often after the worker has
// moved on or finished. Once a worker's browser has been on YouTube, check it about once a second while its
// window is open, and when a skip button (or an ad banner's close button) is showing, move the cursor there
// and click it through browser_click, as a person watching would. Best effort: never throws.
import { callTool } from './mcp.js';
import { pointBefore, evalResult } from './point.js';

// Runs in the page. Returns { selector, label } for the button to click, or null.
export const FIND = `() => {
  if (!/(^|\\.)youtube\\.com$/.test(location.hostname)) return null;
  const visible = (el) => {
    const r = el.getBoundingClientRect(), s = getComputedStyle(el);
    return r.width > 4 && r.height > 4 && r.bottom > 0 && r.top < innerHeight && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
  };
  const SKIP = ['.ytp-skip-ad-button', '.ytp-ad-skip-button-modern', '.ytp-ad-skip-button', '.ytp-ad-skip-button-slot button', 'button[id^="skip-button"]', '.ytp-ad-overlay-close-button'];
  let hit = null;
  for (const sel of SKIP) { hit = [...document.querySelectorAll(sel)].find(visible); if (hit) break; }
  if (!hit) {
    // A renamed button: anything in the ad area whose text is Skip / Skip ad / Skip ads.
    hit = [...document.querySelectorAll('.video-ads button, .ytp-ad-module button, .ytp-ad-player-overlay button')]
      .find((b) => visible(b) && /^skip( ads?)?$/i.test((b.innerText || b.getAttribute('aria-label') || '').trim()));
  }
  if (!hit) return null;
  document.querySelectorAll('[data-senju-ad]').forEach((e) => e.removeAttribute('data-senju-ad'));
  hit.setAttribute('data-senju-ad', '1');
  const label = (hit.innerText || hit.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim();
  return { selector: '[data-senju-ad="1"]', label: label || (hit.matches('.ytp-ad-overlay-close-button') ? 'Close ad' : 'Skip') };
}`;

export const AD_CHECK_MS = 1000;
const YOUTUBE = /https?:\/\/([a-z0-9-]+\.)*youtube\.com\//i;

/** True when a browser tool's result shows the page is on YouTube (so it is worth watching for ads). */
export function onYouTube(res, args) {
  if (YOUTUBE.test(String(args?.url ?? ''))) return true;
  return (res?.content ?? []).some((c) => c.type === 'text' && YOUTUBE.test(c.text.slice(0, 4000)));
}

/**
 * Start watching one browser connection for skippable ads (once per connection). Stops when the connection closes.
 * @param {object} conn    the worker's browser connection
 * @param {(point: object) => void} emit   moves this worker's cursor
 * @param {(label: string) => void} [onSkip]  told after each click
 */
export function watchAds(conn, emit, onSkip) {
  if (conn.adWatch) return;
  let stopped = false, checking = false;
  const tick = async () => {
    // Never in the middle of the worker's own action, and one check at a time.
    if (stopped || checking || conn.inflight > 0) return;
    checking = true;
    try {
      const found = evalResult((await callTool(conn, 'browser_evaluate', { function: FIND }))?.content?.map((c) => c.text).join('\n'));
      if (!stopped && found?.selector) {
        const args = { element: `ad button "${found.label}"`, target: found.selector };
        await pointBefore(conn, 'browser_click', args, emit);
        const res = await callTool(conn, 'browser_click', args);
        if (!res?.isError) onSkip?.(found.label);
      }
    } catch { /* try again next tick */ }
    checking = false;
  };
  const timer = setInterval(tick, AD_CHECK_MS);
  timer.unref?.();
  const close = conn.close;
  conn.adWatch = { stop: () => { stopped = true; clearInterval(timer); } };
  conn.close = (...a) => { conn.adWatch.stop(); return close(...a); };
}
