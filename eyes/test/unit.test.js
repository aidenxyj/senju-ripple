// Unit tests on recorded Playwright MCP output: no browser needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseSnapshot, parseBrowserOutput, parseTabs, extract, assignIds, render, hashState, newIdState, diff,
} from '../index.js';
import { parseNodeLine, unquoteValue } from '../parse.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const BEFORE = fs.readFileSync(path.join(FIX, 'snapshot-before.txt'), 'utf8');
const AFTER = fs.readFileSync(path.join(FIX, 'snapshot-after.txt'), 'utf8');

// What observe() does, minus the MCP call.
function view(state, out, maxChars = 6000) {
  const parsed = parseBrowserOutput(out);
  const page = { url: parsed.url, title: parsed.title, tabs: parsed.tabs, modal: parsed.modal };
  const { nodes, lines } = extract(parseSnapshot(parsed.yaml));
  const elements = assignIds(state, nodes);
  return { text: render(page, elements, lines, maxChars), elements, hash: hashState(page, elements, lines), page, lines };
}

test('parseBrowserOutput reads url, title and yaml', () => {
  const p = parseBrowserOutput(BEFORE);
  assert.equal(p.url, 'http://localhost:4517/');
  assert.equal(p.title, 'Eyes Test Page');
  assert.match(p.yaml, /button "Submit" \[ref=e10\]/);
  assert.equal(p.modal, '');
});

test('parseTabs reads the tab list', () => {
  const tabs = parseTabs('- 0: [Test](http://x/)\n- 1: (current) [A [b]](about:blank)');
  assert.deepEqual(tabs, [
    { index: 0, current: false, title: 'Test', url: 'http://x/' },
    { index: 1, current: true, title: 'A [b]', url: 'about:blank' },
  ]);
});

test('parseNodeLine handles names, attributes, inline text and quoting', () => {
  assert.deepEqual(
    { ...parseNodeLine('checkbox "Agree" [checked] [ref=e8]'), children: undefined },
    { role: 'checkbox', name: 'Agree', ref: 'e8', attrs: { checked: true }, text: undefined, props: {}, children: undefined },
  );
  const h = parseNodeLine('heading "Hi" [level=2] [ref=e2]');
  assert.equal(h.attrs.level, '2');
  const t = parseNodeLine('textbox "Email" [ref=e6]: a@b.c');
  assert.equal(t.text, 'a@b.c');
  // A key with ": " in the name is single-quoted by Playwright.
  const q = parseNodeLine(`'button "Save: it''s done" [ref=e3]'`);
  assert.equal(q.name, "Save: it's done");
  assert.equal(q.ref, 'e3');
  const v = parseNodeLine('generic [ref=e9]: "Price: $5"');
  assert.equal(v.text, 'Price: $5');
  const e = parseNodeLine('link "a \\"b\\"" [ref=f1e2] [cursor=pointer]:');
  assert.equal(e.name, 'a "b"');
  assert.equal(e.ref, 'f1e2');
  assert.equal(e.attrs.cursor, 'pointer');
  assert.equal(unquoteValue('"tab\\there \\x01"'), 'tab\there \x01');
});

test('extract lists interactive elements with values and page text', () => {
  const { nodes, lines } = extract(parseSnapshot(parseBrowserOutput(BEFORE).yaml));
  assert.deepEqual(nodes.map((n) => `${n.role}:${n.name}:${n.value}`), [
    'textbox:Email:', 'checkbox:Agree to terms:unchecked', 'combobox:Plan:Free',
    'button:Submit:', 'button:Play:', 'link:Link A:', 'link:Link B:',
  ]);
  assert.equal(nodes[0].placeholder, 'you@example.com');
  assert.equal(nodes[5].url, '#a');
  assert.deepEqual(lines, ['# Signup', 'Fill in the form below.']);
});

test('observe text: header, elements first, then text', () => {
  const v = view(newIdState(), BEFORE);
  assert.equal(v.text, [
    'page: Eyes Test Page',
    'url: http://localhost:4517/',
    '-- elements (7)',
    'e1 textbox "Email" = "" (placeholder "you@example.com")',
    'e2 checkbox "Agree to terms" [unchecked]',
    'e3 combobox "Plan" = "Free"',
    'e4 button "Submit"',
    'e5 button "Play"',
    'e6 link "Link A" -> #a',
    'e7 link "Link B" -> #b',
    '-- text (2)',
    '# Signup',
    'Fill in the form below.',
  ].join('\n'));
  assert.deepEqual(Object.keys(v.elements[0]).slice(0, 4), ['id', 'role', 'name', 'value']);
  assert.equal(v.elements[0].ref, 'e6');
});

test('ids stay stable across observations; new elements get fresh ids', () => {
  const s = newIdState();
  const a = view(s, BEFORE);
  const b = view(s, AFTER);
  const byName = (v) => Object.fromEntries(v.elements.map((e) => [e.name, e.id]));
  const A = byName(a);
  const B = byName(b);
  for (const n of ['Email', 'Agree to terms', 'Plan', 'Submit', 'Link A']) assert.equal(B[n], A[n], n);
  assert.equal(B['Pause'], A['Play'], 'renamed button keeps its id');
  assert.equal(B['Start over'], 'e8', 'new element gets a fresh id');
  assert.equal(B['Link B'], undefined);
  assert.equal(b.elements.find((e) => e.name === 'Email').value, 'a@b.c');
});

test('ids are never reused for a different element', () => {
  const s = newIdState();
  view(s, BEFORE);
  const b = view(s, AFTER);
  // Back to the original page: Link B returns but must not get e7's old meaning reused elsewhere.
  const c = view(s, BEFORE);
  const ids = c.elements.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(!b.elements.some((e) => e.id === 'e7'));
  assert.equal(c.elements.find((e) => e.name === 'Link B').id, 'e9');
});

test('hash is stable for the same state and changes with it', () => {
  const s = newIdState();
  const a1 = view(s, BEFORE);
  const a2 = view(s, BEFORE);
  assert.equal(a1.hash, a2.hash);
  assert.equal(view(newIdState(), BEFORE, 200).hash, a1.hash, 'maxChars does not affect the hash');
  assert.notEqual(view(s, AFTER).hash, a1.hash);
});

test('diff reports only what changed, or no change', () => {
  const s = newIdState();
  const a = view(s, BEFORE);
  const a2 = view(s, BEFORE);
  assert.equal(diff(a, a2), 'no change');
  const b = view(s, AFTER);
  const d = diff(a, b);
  assert.equal(d, [
    '- e7 link "Link B" -> #b',
    '+ e8 button "Start over"',
    '~ e1 textbox "Email": value "" -> "a@b.c"',
    '~ e2 checkbox "Agree to terms": value "unchecked" -> "checked"',
    '~ e4 button "Submit": flags [] -> [focused]',
    '~ e5 button "Pause": name "Play" -> "Pause"',
    '+ text: Thanks, a@b.c',
  ].join('\n'));
  assert.doesNotMatch(d, /Signup|Link A/);   // Submit appears only because focus moved to it
});

test('diff reports url and title changes and respects maxChars', () => {
  const s = newIdState();
  const a = view(s, BEFORE);
  const b = view(s, AFTER.replace('http://localhost:4517/', 'http://localhost:4517/done').replace('Eyes Test Page', 'Done'));
  const d = diff(a, b);
  assert.match(d, /^url: http:\/\/localhost:4517\/ -> http:\/\/localhost:4517\/done\ntitle: "Eyes Test Page" -> "Done"/);
  const short = diff(a, b, { maxChars: 120 });
  assert.ok(short.length <= 120, short);
  assert.match(short, /… \d+ more changes$/);
});

test('render stays within maxChars and says how much it dropped', () => {
  for (const max of [60, 150, 250, 400]) {
    const t = view(newIdState(), BEFORE, max).text;
    assert.ok(t.length <= max, `${max}: ${t.length}`);
  }
  const t = view(newIdState(), BEFORE, 250).text;
  assert.match(t, /… \d+ more (elements|text)/);
  assert.match(t, /^page: Eyes Test Page\nurl: /);
});

test('big pages: generic clickables, listbox options, modal state', () => {
  const out = [
    '### Page', '- Page URL: http://x/', '- Page Title: X',
    '### Modal state', '- ["alert" dialog with message "Hi"]: can be handled by browser_handle_dialog',
    '### Snapshot', '```yaml',
    '- generic [ref=e1]:',
    '  - generic [ref=e2] [cursor=pointer]: Open menu',
    '  - listbox "Colors" [ref=e3]:',
    '    - option "Red" [selected] [ref=e4]',
    '  - combobox "Size" [ref=e5]',
    '  - img "Logo" [ref=e6]',
    '  - button "Off" [disabled] [ref=e7]',
    '```',
  ].join('\n');
  const v = view(newIdState(), out);
  assert.match(v.text, /modal: .*alert/);
  assert.match(v.text, /e1 generic "Open menu"/);
  assert.match(v.text, /option "Red" \[selected\]/);
  assert.match(v.text, /combobox "Size" = ""/);
  assert.match(v.text, /button "Off" \[disabled\]/);
  assert.match(v.text, /\[img: Logo\]/);
});

test('table rows read as one line with their cell text (names on cells, e.g. dates)', () => {
  const yaml = [
    '- table [ref=e6]:',
    '  - rowgroup [ref=e7]:',
    '    - row [ref=e8]:',
    '      - columnheader "Subject" [ref=e9]',
    '      - columnheader "Last edited" [ref=e10]',
    '      - columnheader [ref=e11]',
    '    - row [ref=e12]:',
    '      - cell [ref=e13]:',
    '        - link "Re: venue for offsite" [ref=e14] [cursor=pointer]:',
    '          - /url: /draft/1',
    '      - cell "2026-08-14" [ref=e15]',
    '      - cell [ref=e16]:',
    '        - button "Delete Re: venue for offsite" [ref=e17] [cursor=pointer]',
  ].join('\n');
  const { nodes, lines } = extract(parseSnapshot(yaml));
  assert.deepEqual(lines, ['| Subject | Last edited |  |', '| Re: venue for offsite | 2026-08-14 | Delete Re: venue for offsite |']);
  assert.deepEqual(nodes.map((n) => [n.role, n.name]), [['link', 'Re: venue for offsite'], ['button', 'Delete Re: venue for offsite']]);
});

test('the focused element is flagged, so keyboard-only controls can be reached with tab', () => {
  const yaml = [
    '- button "Open menu" [ref=e1] [cursor=pointer]',
    '- button "▼ BEGIN DESCENT ▼" [active] [ref=e8] [cursor=pointer]',
  ].join('\n');
  const { nodes } = extract(parseSnapshot(yaml));
  assert.deepEqual(nodes.map((n) => n.flags), [[], ['focused']]);
});
