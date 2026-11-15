// Pure parsers for Playwright MCP output. No browser needed, so these are unit-tested on
// recorded strings.
//
// `browser_snapshot` returns markdown sections ("### Page", "### Snapshot", maybe
// "### Open tabs" and "### Modal state") with the aria tree in a ```yaml block. The tree
// is Playwright's aria snapshot format, one node per line:
//
//   - role "name" [attr] [attr=value] [ref=e12] [cursor=pointer]: inline text
//   - /url: "#a"            (a property of the parent node)
//   - text: some text       (a text child)
//
// A key that needs YAML quoting is wrapped in single quotes ('' escapes a quote); a value
// that needs quoting is a double-quoted string with JSON-style escapes plus \xNN.

/**
 * Split the text of a browser_snapshot (or any Playwright MCP tool) result.
 * @param {string} out
 * @returns {{ url: string, title: string, tabs: Array<{index:number,current:boolean,title:string,url:string}>, modal: string, yaml: string|null }}
 */
export function parseBrowserOutput(out) {
  const text = String(out ?? '');
  const sections = new Map();
  let name = '';
  let buf = [];
  for (const line of text.split('\n')) {
    const m = /^###\s+(.*)$/.exec(line);
    if (m) {
      sections.set(name, (sections.get(name) ?? '') + buf.join('\n'));
      name = m[1].trim().toLowerCase();
      buf = [];
    } else {
      buf.push(line);
    }
  }
  sections.set(name, (sections.get(name) ?? '') + buf.join('\n'));

  const page = sections.get('page') ?? '';
  const url = (/^- Page URL:\s*(.*)$/m.exec(page)?.[1] ?? '').trim();
  const title = (/^- Page Title:\s*(.*)$/m.exec(page)?.[1] ?? '').trim();

  let yaml = null;
  const snap = sections.get('snapshot');
  if (snap !== undefined) {
    const m = /```(?:yaml)?\n([\s\S]*?)```/.exec(snap);
    if (m) yaml = m[1];
  }

  const tabsText = sections.get('open tabs') ?? sections.get('result') ?? '';
  const modal = (sections.get('modal state') ?? '').trim();
  return { url, title, tabs: parseTabs(tabsText), modal, yaml };
}

/** Parse "- 0: (current) [Title](url)" lines from browser_tabs. */
export function parseTabs(text) {
  const tabs = [];
  for (const line of String(text ?? '').split('\n')) {
    const m = /^- (\d+): (\(current\) )?\[(.*)\]\((.*)\)\s*$/.exec(line.trim());
    if (!m) continue;
    tabs.push({ index: Number(m[1]), current: Boolean(m[2]), title: m[3], url: m[4] });
  }
  return tabs;
}

/**
 * Parse Playwright aria-snapshot YAML into a tree.
 * Node: { role, name, ref, attrs: {checked, disabled, expanded, active, level, pressed,
 *         selected, cursor, ...}, text, props: {url, placeholder}, children: [node|string] }
 * A string child is a text node. The returned value is a synthetic root
 * `{ role: 'root', children }`.
 */
export function parseSnapshot(yaml) {
  const root = { role: 'root', name: '', ref: null, attrs: {}, text: undefined, props: {}, children: [] };
  const stack = [{ depth: -1, node: root }];
  for (const raw of String(yaml ?? '').split('\n')) {
    if (!raw.trim()) continue;
    const m = /^( *)- (.*)$/.exec(raw);
    if (!m) continue;
    const depth = m[1].length / 2;
    const body = m[2];
    while (stack.length > 1 && stack[stack.length - 1].depth >= depth) stack.pop();
    const parent = stack[stack.length - 1].node;

    // Property of the parent: "- /url: value"
    const prop = /^\/([a-zA-Z]+):\s?(.*)$/.exec(body);
    if (prop) {
      parent.props[prop[1]] = unquoteValue(prop[2]);
      continue;
    }
    // Text child: "- text: value"
    const txt = /^text:\s?(.*)$/.exec(body);
    if (txt) {
      const t = unquoteValue(txt[1]);
      if (t) parent.children.push(t);
      continue;
    }
    const node = parseNodeLine(body);
    if (!node) continue;
    parent.children.push(node);
    stack.push({ depth, node });
  }
  return root;
}

/** Parse one node line (without the leading "- "). Exported for tests. */
export function parseNodeLine(body) {
  let key;
  let rest;
  if (body.startsWith("'")) {
    // Single-quoted YAML key: '' is an escaped quote.
    let i = 1;
    let out = '';
    while (i < body.length) {
      if (body[i] === "'") {
        if (body[i + 1] === "'") { out += "'"; i += 2; continue; }
        break;
      }
      out += body[i++];
    }
    key = out;
    rest = body.slice(i + 1);
  } else {
    // Unquoted key: it ends at the first ":" that follows the key grammar.
    const end = scanKeyEnd(body);
    key = body.slice(0, end);
    rest = body.slice(end);
  }
  const node = parseKey(key);
  if (!node) return null;
  const v = /^:\s?(.*)$/.exec(rest);
  if (v && v[1] !== '') node.text = unquoteValue(v[1]);
  return node;
}

// Walk role, optional JSON name, then [..] attributes; return the index after the key.
function scanKeyEnd(s) {
  let i = 0;
  while (i < s.length && /[A-Za-z0-9_-]/.test(s[i])) i++;
  for (;;) {
    let j = i;
    while (s[j] === ' ') j++;
    if (s[j] === '"') {
      j = skipJsonString(s, j);
      i = j;
    } else if (s[j] === '[') {
      const close = s.indexOf(']', j);
      if (close < 0) return s.length;
      i = close + 1;
    } else {
      return i;
    }
  }
}

function skipJsonString(s, j) {
  j++;
  while (j < s.length) {
    if (s[j] === '\\') { j += 2; continue; }
    if (s[j] === '"') return j + 1;
    j++;
  }
  return j;
}

function parseKey(key) {
  const rm = /^([A-Za-z0-9_-]+)/.exec(key);
  if (!rm) return null;
  const node = { role: rm[1], name: '', ref: null, attrs: {}, text: undefined, props: {}, children: [] };
  let i = rm[1].length;
  for (;;) {
    while (key[i] === ' ') i++;
    if (i >= key.length) break;
    if (key[i] === '"') {
      const end = skipJsonString(key, i);
      node.name = decodeJsonString(key.slice(i, end));
      i = end;
    } else if (key[i] === '[') {
      const close = key.indexOf(']', i);
      if (close < 0) break;
      const attr = key.slice(i + 1, close);
      const eq = attr.indexOf('=');
      const k = eq < 0 ? attr : attr.slice(0, eq);
      const val = eq < 0 ? true : attr.slice(eq + 1);
      if (k === 'ref') node.ref = val;
      else node.attrs[k] = val;
      i = close + 1;
    } else {
      // A regex name (/.../) or something unexpected: keep it raw as the name.
      const nextAttr = key.indexOf(' [', i);
      node.name = (nextAttr < 0 ? key.slice(i) : key.slice(i, nextAttr)).trim();
      i = nextAttr < 0 ? key.length : nextAttr;
    }
  }
  return node;
}

function decodeJsonString(s) {
  try {
    return JSON.parse(s.replace(/\\x([0-9a-fA-F]{2})/g, '\\u00$1'));
  } catch {
    return s.slice(1, -1);
  }
}

/** Undo Playwright's yamlEscapeValueIfNeeded. */
export function unquoteValue(v) {
  const s = String(v ?? '').trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return decodeJsonString(s);
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  return s;
}
