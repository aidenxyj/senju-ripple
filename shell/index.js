// shell/: the `senju` command line that workers act through. Contract: docs/SPEC.md, "shell/".
//
// Workers get one tool, sh { cmd }. Each line of cmd is one `senju <verb> [args]` command. Output is plain
// text whose first line is `ok` or `error: <why>`. Every command goes through guard.check first, and its
// result is recorded with guard.record so loops are caught.
//
//   const shell = createShell({ conn, agent, guard, hooks })
//   await shell.run('senju open http://127.0.0.1:8080/\nsenju look')   -> 'ok\n...'
//   shellConnection(shell)        -> an MCP-like connection exposing sh, for Swarm's `connect` override
//
// conn is a Playwright MCP connection (app/src/mcp.js connectServer). The page is read through eyes/.
// hooks connect the commands that need the swarm: boardPost, boardRead, wait, ask, done, confirm, openApp.
// hooks.pointAt (optional) is told where the agent is about to act, so an app can move a ghost cursor there
// first: the element for click, type and select (measured), and the toolbar or focused field for open, back, key.
import * as eyes from '../eyes/index.js';
import * as defaultGuard from '../guard/index.js';
import { contextFromTree, formatFind, ICON_SCAN, parseScan } from './find.js';

// Runs in the page on the element: scroll it into view (as the click would), then return its centre in CSS px
// from the top-left of the browser window (x, y, past the tab and address bars), the same point on the screen
// (screenX, screenY), the window's outer size, so a caller can map it onto the window it tracks, the element's
// size (w, h) and the height of the tab and address bars (chromeTop).
const MEASURE = `(el) => {
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  const r = el.getBoundingClientRect();
  const side = Math.max(0, (window.outerWidth - window.innerWidth) / 2);
  const top = Math.max(0, window.outerHeight - window.innerHeight - side);
  const x = Math.round(side + r.left + r.width / 2), y = Math.round(top + r.top + r.height / 2);
  return { x, y, screenX: Math.round(window.screenX + x), screenY: Math.round(window.screenY + y), windowW: window.outerWidth, windowH: window.outerHeight,
    w: Math.round(r.width), h: Math.round(r.height), chromeTop: Math.round(top) };
}`;
const POINT_MAX_MS = 2000;

// Typing that people can watch (only when an app listens through hooks.pointAt): the text appears in the field
// a few letters at a time, TYPE_MS_PER_CHAR apart and at most TYPE_MAX_MS in all, then the real fill sets it
// exactly. Field types that cannot hold part of a value (date, number, color, ...) are filled at once.
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

// The value from a browser_evaluate reply: the JSON under "### Result", before the "### Ran Playwright code" part.
export function evalResult(text) {
  const m = String(text ?? '').match(/### Result\s*\n([\s\S]*?)(?:\n### |$)/);
  try { return m ? JSON.parse(m[1]) : null; } catch { return null; }
}

// A name that says nothing: empty, or only symbols and emoji (an arrow, a trash glyph).
export const unnamed = (name) => !/[\p{L}\p{N}]/u.test(String(name ?? ''));

// Runs in the page on an element. Returns what the accessible name may lack, for guard/:
//   hints       aria-label, title, data-testid, id, class and icon names on the element and its icons
//   field       for a text field: { search, multiline, label } (label: aria-label, placeholder, name, id, <label>)
//   drafted     the nearest composer (form, dialog, chat footer) has a text field with something typed in it
//   deleteNear  the element's close ancestors mention delete, trash or remove
//   where       path, query and title of the page
const HINTS = `(el) => {
  if (!el || el === document.body) return { hints: '', field: null, drafted: false, deleteNear: false, where: (location.pathname + location.search + ' ' + document.title).slice(0, 200) };
  const attrs = (e) => !e || !e.getAttribute ? '' : ['aria-label', 'title', 'data-testid', 'data-test', 'data-icon', 'name', 'alt', 'id', 'type']
    .map((a) => e.getAttribute(a)).concat([typeof e.className === 'string' ? e.className : (e.className && e.className.baseVal) || '']).filter(Boolean).join(' ');
  const icons = [...el.querySelectorAll('svg, title, use, img, i, [data-icon], [class*="icon"]')].slice(0, 6)
    .map((e) => attrs(e) + ' ' + (e.getAttribute('href') || e.getAttribute('xlink:href') || '') + ' ' + (e.tagName.toLowerCase() === 'title' ? e.textContent : '')).join(' ');
  const hints = (attrs(el) + ' ' + icons + ' ' + (el.innerText || '').slice(0, 40)).replace(/\\s+/g, ' ').trim().slice(0, 300);
  const isField = el.matches('input, textarea, [contenteditable=""], [contenteditable="true"], [role="textbox"], [role="searchbox"], [role="combobox"]');
  const field = isField ? {
    search: el.matches('[type="search"], [role="searchbox"]') || !!el.closest('[role="search"], form[action*="search"]') || /search|query|find/i.test(attrs(el) + ' ' + (el.getAttribute('placeholder') || '')),
    multiline: el.matches('textarea, [contenteditable=""], [contenteditable="true"]') || el.getAttribute('aria-multiline') === 'true',
    label: [el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.getAttribute('name'), el.id, el.labels && el.labels[0] && el.labels[0].innerText].filter(Boolean).join(' ').slice(0, 120),
  } : null;
  const box = el.closest('form, [role="dialog"], [role="form"], footer, [class*="ompose"], [class*="reply"], [class*="chat"], [class*="message"]') || (el.parentElement && el.parentElement.parentElement);
  const fields = box ? [...box.querySelectorAll('textarea, [contenteditable=""], [contenteditable="true"], input[type="text"], input:not([type])')] : [];
  const filled = (f) => String(f.value != null ? f.value : f.textContent || '').trim().length > 0;
  const drafted = fields.some((f) => f !== el && filled(f));
  let deleteNear = false;
  for (let e = el.parentElement, i = 0; e && i < 3 && !deleteNear; e = e.parentElement, i++) deleteNear = /delete|trash|remove/i.test(attrs(e));
  return { hints, field, drafted, deleteNear, where: (location.pathname + location.search + ' ' + document.title).slice(0, 200) };
}`;

export const COMMANDS = [
  ['senju look [--page N]', 'what is on screen now: page, then elements with ids like e12, then text (--page 2: the next part)'],
  ['senju find "words"', 'search the WHOLE page (also icons look misses) for a link, button or field; best 8, with ids to click'],
  ['senju click <id or "label">', 'click an element, by id (e12) or by its visible label'],
  ['senju type <id> "text" [--submit]', 'replace the text in a field (--submit presses Enter after)'],
  ['senju select <id> "option"', 'pick an option in a dropdown'],
  ['senju key <combo>', 'press keys, for example: enter, tab, cmd+a, cmd+s'],
  ['senju search "words"', 'search the web and see the results (use it when you are not sure of an address)'],
  ['senju open <url, /path or app>', 'go to a web page you know the exact address of (a /path stays on this site), or open a Mac app'],
  ['senju back', 'go back one page'],
  ['senju board post "note"', 'share a note with the other workers'],
  ['senju board read', 'read the notes on the shared board'],
  ['senju wait <worker>', 'block until that worker reports'],
  ['senju wait <duration>', 'pause, for example 2s, 500ms or 1m (at most 30s)'],
  ['senju ask "question"', 'ask the person and wait for the answer'],
  ['senju done "report"', 'finish this subtask with a short report'],
];

export const SH_TOOL = {
  name: 'sh',
  description: [
    'Run senju commands, one per line ("&&" and ";" also separate commands). They run in order and stop at the first error.',
    'Output starts with `ok` or `error: <why>`. After click, type, select, key, open and back you also get what changed on screen.',
    'Always `senju look` before acting on a page you have not seen. Element ids (e12) come from the latest look or find.',
    'Do not guess web addresses. If you are not sure of the exact address, `senju search "what you want"`, then click the right result.',
    '',
    ...COMMANDS.map(([c, d]) => `${c.padEnd(36)} ${d}`),
    '',
    'Finding the right link or button:',
    '- look shows only the start of a big page. To get to something, use `senju find "words from the goal"` instead of paging through look.',
    '- Pick the result whose name and URL path match the goal (for "my orders" pick -> /orders, not -> /help).',
    '- A path you saw in a link (-> /messenger?with=Bob) opens directly: `senju open /messenger?with=Bob` (on the current site). Never make up a web address.',
    '- Ids stay valid while the page stays. After the page changes (a click that loads a new page), find again.',
    '- No match? Try a synonym, a shorter word, or a word from the URL. A result marked [in a closed menu] needs its menu opened first.',
  ].join('\n'),
  input_schema: { type: 'object', properties: { cmd: { type: 'string', description: 'One or more senju commands, one per line' } }, required: ['cmd'] },
};

// ---- Parsing -------------------------------------------------------------------------------------

export const MAX_WAIT_MS = 30_000;

// "2s" -> 2000, "500ms" -> 500, "1m" -> 60000; anything else (a worker's name) -> null.
export function parseDuration(text) {
  const m = String(text).trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|seconds?|m|min|mins|minutes?)$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  return Math.round(unit === 'ms' ? n : unit.startsWith('m') ? n * 60_000 : n * 1000);
}

// Splits a cmd into single commands. Terminal-trained models chain commands ("senju open URL && senju look",
// "senju wait 1s; senju look"), so newlines, ";" and "&&" outside quotes all separate commands, run in order.
// "||" means "only if the first one failed", which senju cannot do, so it is an error rather than a guess.
// Blank lines and "# comments" are dropped. -> { commands: [string] } | { error }
export function splitCommands(cmd) {
  const text = String(cmd ?? '');
  const commands = [];
  let cur = '';
  let quote = null;
  const CLOSE = { '"': '"', "'": "'", '\u201c': '\u201d' };
  const push = () => { const c = cur.trim(); if (c && !c.startsWith('#')) commands.push(c); cur = ''; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      cur += ch;
      if (quote === '"' && ch === '\\' && i + 1 < text.length) cur += text[++i];
      else if (ch === CLOSE[quote]) quote = null;
      continue;
    }
    if (ch in CLOSE) { quote = ch; cur += ch; continue; }
    if (ch === '\n' || ch === ';') { push(); continue; }
    if (ch === '&' && text[i + 1] === '&') { push(); i++; continue; }
    if (ch === '|' && text[i + 1] === '|') return { error: '"||" is not supported. Put one senju command per line; lines run in order and stop at the first error.' };
    cur += ch;
  }
  push();
  return { commands };
}

// "senju type e3 \"hello world\" --submit" -> { verb: 'type', args: ['e3', 'hello world'], flags: { submit: true } }
export function parseLine(line) {
  const words = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|“([^”]*)”|(\S+)/g;
  let m;
  while ((m = re.exec(line))) {
    if (m[1] !== undefined) words.push({ text: m[1].replace(/\\n/g, '\n').replace(/\\(.)/g, '$1'), quoted: true });
    else if (m[2] !== undefined) words.push({ text: m[2], quoted: true });
    else if (m[3] !== undefined) words.push({ text: m[3], quoted: true });
    else words.push({ text: m[4], quoted: false });
  }
  if (words[0]?.text === '$') words.shift();
  if (words[0]?.text !== 'senju') {
    return { error: `every line must start with "senju" (got "${line.trim().slice(0, 60)}"). Run "senju help" for the commands.` };
  }
  words.shift();
  const verb = (words.shift()?.text ?? '').toLowerCase();
  const args = [];
  const flags = {};
  for (const w of words) {
    if (!w.quoted && /^--[a-z-]+$/.test(w.text)) flags[w.text.slice(2)] = true;
    else args.push(w.text);
  }
  return { verb, args, flags };
}

// cmd+shift+s -> Meta+Shift+s (Playwright key names)
export function toPlaywrightKey(combo) {
  const NAMES = {
    cmd: 'Meta', command: 'Meta', meta: 'Meta', ctrl: 'Control', control: 'Control', alt: 'Alt', opt: 'Alt', option: 'Alt', shift: 'Shift',
    enter: 'Enter', return: 'Enter', tab: 'Tab', esc: 'Escape', escape: 'Escape', space: 'Space', backspace: 'Backspace', delete: 'Delete',
    up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown',
  };
  return combo.split('+').map((k) => k.trim()).filter(Boolean).map((k) => {
    const low = k.toLowerCase();
    if (NAMES[low]) return NAMES[low];
    if (/^f\d{1,2}$/.test(low)) return low.toUpperCase();
    return k.length === 1 ? k : k[0].toUpperCase() + k.slice(1);
  }).join('+');
}

const BROWSER_NAMES = /^(the |a )?(google chrome|chrome|chromium|browser|web browser|safari|firefox|edge|arc|brave)( browser| app| window)?$|^(a )?new (tab|window)$/i;
export const DEFAULT_SEARCH_URL = 'https://www.google.com/search?q=';
// An address that does not exist (a guessed host): the browser cannot resolve or reach it.
const NO_SUCH_SITE = /ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED|DNS_PROBE|ERR_ADDRESS_UNREACHABLE|ERR_CONNECTION_REFUSED|ERR_CONNECTION_TIMED_OUT/i;
// calculator.google.com/app -> "calculator google app": the words someone meant by a guessed address.
export function addressWords(url) {
  let u;
  try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`); } catch { return String(url); }
  const host = u.hostname.replace(/^www\./, '').split('.');
  if (host.length > 1) host.pop();   // the top-level domain says nothing
  return [...host, ...u.pathname.replace(/\.(html?|php|aspx?)$/i, '').split('/')].join(' ').replace(/[-_.+]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function looksLikeUrl(s) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/|$)/i.test(s) || /^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/.test(s);
}
function normalizeUrl(s) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3})/i.test(s)) return `http://${s}`;
  return `https://${s}`;
}

// ---- The shell -----------------------------------------------------------------------------------

/**
 * @param {object} o
 * @param {object} o.conn       Playwright MCP connection (browser), or null for a shell without a screen
 * @param {*}      [o.agent]    who is acting, for guard ({ id, name } or a name)
 * @param {object} [o.guard]    { check, record }; defaults to guard/'s shared guard
 * @param {object} [o.hooks]    { boardPost(note), boardRead(), wait(name), ask(question), done(report), confirm(card), openApp(name), pointAt(point) }
 * @param {*}      [o.target]   which tab eyes/ looks at (default: the current tab)
 * @param {number} [o.maxChars] size of a look (default 6000; --full uses 4x)
 */
export function createShell({ conn, agent = 'worker', guard = defaultGuard, hooks = {}, target, maxChars = 6000, searchUrl = DEFAULT_SEARCH_URL } = {}) {
  const searchLink = (words) => `${searchUrl}${encodeURIComponent(String(words).trim())}`;
  // Opens a web search; in the app the words are typed into the address bar first.
  async function search(words) {
    await pointAtWindow('open', { url: words, typeMs: typeMs(words.length) });
    try {
      await call('browser_navigate', { url: searchLink(words) });
    } catch (err) {
      // Right after a failed load Chrome is still showing its own error page; wait for it, then go again.
      if (!/interrupted by another navigation/i.test(String(err?.message ?? err))) throw err;
      await new Promise((r) => setTimeout(r, 400));
      await call('browser_navigate', { url: searchLink(words) });
    }
    view = null;
    icons = new Map();
    return after();
  }
  let view = null;        // the last eyes/ observation, for ids and diffs
  // Icons and menu items that eyes/ cannot see, found by senju find: id (i3) -> { ref: CSS selector, role, name }.
  let icons = new Map();
  const iconIds = new Map();   // selector -> id, so the same icon keeps its id between finds
  let iconCounter = 0;
  let finished = null;    // the report from senju done

  const ok = (text = '') => (text ? `ok\n${text}` : 'ok');
  const fail = (why) => `error: ${why}`;
  const needScreen = () => { if (!conn) throw new UserError('there is no screen here (no browser connected)'); };

  async function call(tool, args) {
    const res = await conn.client.callTool({ name: tool, arguments: args }, undefined, { timeout: 120000 });
    const text = (res.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    if (res.isError) throw new UserError(cleanError(text));
    return text;
  }

  async function look(full, pageNo = 1) {
    needScreen();
    if (pageNo > 1) {
      view = await eyes.observe(conn, target, { maxChars });
      return lookPage(view, pageNo, maxChars);
    }
    view = await eyes.observe(conn, target, { maxChars: full ? maxChars * 4 : maxChars });
    return withTip(view);
  }

  // senju find: a fresh look (so ids are current) plus the page tree for the text around each element.
  async function find(query) {
    needScreen();
    view = await eyes.observe(conn, target, { maxChars });
    let context = new Map();
    const extra = [];
    if ((conn.tools ?? []).some((t) => t.name === 'browser_snapshot')) {
      try { context = contextFromTree(eyes.parseSnapshot(eyes.parseBrowserOutput(await call('browser_snapshot', {})).yaml ?? '')); } catch { /* rank without it */ }
      let scan = [];
      try { scan = parseScan(await call('browser_evaluate', { function: ICON_SCAN })); } catch { /* no icons */ }
      icons = new Map();
      const idFor = (sel) => { let id = iconIds.get(sel); if (!id) { id = `i${++iconCounter}`; iconIds.set(sel, id); } return id; };
      // A closed-menu entry that is also a visible element (Wikipedia's "Log in") would only be a duplicate.
      const visibleNames = new Set(view.elements.map((e) => String(e.name ?? '').trim().toLowerCase()));
      scan = scan.filter((x) => !x.hidden || !visibleNames.has(String(x.name ?? '').trim().toLowerCase()));
      for (const s of scan) {
        const id = idFor(s.selector);
        const el = { id, role: s.role, name: String(s.name ?? '').slice(0, 120), value: '', ref: s.selector, flags: [], url: '', placeholder: '' };
        icons.set(id, el);
        extra.push(el);
        context.set(s.selector, { near: String(s.near ?? ''), heading: '' });
      }
      // An entry of a closed menu says which icon opens it (the opener has an id when the scan listed it).
      for (const s of scan.filter((x) => x.hidden)) {
        const el = icons.get(iconIds.get(s.selector));
        el.hidden = true;
        el.opener = icons.has(iconIds.get(s.opener.selector)) ? iconIds.get(s.opener.selector) : null;
        el.openerLabel = String(s.opener.label ?? '');
      }
    }
    return formatFind({ ...view, elements: [...view.elements, ...extra] }, query, { context });
  }

  // After an action: what changed on screen, or the whole view when there is nothing to compare with.
  async function after() {
    const before = view;
    try {
      const next = await eyes.observe(conn, target, { maxChars });
      view = next;
      if (!before) return withTip(next);
      // A new page: show it, not a diff that lists every element of the old page as removed.
      if (before.page?.url !== next.page?.url) { icons = new Map(); return `url: ${before.page?.url || '(none)'} -> ${next.page?.url || '(none)'}\n${withTip(next)}`; }
      const d = eyes.diff(before, next);
      return d === 'no change' ? 'no change on screen' : d;
    } catch (err) {
      return `(could not read the screen afterwards: ${err.message})`;
    }
  }

  // An element by id (e12) or by its visible label ("Row 5, column 6"): exact, then a unique prefix, then a unique substring.
  function byLabel(label) {
    const want = label.trim().toLowerCase();
    const els = [...(view?.elements ?? []), ...icons.values()];
    const name = (e) => String(e.name ?? '').toLowerCase();
    for (const test of [(n) => n === want, (n) => n.startsWith(want), (n) => n.includes(want)]) {
      const hits = els.filter((e) => want && test(name(e)));
      if (hits.length === 1) return hits[0].id;
      if (hits.length > 1) {
        const list = hits.slice(0, 5).map((e) => `${e.id} ${e.role} "${e.name}"`).join('; ');
        throw new UserError(`"${label}" matches ${hits.length} elements (${list}${hits.length > 5 ? '; ...' : ''}). Use a longer label or the id.`);
      }
    }
    return null;
  }

  function element(id) {
    needScreen();
    if (!/^[ei]\d+$/.test(id ?? '')) {
      const found = id ? byLabel(id) : null;
      if (!found) throw new UserError(`"${id ?? ''}" is not an element id or a label on screen. Ids look like e12. Try senju find "${id ?? 'words'}" (it searches the whole page, icons too) or senju look.`);
      id = found;
    }
    if (/^i\d+$/.test(id)) {
      const icon = icons.get(id);
      if (!icon) throw new UserError(`there is no icon ${id} now (icon ids last until the page changes). Run senju find again.`);
      return icon;
    }
    const el = eyes.resolve(conn, target, id);
    if (!el) throw new UserError(`there is no element ${id} on screen now. Run senju look to see the current ids.`);
    return el;
  }

  // Before click, type or select: measure the element and tell hooks.pointAt, then wait for it (at most
  // POINT_MAX_MS) so a ghost cursor can arrive before the action lands. Best effort: it never blocks the action.
  // extra: more fields for the hook, e.g. { chars } for type so the app can play the typing.
  async function pointAt(verb, id, el, extra = {}) {
    if (typeof hooks.pointAt !== 'function') return;
    try {
      const text = await call('browser_evaluate', { element: el.name || `${el.role} ${id}`, target: el.ref, function: MEASURE });
      const at = evalResult(text);
      if (!at || !Number.isFinite(at.x)) return;
      await tellPoint({ verb, id, role: el.role, name: el.name, ...at, ...extra });
    } catch { /* no point, no cursor move; the action still runs */ }
  }

  // open, back and key act on the window, not an element: no measuring, the app places these itself
  // ({ verb: 'open' } at the address bar, 'back' at the back button, 'key' where the cursor already is).
  async function pointAtWindow(verb, extra = {}) {
    if (typeof hooks.pointAt !== 'function' || !conn) return;
    try { await tellPoint({ verb, ...extra }); } catch { /* best effort */ }
  }

  async function tellPoint(point) {
    let timer;
    await Promise.race([Promise.resolve(hooks.pointAt(point)), new Promise((r) => { timer = setTimeout(r, POINT_MAX_MS); })]).finally(() => clearTimeout(timer));
  }

  const needHook = (name, verb) => {
    if (typeof hooks[name] !== 'function') throw new UserError(`senju ${verb} is not available here`);
    return hooks[name];
  };

  // The action guard sees: the parsed command plus what the element is, so a click on "Send" is caught.
  // When the name alone cannot tell (an icon-only button, a submit into a text field, Enter), it also gets
  // page hints: aria-label, title, icon names, and whether the element sits in a composer or a delete row.
  async function actionFor(parsed) {
    const { verb, args, flags = {} } = parsed;
    // find only reads, so its words ("trash", "mail") must not look like a delete or a send to guard.
    // Its result (which repeats the query) still lets guard catch a find repeated in a loop.
    if (verb === 'find') return { verb, args: [], flags, element: null, raw: `senju find ${JSON.stringify(args.join(' '))}` };
    let el = null, id = null;
    if ((verb === 'click' || verb === 'type' || verb === 'select') && conn && args[0]) {
      id = args[0];
      if (!/^[ei]\d+$/.test(id)) { try { id = byLabel(id); } catch { id = null; } }
      if (id) el = /^i\d+$/.test(id) ? icons.get(id) ?? null : eyes.resolve(conn, target, id);
    }
    const element = el ? { role: el.role, name: el.name } : null;
    const enter = verb === 'key' && /^(enter|return)$/i.test(args[0] ?? '');
    const wantHints = conn && ((verb === 'click' && el && unnamed(el.name)) || (verb === 'type' && el && flags.submit) || enter);
    if (wantHints) {
      const hints = await pageHints(el ? { element: el.name || `${el.role} ${id}`, target: el.ref } : {});
      if (hints) return { verb, args, flags, element: { ...(element ?? { role: '', name: '' }), ...hints } };
    }
    return { verb, args, flags, element };
  }

  // One browser_evaluate on the element (or the focused element for Enter). null when it cannot be read.
  async function pageHints(on) {
    try {
      const text = await call('browser_evaluate', { ...on, function: on.target ? HINTS : `() => (${HINTS})(document.activeElement)` });
      const out = evalResult(text);
      return out && typeof out === 'object' && 'hints' in out ? out : null;
    } catch { return null; }
  }

  async function exec({ verb, args, flags }) {
    switch (verb) {
      case 'help': case '':
        return ok(SH_TOOL.description);
      case 'look': {
        const n = args[0] === undefined ? 2 : Number(args[0]);
        const pageNo = flags.page ? (Number.isInteger(n) && n >= 1 ? n : NaN) : 1;
        if (Number.isNaN(pageNo)) throw new UserError('usage: senju look --page 2');
        return ok(await look(Boolean(flags.full), pageNo));
      }
      case 'find': {
        const query = args.join(' ').trim();
        if (!query) throw new UserError('usage: senju find "words", for example senju find "shopping cart"');
        return ok(await find(query));
      }
      case 'click': {
        const el = element(args[0]);
        if (el.hidden) {
          let open = true;
          try { open = /### Result\s*\ntrue/.test(await call('browser_evaluate', { element: el.name, target: el.ref, function: '(el) => el.getClientRects().length > 0' })); } catch { open = false; }
          if (!open) throw new UserError(`${el.id} "${el.name}" is in a closed menu. Click ${el.opener ?? `"${el.openerLabel}"`} first to open it, then click ${el.id}.`);
        }
        await pointAt('click', args[0], el);
        // An icon from senju find often swaps its image on hover (MiniWoB's "more"), and the click lands on
        // nothing while the new image loads. Hovering first, as a person's pointer would, lets it settle.
        if (el.ref && !/^e\d+$/.test(el.ref) && /^i\d+$/.test(String(args[0]))) {
          try { await call('browser_hover', { element: el.name || el.role, target: el.ref }); await new Promise((r) => setTimeout(r, 150)); } catch { /* click anyway */ }
        }
        const target = { element: el.name || `${el.role} ${args[0]}`, target: el.ref };
        try {
          await call('browser_click', target);
        } catch (err) {
          // Playwright waits for an element to stop moving, so an animated button (krillion.io "BEGIN DESCENT")
          // always times out. Retry once with a script click, which does not wait. guard.check already ran.
          if (!(err instanceof UserError) || !/timeout/i.test(err.message)) throw err;
          await call('browser_evaluate', { ...target, function: '(el) => { el.click(); }' });
          return ok(`clicked by script (the element kept moving)\n${await after()}`);
        }
        return ok(await after());
      }
      case 'type': {
        if (args.length < 2) throw new UserError('usage: senju type <id> "text"');
        const el = element(args[0]);
        const text = args.slice(1).join(' ');
        await pointAt('type', args[0], el, { chars: text.length, typeMs: typeMs(text.length), submit: Boolean(flags.submit) });
        if (typeof hooks.pointAt === 'function' && text) {
          // Let people watch it type; the fill below still sets the exact text and fires the real events.
          try { await call('browser_evaluate', { element: el.name || `${el.role} ${args[0]}`, target: el.ref, function: typeOut(text) }); } catch { /* fill still runs */ }
        }
        await call('browser_type', { element: el.name || `${el.role} ${args[0]}`, target: el.ref, text: args.slice(1).join(' '), ...(flags.submit ? { submit: true } : {}) });
        return ok(await after());
      }
      case 'select': {
        if (args.length < 2) throw new UserError('usage: senju select <id> "option"');
        const el = element(args[0]);
        await pointAt('select', args[0], el);
        await call('browser_select_option', { element: el.name || `${el.role} ${args[0]}`, target: el.ref, values: args.slice(1) });
        return ok(await after());
      }
      case 'key': {
        if (!args[0]) throw new UserError('usage: senju key <combo>, for example senju key enter');
        needScreen();
        await pointAtWindow('key', { key: args[0] });
        await call('browser_press_key', { key: toPlaywrightKey(args[0]) });
        return ok(await after());
      }
      case 'open': {
        const what = args.join(' ').trim();
        if (!what) throw new UserError('usage: senju open <url or app>');
        const relative = /^[/?#]/.test(what);
        if (relative || looksLikeUrl(what)) {
          needScreen();
          let url = normalizeUrl(what);
          if (relative) {
            const base = view?.page?.url;
            if (!base || !/^https?:/i.test(base)) throw new UserError(`"${what}" is a path; open a full URL first (senju open https://example.com${what.startsWith('/') ? what : '/' + what})`);
            url = new URL(what, base).href;
          }
          await pointAtWindow('open', { url, typeMs: typeMs(url.length) });
          try {
            await call('browser_navigate', { url });
          } catch (err) {
            if (/^chrome:\/\//i.test(what)) throw new UserError(`${what} is not a page you can use here (chrome:// pages are browser settings, not web apps). Find a web version instead: senju search "${what.replace(/^chrome:\/\//i, '').replace(/\/.*$/, '')}"`);
            // A guessed address that does not exist: search for what it meant, so the worker can click the real link.
            if (NO_SUCH_SITE.test(String(err?.message ?? err)) && !/^(https?:\/\/)?(localhost|\d{1,3}(\.\d{1,3}){3})/i.test(what)) {
              const words = addressWords(normalizeUrl(what));
              const page = await search(words);
              return ok(`${what} does not exist, so this searched for "${words}" instead. Click the real link in the results; do not guess addresses.\n${page}`);
            }
            throw err;
          }
          view = null;   // a new page: show it whole
          icons = new Map();
          return ok(await after());
        }
        // A browser worker has no Mac apps: point it at the web instead of a dead end.
        if (typeof hooks.openApp !== 'function' && conn) {
          if (BROWSER_NAMES.test(what)) throw new UserError(`you are already in a ${/safari|firefox|edge|arc|brave/i.test(what) ? 'browser' : 'Chrome'} window. Open a web page in it with senju open <url>, for example senju open https://www.google.com`);
          throw new UserError(`there is no "${what}" app here, only this browser window. Find the web version: senju search "${what}", then click the right result.`);
        }
        const out = await needHook('openApp', 'open <app>')(what);
        return ok(out ?? `opened ${what}`);
      }
      case 'search': {
        const words = args.join(' ').trim();
        if (!words) throw new UserError('usage: senju search "what you are looking for"');
        needScreen();
        return ok(`searched for "${words}". Click the result that matches what you want.\n${await search(words)}`);
      }
      case 'back': {
        needScreen();
        await pointAtWindow('back');
        await call('browser_navigate_back', {});
        view = null;
        icons = new Map();
        return ok(await after());
      }
      case 'board': {
        const sub = (args[0] ?? '').toLowerCase();
        if (sub === 'post') {
          const note = args.slice(1).join(' ').trim();
          if (!note) throw new UserError('usage: senju board post "note"');
          await needHook('boardPost', 'board post')(note);
          return ok('posted');
        }
        if (sub === 'read') {
          const notes = await needHook('boardRead', 'board read')();
          return ok(typeof notes === 'string' ? notes : (notes ?? []).map((n) => `${n.from}: ${n.note}`).join('\n') || 'the board is empty');
        }
        throw new UserError('usage: senju board post "note" | senju board read');
      }
      case 'wait': {
        if (!args[0]) throw new UserError('usage: senju wait <worker> or senju wait <duration>, for example 2s');
        const ms = args.length === 1 ? parseDuration(args[0]) : null;
        if (ms !== null) {
          const slept = Math.min(ms, MAX_WAIT_MS);
          await new Promise((r) => setTimeout(r, slept));
          return ok(`waited ${slept >= 1000 ? `${slept / 1000}s` : `${slept}ms`}${slept < ms ? ` (capped at ${MAX_WAIT_MS / 1000}s)` : ''}`);
        }
        return ok(String(await needHook('wait', 'wait')(args.join(' ')) ?? ''));
      }
      case 'ask': {
        const q = args.join(' ').trim();
        if (!q) throw new UserError('usage: senju ask "question"');
        const answer = await needHook('ask', 'ask')(q);
        return ok(`The person answered: ${answer}`);
      }
      case 'done': {
        finished = args.join(' ').trim() || 'done';
        const out = hooks.done ? await hooks.done(finished) : null;
        return ok(out ?? 'Subtask finished. Stop now: write your final report as plain text and call no more tools.');
      }
      default:
        throw new UserError(`unknown command "senju ${verb}". Run "senju help" for the commands.`);
    }
  }

  async function runLine(line) {
    const parsed = parseLine(line);
    if (parsed.error) return fail(parsed.error);
    const action = await actionFor(parsed);
    const verdict = guard.check(agent, action);
    if (verdict.deny) return fail(verdict.reason);
    if (verdict.confirm) {
      const yes = hooks.confirm ? await hooks.confirm(verdict.card) : false;
      if (!yes) {
        const out = fail(hooks.confirm
          ? `the person did not approve this (${verdict.card.title}). Do not try it again; carry on without it or ask what they want.`
          : `this needs a person's approval (${verdict.card.title}) and nobody can approve it here. Report it with senju done instead.`);
        guard.record?.(agent, action, out);
        return out;
      }
    }
    let out;
    try {
      out = await exec(parsed);
    } catch (err) {
      out = fail(err instanceof UserError ? err.message : `${parsed.verb} failed: ${err?.message ?? err}`);
    }
    guard.record?.(agent, action, out);
    return out;
  }

  return {
    get finished() { return finished; },
    get view() { return view; },
    /** Run one or more senju lines. Stops at the first error. */
    async run(cmd) {
      const split = splitCommands(cmd);
      if (split.error) return fail(split.error);
      const lines = split.commands;
      if (lines.length === 0) return fail('empty command. Run "senju help" for the commands.');
      if (lines.length === 1) return runLine(lines[0]);
      const parts = [];
      for (let i = 0; i < lines.length; i++) {
        const out = await runLine(lines[i]);
        parts.push(`$ ${lines[i]}\n${out}`);
        if (out.startsWith('error:')) {
          const skipped = lines.length - i - 1;
          return `error: line ${i + 1} failed${skipped ? `, ${skipped} later line${skipped > 1 ? 's' : ''} not run` : ''}\n${parts.join('\n\n')}`;
        }
      }
      return `ok\n${parts.join('\n\n')}`;
    },
  };
}

class UserError extends Error {}

// ---- Big pages -----------------------------------------------------------------------------------

const CUT = /^… \d+ more (elements|text)$/m;

/** A look's text, plus a pointer to find and --page when the page did not fit. */
export function withTip(v) {
  if (!CUT.test(v.text)) return v.text;
  return `${v.text}\n(page cut to fit: senju find "words" searches all ${v.elements.length} elements; senju look --page 2 shows the next part)`;
}

// Which element and text lines a rendered look shows: counts the lines of each section.
function shownCounts(text) {
  let sec = null, els = 0, txt = 0;
  for (const l of text.split('\n')) {
    if (/^-- elements \(\d+\)$/.test(l)) { sec = 'e'; continue; }
    if (/^-- text \(\d+\)$/.test(l)) { sec = 't'; continue; }
    if (/^… \d+ more (elements|text)$/.test(l)) { sec = null; continue; }
    if (sec === 'e') els++;
    else if (sec === 't') txt++;
  }
  return { els, txt };
}

/**
 * Page n of a look: what comes after pages 1..n-1, each cut the way look cuts. Page 1 is plain look.
 * @param {{ page, elements, lines }} v  an eyes/ observe() result
 */
export function lookPage(v, n, maxChars = 6000) {
  const E = v.elements.map((e) => e), T = v.lines;
  let ei = 0, ti = 0, text = '';
  for (let p = 1; p <= n; p++) {
    if (ei >= E.length && ti >= T.length) {
      return `page: ${v.page.title || '(untitled)'}\nurl: ${v.page.url || '(none)'}\nthe page has only ${p - 1} part${p - 1 === 1 ? '' : 's'}; there is no part ${n}.`;
    }
    text = eyes.render(v.page, E.slice(ei), T.slice(ti), maxChars);
    if (p === n) break;
    const { els, txt } = shownCounts(text);
    if (!els && !txt) break;
    ei += els; ti += txt;
  }
  const more = shownCounts(text);
  const left = E.length - ei - more.els + T.length - ti - more.txt;
  text = text
    .replace(/^-- elements \((\d+)\)$/m, `-- elements (${ei + 1}-${ei + more.els} of ${E.length})`)
    .replace(/^-- text \((\d+)\)$/m, `-- text (lines ${ti + 1}-${ti + more.txt} of ${T.length})`);
  return `${text}\n(part ${n}${left > 0 ? `; senju look --page ${n + 1} shows the next part` : ', the last part'})`;
}

function cleanError(text) {
  const t = String(text ?? '').replace(/^### Error\s*/m, '').trim();
  return (t.split('\n').find((l) => l.trim()) ?? 'the browser reported an error').slice(0, 300);
}

/**
 * Wrap a shell as an MCP-like connection with one tool, sh, so the swarm engine's Swarm can use it through
 * its `connect` override (the Swarm names the tool `<name>__sh`). close() closes the underlying conn.
 */
export function shellConnection(shell, { name = 'senju', conn = null } = {}) {
  return {
    name,
    tools: [{ name: SH_TOOL.name, description: SH_TOOL.description, inputSchema: SH_TOOL.input_schema }],
    pid: conn?.pid ?? null,
    client: {
      async callTool({ name: tool, arguments: args }) {
        if (tool !== 'sh') return { content: [{ type: 'text', text: `error: unknown tool ${tool}` }], isError: true };
        const text = await shell.run(args?.cmd);
        return { content: [{ type: 'text', text }], isError: text.startsWith('error:') };
      },
    },
    close: async () => { await conn?.close?.(); },
  };
}
