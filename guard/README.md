# guard/

Checks every action before it runs, and keeps Ripple's replies inside the rules that matter. Contract: `docs/SPEC.md`, "guard/".

```js
import { check, record, repair, guardLlm, createGuard } from '../guard/index.js';
```

| Function | What it does |
|---|---|
| `check(agent, action)` | `{ allow: true }`, `{ deny: true, reason }` or `{ confirm: true, card }`. Run it before every action. |
| `record(agent, action, result)` | Run it after every action, so `check` can spot loops. |
| `repair(call, schema)` | `{ call }` with fixed arguments, or `{ error }` written for the model to read. |
| `guardLlm(llm, opts)` | Wraps a model client (`{ create }`). Repairs every tool call and enforces the turn rules below. |
| `createGuard()` | A separate `check`/`record` state, for example one per swarm run. The bare `check`/`record` share one. |

`npm test` (from the repo root) or `node guard/test.mjs`.

## check

**Confirm, whatever the model says.** These need a person to click first:

- **Send.** Clicking a button or link named Send, Post, Tweet or Publish. Keys `cmd+enter`, `ctrl+enter` and `cmd+shift+d` (Mail). Tools whose name says send, post, reply, forward, message, email and so on. Shell `mail`/`sendmail`.
- **Pay.** Pay, purchase, buy, checkout, place order, donate, transfer and similar.
- **Delete.** Delete, remove, trash, discard, erase and similar. `cmd+backspace`. Shell `rm`, `rmdir`, `git clean`, `git reset --hard`, `drop table`.

**Unnamed buttons and Enter (real sites).** Icon-only buttons (a Send arrow, a trash can) have no accessible name, so the name rules above never see them. For a click on an element whose name is empty or only symbols, and for `type --submit` and `key enter`, shell/ reads hints from the page with one `browser_evaluate`: aria-label, title, data-testid, class and icon names, whether a nearby composer has text typed (`drafted`), whether a close ancestor mentions delete or trash (`deleteNear`), and the page path and title. Then:
- Unnamed click: icon hints such as `icon-send`, `PaperPlane`, `trash-can` or `bin` decide. Otherwise it fails closed: in a composer with text typed it is a **send**, next to delete it is a **delete**, and anything else is allowed (a star, a menu).
- `type --submit` or Enter: a **send** when the field is for a message (Message, Reply, Comment, Write a ..., What's happening), multiline, or on a messages page (messenger, chat, inbox, mail, dm). Search boxes are never a send. A login or title field elsewhere is allowed.
- The card names the element by its hints, e.g. `senju click e6 on an unnamed button (svg) in a message box with text typed`.

The card is `{ kind: 'send'|'pay'|'delete', title, detail, agent, action }`, for example `Research wants to send a message` / `senju click e5 on "Send"`.

Reading, looking and coordinating are never confirmed: `look`, `board`, `wait`, `ask`, `done`, `open`, and read/list/snapshot tools. "Reply" or "Messages" only open a view, so they are not treated as sends. A click is judged by the element's name, so **shell/ should pass `element: { role, name }` from eyes/** with each click. A bare `senju click e5` has nothing to judge.

**Deny loops.** When an agent's last three recorded actions were this same action with the same result (ignoring whitespace), the fourth is denied with a reason that tells it to try something else. It counts per agent. A different action in between, or a changing result, resets it.

An `action` can be:

- a shell line: `"senju click e12"`
- a parsed command: `{ verb: 'click', args: ['e12'], element: { role, name } }`
- a tool call: `{ name: 'browser__browser_click', input: {...} }`
- `{ name: 'sh', input: { cmd } }` with several lines, where the strictest verdict wins

## repair

adapter/ passes arguments that are not valid JSON as `input: { _raw }`. `repair` fixes:

- code fences, and prose before or after the object
- trailing commas, single quotes, smart quotes and unquoted keys
- Python `True`/`False`/`None`
- missing closing quotes or braces

The fixes leave string contents alone. A tool with one string argument (`sh { cmd }`) that got a bare value (`senju look`) gets it wrapped as `{ cmd: "senju look" }`.

`repair` then checks against `input_schema` and coerces what is safe to coerce:

- `"3"` becomes `3`, and `"true"` becomes `true`
- `"Left"` becomes the enum value `"left"`
- a single value becomes a one-item array, and a JSON-string array is parsed
- `null` for an optional key is dropped

Anything else is an `{ error }` that shows the expected shape, such as `missing "content". Send a JSON object like {"path":"...","content":"..."}`.

## guardLlm: turn rules

```js
const llm = guardLlm(makeRippleLlm({...}), { maxRetries: 2, leadMustSpawn: true, workerMustAct: true, workerMustPost: true, onEvent });
```

Every reply goes through these steps before the Swarm sees it:

1. **Repair.** Each tool call is repaired against its tool's schema, and a bare tool name such as `read_file` becomes `files__read_file` when only one tool matches. When a call can't be fixed, or names a tool that does not exist, the model is asked again. The retry carries an error `tool_result` for every call in that reply.
2. **Lead must delegate.** A lead that ends its turn before it has ever called `spawn_agent` is asked again to start workers (seen in early runs: the lead answered "HELLO WORLD" itself).
3. **Worker acts before done.** A reply without a tool call ends a worker's subtask. A worker that finishes before it has done any work (only board, wait or message calls so far, or `senju board`/`done`/`wait` lines) is asked to start with the goal's first tool call. Seen live: a worker's first reply was "I'll post the result first, then finish.", so it ended in 4 s with nothing done. A worker that replies with only a short announcement of its next step ("I'll click =", "Let me look…", a line ending in ":") and no tool call is asked to make that call.
4. **Worker posts before done.** A worker that finishes (no tool calls, or `senju done`) without ever posting to the board is asked to post first.

At most `maxRetries` extra calls per reply. After that, the last reply goes through as it is. `usage` is summed over every call made. `onEvent` receives `{ type: 'nudge', rule }` and `{ type: 'repair-failed', errors }`.
