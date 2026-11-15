# shell/

The `senju` command line that workers act through. Contract: `docs/SPEC.md`, "shell/".

Workers get one tool, `sh { cmd }`. Each line of `cmd` is one `senju <verb> [args]` command. Lines run in order and stop at the first error. Output is plain text, and its first line is `ok` or `error: <why>`.

```
senju look [--page N] [--full]       what is on screen now (eyes/ text, ids like e12); --page 2 is the next part
senju find "words"                   search the whole page (and icons look misses) for the best 8 matches
senju click <id or "label">   by id, or by visible label: exact, then unique prefix, then unique substring
senju type <id> "text" [--submit]    replaces the field's text; --submit presses Enter after
senju select <id> "option"           pick an option in a dropdown
senju key <combo>                    enter, tab, esc, cmd+a, cmd+s, shift+tab ...
senju open <url, /path or app>       URLs go to the browser (/path stays on the current site); apps need the openApp hook
senju back
senju board post "note" | senju board read
senju wait <worker>                  block until that worker reports
senju wait <duration>                pause: 2s, 500ms, 1m (at most 30s)
senju ask "question"
senju done "report"
senju help
```

After `click`, `type`, `select`, `key`, `open` and `back`, the output also shows what changed on screen (eyes/ `diff`). When the URL changed, it shows `url: old -> new` and then the new page as `look` would, instead of a diff that lists every element of the old page as removed. So the model sees the effect of each action without another `look`:

```
$ senju type e1 "Ada"
ok
~ e1 textbox "Name": value "" -> "Ada"

$ senju click e2
ok
+ text: Hi Ada
```

## Finding things on big pages

`senju look` is cut at 6000 characters, so on a big page (Amazon is about 34k) the link a worker needs is often not shown. When a look is cut, it ends with a pointer to the next two commands.

**`senju find "words"`** (`find.js`) takes a fresh look, so ids are current, and ranks every element against the words:

- Fields, by weight: name 1, placeholder 0.9, link URL 0.8 (path and query; the host only when it is another site), value 0.7, the text around it 0.5, the heading above it 0.3. Each query word scores its best field: 1 for the same word, 0.75 for a prefix, 0.6 for one typo (in words of 5 letters or more) or a word inside a longer one, 0.55 for a synonym (cart and basket, login and sign in, delete and trash). Words are lowercased, split on camelCase and punctuation, and lightly stemmed.
- Bonuses: the whole query is the name (+0.35) or inside it (+0.25), and the role named in the query ("the search box", "login button") (+0.15). Words such as "click", "the" and "button" do not need to match.
- "The text around it" comes from the page tree (one more `browser_snapshot`): the smallest block around the element that says more than the element itself, such as its table row or card. A block that holds more than two controls of the same role is a list, so it stops below that. This is what tells five "Delete" buttons apart.
- Unnamed elements, such as image links, are found by their URL.
- Icons and menu items that are not in the accessibility tree at all are also found, for example an empty `<span>` with a CSS image and a click handler (MiniWoB's trash, reply and more icons). One `browser_evaluate` (`ICON_SCAN`) lists them with a unique CSS selector, which `browser_click` accepts as its target. They get ids like `i3`, which last until the next find or page load. Clicking one hovers it first, because such icons often swap their image on hover and the click would otherwise land while the new image loads.
- Output: one header line, at most 8 element lines as `look` prints them, with `(in: …)` or `(under: …)`, and up to 2 lines of page text that have every word. Results under 65% of the best score are left out, so near misses only show when nothing matches exactly. Names are cut at 80 characters and long tracking queries (`?ref_=...`) at `?…`. When nothing matches, it says so and suggests close words from the page.
- Entries of a closed menu (`display: none` until its button is clicked: MiniWoB's "Embed Tweet" behind "more", a "..." menu) are listed too, as `iN menu item "Embed Tweet" [in a closed menu: click i12 first]`. The scan names the opener: the first visible element near the menu with `aria-haspopup`/`aria-expanded`, a class such as more, menu, toggle or dropdown, or else an icon. They rank at 0.85x, and an entry with the same name as a visible element is dropped. Clicking one while its menu is still closed returns an error that names the opener, instead of waiting for Playwright's timeout.
- For guard, find is a read-only verb with no arguments, so words like "trash" or "mail" never raise a confirm card. Its result repeats the query, so guard still catches the same find repeated in a loop.

**`senju look --page N`** renders the same view cut the same way, starting where part N-1 stopped (elements and text continue separately). Part 1 is a plain `look`.

**`senju open /path`** opens a path on the current site, for a path the worker has seen in a link (`-> /messenger?with=Bob`). The guidance tells workers never to make up an address; when unsure, search first.

`skills/finding-links/SKILL.md` is the same guidance written as a skill, in the format of the app's learned skills.

## API

```js
import { createShell, shellConnection, SH_TOOL } from '../shell/index.js';

const shell = createShell({
  conn,                  // Playwright MCP connection (app/src/mcp.js connectServer), or null
  agent: { id, name },   // for guard
  guard,                 // { check, record }; default: guard/'s shared guard
  hooks: {               // each is optional; a command whose hook is missing says it is not available
    boardPost(note), boardRead(),        // -> string or [{ from, note }]
    wait(workerName), ask(question),     // -> string
    done(report),                        // -> optional string shown to the model
    confirm(card),                       // -> true to run a send/pay/delete, false to refuse
    openApp(name),                       // for senju open <app>
    pointAt(point),                      // before click/type/select: where the element is (see below)
  },
  target,                // which tab eyes/ reads (default: current)
  maxChars: 6000,        // size of a look; --full is 4x
});
await shell.run('senju look');          // -> 'ok\npage: ...'
shell.finished;                         // the report from senju done, or null
```

**pointAt (ghost cursors).** If `hooks.pointAt` is set, click, type and select first measure the element in the page (one `browser_evaluate`, which also scrolls it into view as the click would) and call it with:

```js
{ verb: 'click', id: 'e13', role: 'button', name: 'Send',
  x: 480, y: 417,               // centre of the element in px from the top-left of the browser window (tab and address bars included)
  screenX: 502, screenY: 472,   // the same point on the screen
  windowW: 1200, windowH: 843 } // the window's outer size, to map x/y onto a window rect you track
```

The action waits for the hook's promise (at most 2 s), so an app can move a ghost cursor onto the element and resolve when it arrives. A hook that throws, a failed measurement or a hook that never answers does not stop the action. Without the hook nothing is measured, so evals pay nothing. Checked on a visible Chrome window on macOS: the point lands on the element's centre.

**guard.** Every line goes through `guard.check(agent, { verb, args, element })` before it runs, and its output goes to `guard.record`. For click, type and select, `element` is `{ role, name }` from `eyes.resolve`, so a click on a "Send" button becomes a confirm card. If `hooks.confirm` returns true, the command runs. Otherwise the model gets `error: the person did not approve this`, and without a `confirm` hook it gets `error: this needs a person's approval`. A loop (the same command with the same result three times) is denied.

**Swarm.** `shellConnection(shell, { name: 'senju', conn })` wraps a shell as an MCP-like connection with one tool, `sh`. The harness can return it from the Swarm's `connect` override, which lets workers act through `senju__sh` instead of the raw browser tools.

## Tests

`node shell/test.mjs` has two parts. The parsing, hooks, errors, loops and find-ranking tests need nothing. The real headless-browser tests use the swarm engine's Playwright MCP: open a page, look, type, select, click, approve or decline a Send, and use key and back. A 360-link page checks that find reaches a target past the cut of look, finds an unnamed link by its URL, and finds and clicks an icon-only control. They are skipped if `prototype/` has no `npm install`.
