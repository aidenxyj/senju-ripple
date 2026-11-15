// Source-agnostic core: turn a parsed tree into elements + text lines, keep element ids
// stable across observations, render within a char budget, hash, and diff.
// Every function here is pure (state objects are passed in), so it is unit-testable.

import crypto from 'node:crypto';

// Roles a worker can act on. `option` counts only inside a listbox (options of a native
// <select> are chosen through the combobox).
export const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox',
  'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'switch', 'slider', 'spinbutton',
  'treeitem', 'option',
]);

const VALUE_ROLES = new Set(['textbox', 'searchbox', 'spinbutton', 'slider', 'combobox']);
const CHECK_ROLES = new Set(['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio']);
const FLAG_ATTRS = ['disabled', 'expanded', 'pressed', 'selected', 'invalid', 'active'];
// Playwright marks the element with keyboard focus [active]; the model reads it as [focused].
const FLAG_LABEL = { active: 'focused' };
const CLICKABLE_TEXT_MAX = 80;

function textOf(node, max = 200) {
  let out = '';
  const walk = (n) => {
    if (out.length > max) return;
    if (typeof n === 'string') { out += (out ? ' ' : '') + n; return; }
    if (n.text) out += (out ? ' ' : '') + n.text;
    for (const c of n.children) walk(c);
  };
  walk(node);
  return out.replace(/\s+/g, ' ').trim();
}

// Text of a node as a person reads it, including names that Playwright puts on the node
// itself rather than in a text child (cells, links, buttons: cell "2026-08-14").
function readText(node, max = 200) {
  let out = '';
  const walk = (n) => {
    if (out.length > max) return;
    if (typeof n === 'string') { out += (out ? ' ' : '') + n; return; }
    const before = out.length;
    if (n.text) out += (out ? ' ' : '') + n.text;
    for (const c of n.children) walk(c);
    if (out.length === before && n.name) out += (out ? ' ' : '') + n.name;
  };
  walk(node);
  return out.replace(/\s+/g, ' ').trim();
}

const TABLE_CELLS = new Set(['cell', 'gridcell', 'columnheader', 'rowheader']);

function isInteractive(node, parent) {
  if (!node.ref) return false;
  if (node.role === 'option') return parent?.role === 'listbox';
  if (INTERACTIVE_ROLES.has(node.role)) return true;
  // A generic element with a pointer cursor (e.g. a clickable <div>) and a short label.
  if (node.attrs.cursor === 'pointer') {
    const label = node.name || textOf(node, CLICKABLE_TEXT_MAX + 1);
    return label.length > 0 && label.length <= CLICKABLE_TEXT_MAX;
  }
  return false;
}

function valueOf(node) {
  if (CHECK_ROLES.has(node.role)) {
    const c = node.attrs.checked;
    return c === 'mixed' ? 'mixed' : c ? 'checked' : 'unchecked';
  }
  if (node.role === 'combobox') {
    const sel = node.children.find((c) => typeof c !== 'string' && c.role === 'option' && c.attrs.selected);
    if (sel) return sel.name || textOf(sel);
  }
  // A value is inline (`textbox "X": v`) or, next to a /placeholder prop, a `text:` child.
  if (VALUE_ROLES.has(node.role)) return node.text ?? node.children.filter((c) => typeof c === 'string').join(' ');
  return '';
}

/**
 * Walk a parsed tree (see parse.js) and collect:
 * - nodes: interactive candidates { ref, role, name, value, flags, url, placeholder, path, parentRef }
 * - lines: condensed page text (headings, paragraphs, text, images), in page order
 */
export function extract(root) {
  const nodes = [];
  const lines = [];
  // quiet: inside an interactive element, whose text is its name. Only nested
  // interactive elements (listbox options, a button inside a clickable row) are kept.
  const visit = (node, parent, path, parentRef, quiet = false) => {
    if (typeof node === 'string') return;
    if (node !== root && isInteractive(node, parent)) {
      const flags = FLAG_ATTRS.filter((a) => node.attrs[a]).map((a) => (node.attrs[a] === true ? (FLAG_LABEL[a] ?? a) : `${a}=${node.attrs[a]}`));
      nodes.push({
        ref: node.ref,
        role: node.role,
        name: node.name || (INTERACTIVE_ROLES.has(node.role) ? '' : textOf(node, CLICKABLE_TEXT_MAX)),
        value: valueOf(node),
        flags,
        url: node.props.url ?? '',
        placeholder: node.props.placeholder ?? '',
        path,
        parentRef,
      });
      const p = path + '/' + node.role + (node.name ? `"${node.name.slice(0, 40)}"` : '');
      for (const c of node.children) visit(c, node, p, node.ref, true);
      return;
    }
    if (quiet) {
      const p = path + '/' + node.role;
      for (const c of node.children) visit(c, node, p, node.ref ?? parentRef, true);
      return;
    }
    if (node.role === 'heading') {
      const t = node.name || textOf(node);
      if (t) lines.push('#'.repeat(Math.min(Number(node.attrs.level) || 2, 6)) + ' ' + t);
      return;
    }
    if (node.role === 'img' && node.name) lines.push(`[img: ${node.name}]`);
    // A table row reads as one line, so values (dates, prices, counts) stay next to what they belong to:
    // "| Re: venue for offsite | 2026-08-14 | Delete Re: venue for offsite |". Its links and buttons are still listed as elements.
    if (node.role === 'row' && node.children.some((c) => typeof c !== 'string' && TABLE_CELLS.has(c.role))) {
      const cells = node.children.filter((c) => typeof c !== 'string').map((c) => readText(c, 120));
      if (cells.some(Boolean)) lines.push(`| ${cells.join(' | ')} |`);
      const p = path + '/row';
      for (const c of node.children) visit(c, node, p, node.ref ?? parentRef, true);
      return;
    }
    const siblingNames = new Set(node.children.filter((c) => typeof c !== 'string' && isInteractive(c, node)).map((c) => c.name));
    let run = [];
    const flush = () => {
      const t = run.join(' ').replace(/\s+/g, ' ').replace(/ ([,.;:!?)])/g, '$1').trim();
      if (t) lines.push((node.role === 'listitem' ? '- ' : '') + t);
      run = [];
    };
    if (node.text && node.role !== 'img') run.push(node.text);
    const childPath = path + '/' + node.role + (node.name ? `"${node.name.slice(0, 40)}"` : '');
    // Mixed content (text with inline links): keep the link text in the sentence too.
    const mixed = node.children.some((c) => typeof c === 'string');
    for (const c of node.children) {
      if (typeof c === 'string') {
        if (!siblingNames.has(c.trim())) run.push(c);
      } else if (mixed && c.role === 'link' && isInteractive(c, node)) {
        run.push(c.name || textOf(c));
        visit(c, node, node === root ? '' : childPath, node.ref ?? parentRef);
      } else {
        flush();
        visit(c, node, node === root ? '' : childPath, node.ref ?? parentRef);
      }
    }
    flush();
  };
  visit(root, null, '', null);
  return { nodes, lines };
}

/** Fresh per-target id state. */
export function newIdState() {
  return { counter: 0, elements: [] };
}

/**
 * Give each node an id like `e12`, reusing the previous id for the same element:
 * 1. same source ref with the same role and name,
 * 2. else same role + name + ancestor path (k-th occurrence matches k-th),
 * 3. else the only leftover of that role under the same parent ref (a renamed button).
 * New elements get fresh ids; ids are never reused for a different element.
 * Mutates `state`; returns elements `{ id, role, name, value, ref, flags, url, placeholder }`.
 */
export function assignIds(state, nodes) {
  const prev = state.elements;
  const used = new Set();
  const ids = new Array(nodes.length).fill(null);
  const take = (i, p) => { ids[i] = p.id; used.add(p.id); };

  const byRef = new Map(prev.filter((p) => p.ref).map((p) => [p.ref, p]));
  nodes.forEach((n, i) => {
    const p = n.ref && byRef.get(n.ref);
    if (p && !used.has(p.id) && p.role === n.role && p.name === n.name) take(i, p);
  });

  const semKey = (x) => `${x.role}|${x.name}|${x.path}`;
  const pool = new Map();
  for (const p of prev) {
    if (used.has(p.id)) continue;
    const k = semKey(p);
    if (!pool.has(k)) pool.set(k, []);
    pool.get(k).push(p);
  }
  nodes.forEach((n, i) => {
    if (ids[i]) return;
    const list = pool.get(semKey(n));
    while (list?.length) {
      const p = list.shift();
      if (!used.has(p.id)) { take(i, p); break; }
    }
  });

  const grpKey = (x) => `${x.parentRef}|${x.role}`;
  const leftPrev = new Map();
  for (const p of prev) {
    if (used.has(p.id) || !p.parentRef) continue;
    const k = grpKey(p);
    leftPrev.set(k, [...(leftPrev.get(k) ?? []), p]);
  }
  const leftNow = new Map();
  nodes.forEach((n, i) => {
    if (ids[i] || !n.parentRef) return;
    const k = grpKey(n);
    leftNow.set(k, [...(leftNow.get(k) ?? []), i]);
  });
  for (const [k, idx] of leftNow) {
    const ps = leftPrev.get(k);
    if (idx.length === 1 && ps?.length === 1) take(idx[0], ps[0]);
  }

  const out = nodes.map((n, i) => {
    const id = ids[i] ?? `e${++state.counter}`;
    return { id, role: n.role, name: n.name, value: n.value, ref: n.ref, flags: n.flags, url: n.url, placeholder: n.placeholder, path: n.path, parentRef: n.parentRef };
  });
  state.elements = out;
  return out.map(({ path, parentRef, ...e }) => e);
}

const q = (s) => JSON.stringify(String(s));

/** One line for an element, e.g. `e7 textbox "Email" = "a@b.c"`. */
export function elementLine(e) {
  let s = `${e.id} ${e.role}`;
  if (e.name) s += ` ${q(clip(e.name, 120))}`;
  if (CHECK_ROLES.has(e.role)) s += ` [${e.value}]`;
  else if (e.value || VALUE_ROLES.has(e.role)) s += ` = ${q(clip(e.value, 200))}`;
  if (e.placeholder && !e.value) s += ` (placeholder ${q(clip(e.placeholder, 60))})`;
  for (const f of e.flags ?? []) s += ` [${f}]`;
  if (e.url && e.role === 'link') s += ` -> ${clip(e.url, 60)}`;
  return s;
}

function clip(s, n) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/** Header lines: title, url, tabs, modal. */
export function headerLines(page) {
  const h = [`page: ${page.title || '(untitled)'}`, `url: ${page.url || '(none)'}`];
  if (page.tabs?.length > 1) {
    const cur = page.tabs.find((t) => t.current);
    h.push(`tabs: ${page.tabs.length} open${cur ? `, this is tab ${cur.index}` : ''}`);
  }
  if (page.modal) h.push(`modal: ${page.modal.replace(/\s+/g, ' ').slice(0, 300)}`);
  return h;
}

/**
 * Render header + interactive elements + page text within maxChars.
 * Drops whole lines from the end of each section and says how many with `… N more`.
 */
export function render(page, elements, lines, maxChars = 6000) {
  const out = [];
  let used = 0;
  const push = (l) => { out.push(l); used += l.length + 1; };
  for (const l of headerLines(page)) push(clip(l, Math.max(20, maxChars)));
  let limit = maxChars;
  const fits = (l, reserve) => used + l.length + 1 + reserve <= limit;
  const MARK = 40; // room for a "… N more" marker

  const sec = (title, items) => {
    if (!items.length) return;
    const head = `-- ${title} (${items.length})`;
    if (!fits(head, MARK)) { push(`… ${items.length} more ${title}`); return; }
    push(head);
    for (let i = 0; i < items.length; i++) {
      const last = i === items.length - 1;
      if (fits(items[i], last ? 0 : MARK)) { push(items[i]); continue; }
      push(`… ${items.length - i} more ${title}`);
      return;
    }
  };
  // Elements come first but may use at most 3/4 of what is left when there is page text,
  // so a link-heavy page still shows some of its text. Unused room goes to the text.
  if (lines.length) limit = used + Math.floor((maxChars - used) * 0.75);
  sec('elements', elements.map(elementLine));
  limit = maxChars;
  sec('text', lines.map((l) => clip(l, 300)));
  let text = out.join('\n');
  if (text.length > maxChars) text = text.slice(0, Math.max(0, maxChars - 1)) + '…';
  return text;
}

/** Stable short hash of the observable state (not refs, not the char budget). */
export function hashState(page, elements, lines) {
  const canon = JSON.stringify({
    url: page.url, title: page.title, modal: page.modal || '',
    el: elements.map((e) => [e.id, e.role, e.name, e.value, (e.flags ?? []).join(','), e.url || '']),
    lines,
  });
  return crypto.createHash('sha1').update(canon).digest('hex').slice(0, 16);
}

/**
 * What changed between two observe() results. Returns `no change` when nothing did.
 * Lines: `url: a -> b`, `title: …`, `+ e9 button "New"`, `- e3 link "Old"`,
 * `~ e7 textbox "Email" = "" -> "a@b.c"`, `+ text: …`, `- text: …`.
 */
export function diff(previous, next, { maxChars = 4000 } = {}) {
  if (!previous) return next?.text ?? 'no change';
  if (previous.hash && previous.hash === next.hash) return 'no change';
  const out = [];
  const pp = previous.page ?? {};
  const np = next.page ?? {};
  if (pp.url !== np.url) out.push(`url: ${pp.url || '(none)'} -> ${np.url || '(none)'}`);
  if (pp.title !== np.title) out.push(`title: ${q(pp.title ?? '')} -> ${q(np.title ?? '')}`);
  if ((pp.modal || '') !== (np.modal || '')) out.push(np.modal ? `modal: ${np.modal.replace(/\s+/g, ' ').slice(0, 300)}` : 'modal: closed');

  const before = new Map((previous.elements ?? []).map((e) => [e.id, e]));
  const after = new Map((next.elements ?? []).map((e) => [e.id, e]));
  for (const e of previous.elements ?? []) if (!after.has(e.id)) out.push(`- ${elementLine(e)}`);
  for (const e of next.elements ?? []) {
    const p = before.get(e.id);
    if (!p) { out.push(`+ ${elementLine(e)}`); continue; }
    const changes = [];
    if (p.role !== e.role) changes.push(`role ${p.role} -> ${e.role}`);
    if (p.name !== e.name) changes.push(`name ${q(p.name)} -> ${q(e.name)}`);
    if (p.value !== e.value) changes.push(`value ${q(p.value)} -> ${q(e.value)}`);
    const pf = (p.flags ?? []).join(' ');
    const nf = (e.flags ?? []).join(' ');
    if (pf !== nf) changes.push(`flags [${pf}] -> [${nf}]`);
    if ((p.url || '') !== (e.url || '')) changes.push(`url ${p.url || '(none)'} -> ${e.url || '(none)'}`);
    if (changes.length) out.push(`~ ${e.id} ${e.role}${e.name ? ' ' + q(clip(e.name, 80)) : ''}: ${changes.join(', ')}`);
  }

  // Text lines as multisets, order-insensitive.
  const count = (arr) => { const m = new Map(); for (const l of arr) m.set(l, (m.get(l) ?? 0) + 1); return m; };
  const pl = count(previous.lines ?? []);
  const nl = count(next.lines ?? []);
  const textOut = [];
  for (const l of previous.lines ?? []) { const n = nl.get(l) ?? 0; if (n > 0) nl.set(l, n - 1); else textOut.push(`- text: ${clip(l, 200)}`); }
  for (const l of next.lines ?? []) { const n = pl.get(l) ?? 0; if (n > 0) pl.set(l, n - 1); else textOut.push(`+ text: ${clip(l, 200)}`); }
  out.push(...textOut);

  if (!out.length) return 'no change';
  let text = '';
  for (let i = 0; i < out.length; i++) {
    const marker = `… ${out.length - i} more changes`;
    if (text.length + out[i].length + 1 + (i === out.length - 1 ? 0 : marker.length + 1) > maxChars) {
      text += (text ? '\n' : '') + marker;
      break;
    }
    text += (text ? '\n' : '') + out[i];
  }
  return text;
}
