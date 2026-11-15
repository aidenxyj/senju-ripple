// shell/find.js: `senju find "<words>"`. Searches every element on the page (not just the slice `senju look`
// shows) and ranks them against the words, so a weak model can find the right link or button on a big page.
// Pure functions, so they are unit-tested without a browser.
//
//   contextFromTree(tree)                         -> Map(ref -> { near, heading })   (tree: eyes.parseSnapshot)
//   rankElements(elements, query, { context, pageUrl })  -> [{ el, score, words, near, heading }]
//   formatFind(view, query, { context, limit })   -> text for the model
import { elementLine } from '../eyes/index.js';

export const FIND_LIMIT = 8;

// Words that say nothing about which element is meant.
const STOP = new Set(('a an the to of for in on at by and or with from into onto this that these those it its is are be ' +
  'my me i you your our please click press tap go open find show get select choose want need then on page ' +
  'here there one some any all icon').split(' '));
// Words that say which kind of element is meant: they steer the ranking but need not appear in the element.
const ROLE_WORDS = {
  link: ['link'], links: ['link'], button: ['button'], buttons: ['button'], btn: ['button'],
  field: ['textbox', 'searchbox', 'combobox'], textbox: ['textbox', 'searchbox'], input: ['textbox', 'searchbox', 'combobox'],
  box: ['textbox', 'searchbox', 'checkbox'], searchbox: ['searchbox', 'textbox'], checkbox: ['checkbox'], radio: ['radio'],
  dropdown: ['combobox', 'listbox'], select: ['combobox', 'listbox'], menu: ['menuitem', 'button'], tab: ['tab'], option: ['option'],
};
const URL_NOISE = new Set(['http', 'https', 'www', 'com', 'org', 'net', 'html', 'htm', 'php', 'aspx', 'index', 'ref', 'utm', 'source', 'medium', 'campaign']);

// Words that sites use for the same thing. A synonym counts like a near miss.
const SYNONYM_GROUPS = [
  ['next', 'more', 'older', 'forward'], ['previous', 'prev', 'back', 'newer'], ['login', 'signin', 'sign', 'log'],
  ['logout', 'signout'], ['signup', 'register', 'join'], ['cart', 'basket', 'bag', 'trolley'], ['delete', 'remove', 'trash', 'bin', 'discard'],
  ['search', 'find', 'query', 'lookup'], ['account', 'profile', 'user'], ['setting', 'preference', 'option', 'config'],
  ['message', 'chat', 'messenger', 'inbox', 'dm'], ['email', 'mail', 'inbox'], ['buy', 'purchase', 'checkout', 'order'],
  ['add', 'new', 'create', 'plus'], ['edit', 'modify', 'change', 'update'], ['close', 'dismiss', 'cancel'], ['menu', 'more', 'hamburger', 'nav'],
  ['home', 'main', 'start'], ['help', 'support', 'faq'], ['todo', 'task'], ['calendar', 'event', 'schedule'], ['reply', 'respond', 'answer'],
];
const SYNONYMS = new Map();
for (const g of SYNONYM_GROUPS) for (const w of g) SYNONYMS.set(w, [...new Set([...(SYNONYMS.get(w) ?? []), ...g.filter((x) => x !== w)])]);

// Fields of an element and how much a match in each counts.
const WEIGHTS = { name: 1, placeholder: 0.9, url: 0.8, value: 0.7, near: 0.5, heading: 0.3 };

/** "openShoppingCart_v2" -> ['open', 'shopping', 'cart', 'v2'], lowercased and split on anything not a letter or digit. */
export function tokens(text) {
  return String(text ?? '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** A light stem so "emails" finds "email" and "deleting" finds "delete". */
export function stem(w) {
  if (w.length <= 3 || /^\d+$/.test(w)) return w;
  if (w.endsWith('ies') && w.length > 4) return w.slice(0, -3) + 'y';
  if (/(ss|us|is)$/.test(w)) return w;
  if (/(sh|ch|x|z)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith('s')) return w.slice(0, -1);
  if (w.endsWith('ing') && w.length > 5) return w.slice(0, -3).replace(/(.)\1$/, '$1');
  if (w.endsWith('ed') && w.length > 4) return w.slice(0, -2).replace(/(.)\1$/, '$1');
  return w;
}

/** Edit distance, giving up (returning max + 1) once it is over max. */
export function editDistance(a, b, max = 2) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** How well one query word matches a field: 1 exact, 0.75 prefix, 0.6 inside a longer word or one typo away, else 0. */
function wordMatch(q, field) {
  if (!field.words.length) return 0;
  let best = 0;
  for (const w of field.words) {
    if (w === q) return 1;
    if (q.length >= 3 && w.startsWith(q)) best = Math.max(best, 0.75);
    else if (w.length >= 4 && q.length - w.length <= 3 && q.startsWith(w)) best = Math.max(best, 0.7);
    else if (q.length >= 5 && w.length >= 4) {   // 4-letter words are too close to each other (cart, card, care)
      const max = q.length >= 8 ? 2 : 1;
      if (Math.abs(w.length - q.length) <= max && editDistance(q, w, max) <= max) best = Math.max(best, 0.6);
    }
  }
  if (best < 0.6 && q.length >= 4 && field.joined.includes(q)) best = 0.6;
  if (best < 0.55) for (const syn of SYNONYMS.get(q) ?? []) if (field.words.includes(syn)) { best = 0.55; break; }
  return best;
}

const field = (text) => {
  const words = tokens(text).map(stem);
  return { words, joined: tokens(text).join('') };
};

/** The words of a link's URL that say where it goes: path and query, plus the host when it is another site. */
export function urlWords(url, pageUrl) {
  if (!url) return '';
  let u;
  try { u = new URL(url, pageUrl || 'http://x.invalid/'); } catch { return url; }
  let host = '';
  try { if (!pageUrl || new URL(pageUrl).host !== u.host) host = u.host; } catch { host = u.host; }
  return [host, decodeURIComponent(u.pathname), decodeURIComponent(u.search), decodeURIComponent(u.hash)].join(' ');
}

/** A link's URL as the model should read it: the path alone on the same site, a long tracking query cut, cut to fit. */
export function shortUrl(url, pageUrl, max = 80) {
  let s = String(url ?? '');
  try {
    const u = new URL(s, pageUrl || undefined);
    if (!/^https?:$/.test(u.protocol)) return s.length > max ? s.slice(0, max - 1) + '…' : s;   // javascript:, mailto:
    const query = u.search.length > 30 ? '?…' : u.search;
    s = (pageUrl && new URL(pageUrl).origin === u.origin ? '' : u.origin) + u.pathname + query + (u.hash.length > 30 ? '' : u.hash);
  } catch { /* keep as given */ }
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** Splits a query into content words and the roles it names ("the login button" -> ['login'], ['button']). */
export function parseQuery(query) {
  const raw = tokens(query);
  const roles = new Set();
  const words = [];
  for (const w of raw) {
    if (ROLE_WORDS[w]) { for (const r of ROLE_WORDS[w]) roles.add(r); continue; }
    if (STOP.has(w)) continue;
    words.push(stem(w));
  }
  // A query of only stop or role words ("the button") still searches for what it says.
  if (!words.length) for (const w of raw) if (!STOP.has(w)) words.push(stem(w));
  if (!words.length) for (const w of raw) words.push(stem(w));
  return { words: [...new Set(words)], roles, phrase: raw.filter((w) => !ROLE_WORDS[w] && !STOP.has(w)).join(' ') };
}

// Visible text of a tree node, like a person reads it.
function readText(node, max = 300) {
  let out = '';
  const walk = (n) => {
    if (out.length > max) return;
    if (typeof n === 'string') { out += ' ' + n; return; }
    const before = out.length;
    if (n.text) out += ' ' + n.text;
    for (const c of n.children ?? []) walk(c);
    if (out.length === before && n.name) out += ' ' + n.name;
  };
  walk(node);
  return out.replace(/\s+/g, ' ').trim();
}

const NEAR_MAX = 240;
const ACTIONABLE = new Set(['button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox', 'menuitem', 'tab', 'switch', 'option', 'treeitem']);
const actionable = (n) => typeof n !== 'string' && Boolean(n.ref) && (ACTIONABLE.has(n.role) || n.attrs?.cursor === 'pointer');

/**
 * For every node with a ref: the text around it (its smallest enclosing block that says more than the element
 * itself, such as the table row, list item or card it sits in) and the last heading above it.
 * A block that holds more than two controls like this one is a list of them, not this one's own card, so the
 * search stops there (otherwise every row of a list would be "near" every other row's words).
 */
export function contextFromTree(root) {
  const out = new Map();
  if (!root) return out;
  let heading = '';
  const textCache = new Map();
  const textOf = (n) => { if (!textCache.has(n)) textCache.set(n, readText(n, NEAR_MAX + 1)); return textCache.get(n); };
  const countCache = new Map();
  const sameRole = (n, role) => {
    const k = `${role}`;
    let m = countCache.get(n);
    if (!m) { m = new Map(); countCache.set(n, m); }
    if (!m.has(k)) {
      let c = 0;
      const walk = (x) => { if (typeof x === 'string' || c > 3) return; if (x !== n && actionable(x) && x.role === role) c++; for (const ch of x.children ?? []) walk(ch); };
      walk(n);
      m.set(k, c);
    }
    return m.get(k);
  };
  const visit = (node, ancestors) => {
    if (typeof node === 'string') return;
    if (node.role === 'heading') heading = node.name || readText(node, 120);
    if (node.ref && node !== root) {
      const own = textOf(node);
      let near = '';
      for (let i = ancestors.length - 1; i >= 1; i--) {
        const t = textOf(ancestors[i]);
        if (t.length > NEAR_MAX || sameRole(ancestors[i], node.role) > 2) break;
        if (t.length > own.length + 3) { near = t; break; }
      }
      out.set(node.ref, { near, heading });
    }
    ancestors.push(node);
    for (const c of node.children ?? []) visit(c, ancestors);
    ancestors.pop();
  };
  visit(root, []);
  return out;
}

/**
 * Score every element against the query. Returns matches, best first (page order breaks ties).
 * @param {Array} elements  eyes/ elements { id, role, name, value, url, placeholder }
 * @param {string} query
 * @param {{ context?: Map, pageUrl?: string }} [o]
 */
export function rankElements(elements, query, { context = new Map(), pageUrl = '' } = {}) {
  const q = parseQuery(query);
  if (!q.words.length) return [];
  const phrase = q.phrase;
  const hits = [];
  elements.forEach((el, index) => {
    const ctx = context.get(el.ref) ?? {};
    const near = ctx.near && el.name ? ctx.near.replace(el.name, ' ') : ctx.near ?? '';
    const fields = {
      name: field(el.name), placeholder: field(el.placeholder), url: field(urlWords(el.url, pageUrl)),
      value: field(el.value), near: field(near), heading: field(ctx.heading),
    };
    fields.url.words = fields.url.words.filter((w) => !URL_NOISE.has(w));
    let sum = 0;
    let strong = false;   // matched somewhere other than the heading above it
    let matched = 0;
    for (const w of q.words) {
      let best = 0;
      let where = '';
      for (const [k, wt] of Object.entries(WEIGHTS)) {
        const m = wordMatch(w, fields[k]) * wt;
        if (m > best) { best = m; where = k; }
      }
      if (best > 0) { matched++; if (where !== 'heading') strong = true; }
      sum += best;
    }
    if (!strong) return;
    let score = sum / q.words.length;
    const name = tokens(el.name).join(' ');
    if (phrase && name) {
      if (name === phrase) score += 0.35;
      else if (phrase.includes(' ') && name.includes(phrase)) score += 0.25;
    }
    if (q.roles.size && q.roles.has(el.role)) score += 0.15;
    if (!el.name && !el.url && !el.placeholder) score -= 0.05;   // nothing to tell it apart by
    if (el.hidden) score *= 0.85;   // in a closed menu: one more click away
    hits.push({ el, index, score, matched, near: ctx.near ?? '', heading: ctx.heading ?? '' });
  });
  hits.sort((a, b) => b.score - a.score || a.index - b.index);
  return hits;
}

const clip = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

/** One result line: the element as `senju look` prints it, with a short URL and where on the page it sits. */
export function resultLine(hit, pageUrl) {
  const { el } = hit;
  let line = elementLine({ ...el, name: clip(el.name, 80), url: '' });
  if (el.url) line += ` -> ${shortUrl(el.url, pageUrl)}`;
  let where = hit.near && el.name ? hit.near.replace(el.name, '…') : hit.near;
  if (String(el.name ?? '').length >= 40) where = '';   // a long name says enough
  where = clip(where, 70);
  if (el.hidden) line += ` [in a closed menu: click ${el.opener ?? `"${clip(el.openerLabel, 30)}"`} first]`;
  if (where && where !== '…') line += `  (in: ${where})`;
  else if (hit.heading) line += `  (under: ${clip(hit.heading, 60)})`;
  return line;
}

// Words on the page that look like the query words, for "no match" answers.
function closeWords(elements, words, max = 6) {
  const vocab = new Map();
  for (const e of elements) for (const w of [...tokens(e.name), ...tokens(e.placeholder)]) if (w.length >= 3) vocab.set(w, (vocab.get(w) ?? 0) + 1);
  const out = [];
  for (const q of words) {
    for (const w of vocab.keys()) {
      if (out.includes(w)) continue;
      if ((q.length >= 4 && w.slice(0, 3) === q.slice(0, 3)) || editDistance(q, w, 2) <= 2) out.push(w);
      if (out.length >= max) return out;
    }
  }
  return out;
}

/**
 * The answer to `senju find`.
 * @param {{ page, elements, lines }} view  an eyes/ observe() result
 * @param {string} query
 * @param {{ context?: Map, limit?: number }} [o]
 */
export function formatFind(view, query, { context = new Map(), limit = FIND_LIMIT } = {}) {
  const elements = view?.elements ?? [];
  const pageUrl = view?.page?.url ?? '';
  const q = parseQuery(query);
  if (!q.words.length) return 'usage: senju find "words", for example senju find "shopping cart"';
  const hits = rankElements(elements, query, { context, pageUrl });
  const out = [];
  const total = `${elements.length} element${elements.length === 1 ? '' : 's'}`;

  // Page text that has every word, for answers that are text rather than a control (a price, a date).
  const textHits = (view?.lines ?? []).filter((l) => {
    const f = field(l);
    return q.words.every((w) => wordMatch(w, f) >= 0.75);
  }).slice(0, 2);

  if (!hits.length) {
    out.push(`no element matches "${query}" among ${total} on this page.`);
    if (textHits.length) {
      out.push('-- text with those words (not clickable)');
      for (const l of textHits) out.push(clip(l, 140));
    }
    const close = closeWords(elements, q.words);
    out.push(`Try other words: a synonym, what the control does, or part of the link's URL${close.length ? `. Close words on this page: ${close.join(', ')}` : ''}.`);
    out.push('It may be in a closed menu: senju find "more" or "menu" shows the buttons that open one.');
    return out.join('\n');
  }

  const best = hits[0].score;
  const weak = hits[0].matched < q.words.length && best < 0.6;
  const good = hits.filter((h) => h.score >= best * 0.65);   // the rest only share a stray word or a near miss
  const shown = good.slice(0, limit);
  out.push(`${weak ? 'only partial matches' : `${good.length} match${good.length === 1 ? '' : 'es'}`} for "${query}" among ${total}, best first:`);
  for (const h of shown) out.push(resultLine(h, pageUrl));
  if (good.length > shown.length) out.push(`… ${good.length - shown.length} more not shown; add words to narrow it.`);
  if (textHits.length) {
    out.push('-- text with those words');
    for (const l of textHits) out.push(clip(l, 140));
  }
  if (weak) out.push('None has all your words. Try other words, or part of the link\'s URL.');
  return out.join('\n');
}

// ---- Icons and menu items the accessibility tree leaves out ---------------------------------------
//
// Some pages draw controls as empty elements with a CSS image (MiniWoB's trash and reply icons) or as plain
// list items with a click handler. They have no role and no name, so they are not in eyes/ at all.
// ICON_SCAN runs in the page (browser_evaluate) and returns them with a unique CSS selector, which Playwright's
// browser_click accepts as its target. Native controls (links, buttons, fields, anything with a role) are
// skipped: eyes/ already lists those.
export const ICON_SCAN = `() => {
  const MAX = 200;
  const NATIVE = 'a[href],button,input,select,textarea,summary,option,label,[role],[contenteditable=""],[contenteditable=true]';
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
  };
  const file = (u) => { const m = /url\\(["']?([^"')]+)["']?\\)/.exec(u || ''); return m ? m[1].split(/[?#]/)[0].split('/').pop().replace(/\\.[a-z0-9]+$/i, '') : ''; };
  const words = (el) => {
    const s = getComputedStyle(el);
    const img = el.tagName === 'IMG' ? (el.getAttribute('src') || '').split(/[?#]/)[0].split('/').pop().replace(/\\.[a-z0-9]+$/i, '') : '';
    const parts = [el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('alt'), el.getAttribute('data-tooltip'),
      typeof el.className === 'string' ? el.className : '', el.id, img, file(s.content), file(s.backgroundImage)];
    return [...new Set(parts.filter(Boolean).join(' ').split(/[^A-Za-z0-9]+/).filter((w) => w.length > 1 && !/\\d/.test(w) && !/^(icon|ico|img|image|fa|svg|btn|png|hover|active|hide|show|js|ng|css|mw|file|element)$/i.test(w)))].join(' ');
  };
  const selector = (el) => {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
      if (n.id && document.querySelectorAll('#' + CSS.escape(n.id)).length === 1) { parts.unshift('#' + CSS.escape(n.id)); break; }
      let k = 1;
      for (let s = n.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === n.tagName) k++;
      parts.unshift(n.tagName.toLowerCase() + ':nth-of-type(' + k + ')');
    }
    return parts.join(' > ');
  };
  // The text of the smallest block around it that says something (the email row, the tweet), not just a time.
  // A block holding another icon like this one is the whole list, so the search stops below it.
  const near = (el) => {
    const like = el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/).map((c) => CSS.escape(c)).join('.') : '');
    let first = '';
    for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
      if (n.querySelectorAll(like).length > 1) break;
      const t = (n.innerText || '').replace(/\\s+/g, ' ').trim();
      if (t.length > 200) break;
      if (t && !first) first = t;
      if (t.length >= 15) return t;
    }
    return first;
  };
  // A list item is a menu entry when its list sits in something called a menu, dropdown, popup or controls.
  const MENU = /^(menu|menus|dropdown|popup|popover|options|controls?|actions?)$/i;
  const inMenu = (el) => {
    for (let n = el.parentElement, i = 0; n && i < 3; n = n.parentElement, i++) {
      if (typeof n.className === 'string' && n.className.split(/[\\s_-]+/).some((c) => MENU.test(c))) return true;
    }
    return false;
  };
  // An entry of a closed menu (display: none until its button is clicked), and the button that opens it.
  const shown = (el) => el.getClientRects().length > 0;
  const OPENER = /(^|[\\s_-])(more|menu|toggle|dropdown|caret|kebab|ellipsis|options|overflow|actions)([\\s_-]|$)/i;
  const menuEntry = (el) => {
    if (!/^(LI|A|BUTTON)$/.test(el.tagName) && el.getAttribute('role') !== 'menuitem') return '';
    if (el.tagName === 'LI' && el.querySelector('a,button,input,select,textarea,li')) return '';
    const text = (el.textContent || '').replace(/\\s+/g, ' ').trim();
    if (!text || text.length > 40) return '';
    return el.getAttribute('role') === 'menuitem' || el.closest('[role=menu]') || inMenu(el) ? text : '';
  };
  const opener = (el) => {
    let box = el.parentElement;
    while (box && box !== document.body && !shown(box)) box = box.parentElement;
    if (!box || box === document.body) return null;
    const cands = [...box.querySelectorAll('*')].filter((c) => shown(c) && !c.contains(el));
    const pick = cands.find((c) => c.hasAttribute('aria-haspopup') || c.hasAttribute('aria-expanded'))
      || cands.find((c) => OPENER.test(typeof c.className === 'string' ? c.className : '') || OPENER.test(c.getAttribute('aria-label') || ''))
      || cands.find((c) => !(c.innerText || '').trim() && (file(getComputedStyle(c).content) || file(getComputedStyle(c).backgroundImage) || c.querySelector(':scope > svg')));
    return pick ? { selector: selector(pick), label: (pick.getAttribute('aria-label') || (pick.innerText || '').trim() || words(pick)).slice(0, 40) } : null;
  };
  const out = [];
  let hidden = 0;
  for (const el of document.body.querySelectorAll('*')) {
    if (out.length >= MAX) break;
    if (!shown(el)) {
      const name = hidden < 100 ? menuEntry(el) : '';
      const o = name && opener(el);
      if (o) { hidden++; out.push({ role: 'menu item', name, selector: selector(el), near: near(el), hidden: true, opener: o }); }
      continue;
    }
    if (el.matches(NATIVE) || el.closest('a[href],button,[role=button],[role=link],[role=menuitem],[role=option],[role=tab]')) continue;
    if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|HTML|BODY|BR|HR|svg|path|g|use)$/.test(el.tagName)) continue;
    const text = (el.innerText || '').replace(/\\s+/g, ' ').trim();
    const s = getComputedStyle(el);
    // A CSS-drawn image or an inline svg is usually a control; a plain <img> only when it acts like one.
    // Its own pointer cursor, not one inherited from a clickable row around it.
    const ownPointer = s.cursor === 'pointer' && (!el.parentElement || getComputedStyle(el.parentElement).cursor !== 'pointer');
    const clicky = ownPointer || el.hasAttribute('onclick') || el.hasAttribute('tabindex');
    const hasImage = el.tagName === 'IMG' ? clicky : file(s.content) || file(s.backgroundImage) || el.querySelector(':scope > svg');
    const r = el.getBoundingClientRect();
    let kind = null, name = '';
    if (!text && (hasImage || clicky) && r.width <= 96 && r.height <= 96) {
      kind = 'icon'; name = words(el);
      if (!name) continue;
    } else if (el.tagName === 'LI' && text && text.length <= 40 && !el.querySelector('a,button,input,select,textarea,li') && el.parentElement && el.parentElement.children.length <= 12 && (s.cursor === 'pointer' || inMenu(el))) {
      kind = 'menu item'; name = text;
    }
    if (!kind || !visible(el)) continue;
    out.push({ role: kind, name, selector: selector(el), near: near(el) });
  }
  return out;
}`;

/** Parses browser_evaluate's text ("### Result\n<json>\n### Ran ...") into the scan list. */
export function parseScan(text) {
  const m = /### Result\s*\n([\s\S]*?)(?:\n### |$)/.exec(String(text ?? ''));
  try {
    const v = JSON.parse(m ? m[1] : text);
    return Array.isArray(v) ? v.filter((x) => x && typeof x.selector === 'string' && x.selector && (!x.hidden || typeof x.opener?.selector === 'string')) : [];
  } catch { return []; }
}
