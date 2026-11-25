# Senju: architecture

This describes what Senju is and the contracts between its folders.

## What it is

Senju is a swarm of computer-use agents for the Mac. You type a goal, a lead agent plans it, and several workers each drive a browser window or a Mac app with their own visible cursor while you keep working. Every agent runs on whatever model you point it at: any OpenAI-compatible chat completions endpoint, hosted or self-run.

## Why it needs a harness

The harness assumes as little as possible about the model, so a small open model and a frontier API both work:

| Assumption it avoids | What the harness does instead |
|---|---|
| The model can see | `eyes/` turns screens into short text with stable element ids (vision models can get images too, with `LLM_VISION=1`) |
| The model is good with many raw tools | Workers act through one `sh` tool running `senju` commands (`shell/`) |
| The endpoint has a big context window | `context/` fits every request to a token budget |
| The model follows written rules reliably | `guard/` enforces the important rules in code |

## The parts

```
goal ─> lead ─> workers ──sh tool──> shell/ ──> guard/ ──> MCP tools (browser, files, Mac apps)
           \        ^                                          |
            \       └────────── eyes/ (screen as text) <───────┘
             └─ every model call ─> context/ ─> sched/ ─> adapter/ ─> your model endpoint
```

| Folder | What it does |
|---|---|
| `app/` | The desktop app (overlay, cursors, approval cards) and the swarm engine (`app/src/orchestrator.js`: lead, workers, board, skills). `main.js` runs the swarm on the configured model through `src/llm.js` (which wraps `adapter/`), with visible-cursor handling for popups, ads, on-screen keys and desktop apps. Also a launcher with saved sessions, and team mode (`server/`, `web/`, see `app/MULTIPLAYER.md`). `harness/` builds the same engine with the `senju` shell for evals. |
| `adapter/` | Speaks to any OpenAI-compatible endpoint, in the Messages-style shape the swarm engine expects. |
| `eyes/` | Turns a page or app window into short text with stable element IDs. |
| `shell/` | The `senju` command line that workers act through. |
| `guard/` | Checks every action before it runs. Repairs bad calls, stops loops, asks before sends. |
| `context/` | Keeps each conversation inside the endpoint's context limit. |
| `sched/` | Limits how many model calls run at once. |
| `harness/` | Wires the parts above into the swarm engine's `Swarm`. |
| `evals/` | Fixed tasks with automatic checkers, run on any model, plus the autoresearch loop. |
| `docs/` | This file, notes on OpenAI-style endpoints and a computer-use benchmark survey. |
| `tools/` | Optional scripts to serve an open model with vLLM on a rented GPU (Modal or Vast). |

## Contracts

These are the shapes other folders rely on.

### adapter/

```js
makeLlm({ baseUrl, apiKey, model, maxContext, vision }) -> { create(params, { signal }) }
llmFromEnv(env) -> the same, from LLM_* settings
```

`create` takes and returns the Messages-style shapes the swarm engine speaks, so the orchestrator needs no changes:

- **In:** `{ model, max_tokens, system, messages, tools }`. Messages hold `text`, `tool_use { id, name, input }` and `tool_result { tool_use_id, content, is_error }` blocks. Tools are `{ name, description, input_schema }`.
- **Out:** `{ content: [text | tool_use blocks], stop_reason, usage: { input_tokens, output_tokens } }` with `stop_reason` one of `end_turn`, `tool_use`, `max_tokens`, `model_context_window_exceeded`.
- Drops vendor-specific fields (`betas`, `context_management`, `cache_control`, `thinking`).
- Replaces any image in a tool result with the text `[image omitted]`, unless `vision` is on: then images follow as `image_url` parts.
- Sends no `authorization` header when there is no key (local servers).
- Switches to `max_completion_tokens` for endpoints that refuse `max_tokens`.
- Strips the model's reasoning from what it returns.
- Rejects with an error when `signal` aborts.
- Tool arguments that are not valid JSON come back as `tool_use` with `input: { _raw: "<the string>" }`, for `guard.repair` to fix.
- Sends no `provider` routing unless given one (see `docs/model-notes.md`).

### eyes/

```js
observe(conn, target, { maxChars }) -> { text, elements: [{ id, role, name, value }], hash }
diff(previous, next) -> text
```

- `conn` is an MCP connection from `app/src/mcp.js`. `target` names the page or window.
- An element's `id` looks like `e12` and stays the same for as long as that element stays on screen.
- `text` lists interactive elements first and fits in `maxChars`.
- `diff` returns only what changed, or `no change`.

### shell/

Workers get one tool, `sh`, with input `{ cmd }`. Each line of `cmd` is one command:

```
senju look [--full]          what is on screen now (from eyes/)
senju click <id or "label">   by id (e12) or visible label ("Row 5, column 6")
senju type <id> "text" [--submit]
senju select <id> "option"   pick from a dropdown
senju key <combo>            for example: cmd+s
senju open <url or app>
senju back                   previous page
senju board post "note"      shared notes between workers
senju board read
senju wait <worker>          block until that worker reports
senju wait <duration>        pause, for example 2s or 500ms (at most 30s)
senju ask "question"         hand off to the person
senju done "report"          finish this subtask
senju help                   list the commands
```

- Output is plain text. The first line is `ok` or `error: <why>`.
- Every command goes through `guard.check` before it runs.
- New commands are fine. Keep the grammar `senju <verb> [args]` and add them to this list.
- Lines run in order and stop at the first error. After an action, the output also shows what changed on screen (eyes/ `diff`).
- `createShell({ conn, agent, guard, hooks })` -> `{ run(cmd) }`. `hooks` connect board, wait, ask, done, confirm and openApp to the swarm. `shellConnection(shell)` wraps it as an MCP-like connection with one `sh` tool, for the Swarm's `connect` override. Details: `shell/README.md`.

### guard/

```js
check(agent, action) -> { allow: true } | { deny: true, reason } | { confirm: true, card }
record(agent, action, result)          // after the action runs, so check can see loops
repair(call, schema) -> { call } | { error }
guardLlm(llm, opts) -> llm             // wraps a model client: repairs tool calls, enforces turn rules
```

- `confirm` means a person must click before it runs. Anything that sends a message or email, submits a payment, or deletes something is `confirm`, whatever the model says. `card` is `{ kind: 'send'|'pay'|'delete', title, detail, agent, action }`.
- The same action with the same result three times in a row is a loop: `deny` with a reason that tells the model to try something else.
- `action` is a `senju` line, a parsed `{ verb, args, element }` (shell/ passes `element: { role, name }` from eyes/ so a click on "Send" is caught), or a tool call `{ name, input }`.
- `guardLlm` sits between the Swarm and the model client. It asks the model again (at most twice per reply) when a tool call cannot be repaired, when a lead ends its turn before any `spawn_agent`, or when a worker finishes without posting to the board. Details: `guard/README.md`.

### context/

```js
fit(messages, { maxTokens, system?, tools? }) -> messages   // system and tools count against the budget
countTokens(text) -> number
```

- `fit` never drops the system prompt, the goal, or the newest turn. It trims old observations first, then summarises.
- Must work at 16,000 tokens, not only at 1M.

### sched/

```js
limit(n) -> (fn) => Promise     // at most n of these run at once
```

### evals/

```js
// evals/tasks/<id>.js
export default { id, goal, setup(), check() -> { pass, detail } }
```

```sh
npm run eval -- --model llm
```

Each run writes `evals/results/<run>.json` with one row per task: `{ task, model, pass, steps, tokens, seconds, invalidCalls }`. Tasks use local test pages and a scratch folder, never real accounts.

## Settings

Put these in a `.env` file in the repo root (copy `.env.example`). It is git-ignored. Never commit a key. The desktop app can also save them from its model settings form.

```
LLM_BASE_URL=          # the base URL of any OpenAI-compatible endpoint (usually ends in /v1)
LLM_MODEL=             # the model name that endpoint expects
LLM_API_KEY=           # optional for local servers
LLM_MAX_CONTEXT=       # optional: the endpoint's context limit, so oversized requests fail fast
LLM_VISION=            # optional: 1 sends images in tool results to the model
```

## Conventions

- JavaScript, ES modules, Node 20 or newer.
- Text first: the harness never depends on images. Send them only when `LLM_VISION` is on.
- No real accounts in tests or evals.

## Running the app

```sh
cd app && npm install      # the app, the swarm engine and its MCP servers
npm start                 # reads LLM_* from .env, or the settings saved in the app
npm run demo              # scripted agents, no key, to check the overlay
```

To try a task in the app: `npm run demo:serve -- drafts-cleanup` (from the repo root) serves the task's local pages and prints the goal to paste into the bar. Ctrl+C checks the result. Any eval task id works, for example minesweeper-swarm, bomb-defusal or web-form.

Approvals (send, pay, delete) appear as cards on the overlay. Approving or declining goes back to the worker.

## Open questions

- Whether plain function calling or the `senju` shell works better. `evals/` decides.
- How fast the endpoint is with four or more workers calling at once.
