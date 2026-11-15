# eyes/

Turns a page into short text with stable element ids, so a text-only model can see it.
Today the source is the browser (Playwright MCP `browser_snapshot`). Mac apps (cua-driver)
can be added as a second source in `sources/`.

## API

```js
import { observe, diff, resolve } from '../eyes/index.js';

const a = await observe(conn, target, { maxChars: 6000 });
// a = { text, elements: [{ id, role, name, value, ref, flags, url, placeholder }], hash, page, lines }
// ... act ...
const b = await observe(conn, target, { maxChars: 6000 });
diff(a, b);                       // only what changed, or exactly 'no change'
resolve(conn, target, 'e12');     // { ref, role, name } | null
```

- `conn`: an MCP connection from `app/src/mcp.js` `connectServer()`. The source is picked
  from the server's tools (`browser_snapshot` means browser).
- `target` (browser), which tab to look at:
  - `undefined`, `null`, `''` or `'current'`: the current tab (no extra MCP call).
  - a number, `'2'` or `{ tab: 2 }`: that tab index.
  - any other string: the first tab whose URL or title contains it.
  Picking a tab other than the current one selects it, so later clicks land on it too.
- `maxChars` (default 6000): `text` never goes over it.
- `diff(previous, next, { maxChars = 4000 })`: both arguments are `observe()` results.
- `forget(conn, target)` drops the id state for a target; `forget(conn)` for the connection.
- Each call goes straight to `conn.client` instead of the swarm engine's `callTool`, which cuts text
  at 30k characters and would cut big snapshots in the middle of the tree.

## Text format

```
page: Eyes Test Page
url: http://127.0.0.1:49550/
-- elements (7)
e1 textbox "Email" = "" (placeholder "you@example.com")
e2 checkbox "Agree to terms" [unchecked]
e3 combobox "Plan" = "Free"
e4 button "Submit"
e5 button "Play"
e6 link "Link A" -> #a
e7 link "Link B" -> #b
-- text (2)
# Signup
Fill in the form below.
```

- Header: title, url, then `tabs: N open, this is tab K` if there is more than one tab, and
  `modal: …` while a dialog or file chooser is open.
- Elements first, in page order: links, buttons, textboxes, checkboxes, radios, comboboxes,
  listboxes and their options, menu items, tabs, switches, sliders, spinbuttons, tree items, and
  clickable generic elements (pointer cursor and a short label). Flags such as `[disabled]`,
  `[expanded]` and `[pressed]` come after the name.
- Then page text: headings as `#`, list items as `- `, `[img: alt]`, other text. Link text stays
  inside its sentence.
- When it does not fit, whole lines are dropped from the end of a section with `… N more
  elements` or `… N more text`. When there is page text, elements use at most 3/4 of the space.
- Text only. Images are never emitted.

`diff` lines:

```
url: http://a/ -> http://a/done
title: "Old" -> "New"
- e7 link "Link B" -> #b                         removed
+ e8 button "Start over"                         added
~ e1 textbox "Email": value "" -> "a@b.c"        changed (name, value, flags, url, role)
~ e5 button "Pause": name "Play" -> "Pause"
+ text: Thanks, a@b.c
- text: …
```

## Element ids

An id looks like `e12`. It stays the same for as long as that element stays on the page, and it
is never reused for a different element of the same target. Ids are kept per (connection,
target) and matched, in order, by:

1. the same Playwright ref with the same role and name;
2. the same role, name and ancestor path (the k-th of several identical ones matches the k-th);
3. the only leftover element of that role under the same parent (a button renamed in place,
   such as Play to Pause, keeps its id).

Anything else gets a new id.

Are Playwright's own refs stable? Partly. Playwright keeps a ref on the DOM element, so it
survives later snapshots while that node lives. But it makes a new ref when the element's role or
name changes, when the node is re-created (common in React), and its counter restarts on every
full page load, so after a navigation `e5` can mean a different element. That is why eyes/ keeps
its own ids and maps them to the current ref.

## For shell/: acting on an id

```js
const r = resolve(conn, target, 'e12');          // or: observation.elements.find(e => e.id === 'e12').ref
if (!r) return 'error: no element e12 (run senju look)';
await callTool(conn, 'browser_click',         { target: r.ref, element: r.name });
await callTool(conn, 'browser_type',          { target: r.ref, element: r.name, text: 'hi' });
await callTool(conn, 'browser_select_option', { target: r.ref, element: r.name, values: ['Pro'] });
```

- In `@playwright/mcp` 0.0.85 the argument is `target`, not `ref`.
- `resolve` reflects the last `observe()` of that target. Playwright resolves a ref against its
  latest snapshot of the page, so if the element was re-created since then the call fails with a
  ref error. Then observe again and retry.
- Use the same `target` value for `observe` and `resolve`.

## Tests

```sh
cd app && npm install --omit=dev    # once: @playwright/mcp and the MCP SDK
cd ../eyes && npm test                    # node --test test/*.test.js
```

- `test/unit.test.js`: parser, ids, render, hash and diff on recorded snapshots
  (`test/fixtures/snapshot-*.txt`). No browser needed.
- `test/integration.test.js`: serves `test/fixtures/form.html` with `node:http`, starts a fresh
  `--isolated --headless` browser through the swarm engine's `connectServer`, observes, types and
  clicks through `resolve`, and checks ids and the diff. It skips if `app/node_modules` or
  Chrome is missing. It runs the browser in a temp folder so `.playwright-mcp/` stays out of the
  repo.

## Files

- `index.js`: `observe`, `diff`, `resolve`, `forget`, and the source list.
- `sources/browser.js`: Playwright MCP source (targets, tab selection, snapshot call).
- `parse.js`: pure parsers for `browser_snapshot` output and the aria YAML.
- `view.js`: pure core (elements and text, id matching, render, hash, diff).

To add a source (for example cua-driver), export `name`, `matches(conn)`, `targetKey(target)`
and `snapshot(conn, target) -> { page: { url, title, tabs, modal }, tree }` with the tree in the
shape `parseSnapshot` returns, and add it to `SOURCES` in `index.js`.
