# Senju on Ripple

A swarm of computer-use agents for the Mac, running entirely on **Ripple-65B**. You type a goal into a bar at the top of the screen. A lead agent plans it and spawns workers, and each worker drives its own browser window or Mac app with a visible ghost cursor while you keep working.

Ripple is a text-only model trained for terminal work, so the swarm doesn't hand it screenshots and raw tools. A harness turns the screen into text and actions into shell commands, keeps every request inside a token budget, and enforces the important rules in code:

```
goal ─> lead ─> workers ──sh tool──> shell/ ──> guard/ ──> MCP tools (browser, files, Mac apps)
           \        ^                                          |
            \       └────────── eyes/ (screen as text) <───────┘
             └─ every model call ─> guard ─> context/ ─> sched/ ─> adapter/ ─> Ripple endpoint
```

A browser worker reads a page as text (`senju look`, format from `eyes/README.md`):

```
page: Eyes Test Page
url: http://127.0.0.1:49550/
-- elements (7)
e1 textbox "Email" = "" (placeholder "you@example.com")
e2 checkbox "Agree to terms" [unchecked]
e4 button "Submit"
-- text (2)
# Signup
Fill in the form below.
```

and acts by id: `senju type e1 "ada@example.com"`, `senju click e2`, `senju click e4`. A click on a button like "Send" or "Delete" shows an approval card to the person first; if they decline, the worker gets `error: the person did not approve this`.

## Quick start

Requires macOS, Node 20.12+, Google Chrome, and a Vast.ai account: Ripple runs on a B200 you rent there (about $7.50 to $12.50 an hour, billed until you destroy it).

```sh
cp .env.example .env                      # set RIPPLE_API_KEY to any long random string (openssl rand -hex 24)
python3 tools/vast/ripple_b200.py offers          # pick a B200
python3 tools/vast/ripple_b200.py rent <offer>    # starts vLLM with that key; ready in about 7 minutes
python3 tools/vast/ripple_b200.py env <instance>  # writes its address into .env and app/.env
(cd app && npm install && node node_modules/electron/install.js)
(cd eyes && npm install) && (cd evals && npm install)
npm test                                  # unit tests, no key needed
npm run app                               # the desktop app
```

See `tools/vast/README.md` for billing and stopping the B200. `tools/modal/` runs the same server on Modal instead.

## What's here

| Folder | What it does |
|---|---|
| `app/` | The desktop app (overlay, ghost cursors, approval cards, launcher with saved sessions), the swarm engine (lead, workers, shared board, skills), learned skills, and team mode (hub server and web app) |
| `harness/` | Wires everything below into the swarm so every model call goes to Ripple |
| `adapter/` | Ripple client over an OpenAI-style endpoint (tool-call repair hooks, image stripping, retries) |
| `eyes/` | Turns a page into short text with stable element ids (`e12`), and diffs what changed |
| `shell/` | The `senju` command line workers act through: `look`, `click`, `type`, `open`, `find`, `wait`, `done`... |
| `guard/` | Checks every action: asks a person before sends, payments and deletes, stops loops, repairs bad tool calls |
| `context/` | Keeps each conversation inside the endpoint's context limit |
| `sched/` | Limits how many model calls run at once |
| `evals/` | Tasks with automatic checkers (core, hard, multi-agent games, MiniWoB++/WebGames/OpenApps-style), plus an autoresearch loop that improves per-task skills |
| `docs/` | Architecture and contracts (`SPEC.md`), Ripple endpoint notes, a computer-use benchmark survey |
| `tools/` | Serve Ripple on a Vast.ai B200 (or the same server on Modal) |

## Commands

```sh
npm test                                   # all unit tests
npm run app                                # the desktop app
npm run eval -- --model ripple --suite hard  # evals (suites: core, hard, games, benchmarks, all)
npm run demo:serve -- drafts-cleanup       # serve one eval task's pages, print its goal for the app, check on Ctrl+C
npm run watch                              # Ripple workers in visible Chrome windows, no app
npm run smoke                              # live end-to-end check against your endpoint
```

## Safety

Workers act on real apps and websites. `guard/` asks you before anything that sends a message or email, pays, or deletes, whatever the model says. Sign-ins are handed to you; the model never types or asks for passwords. Evals use local test pages, never real accounts. Desktop-app control (through Cua Driver, see `app/README.md`) is optional and needs Accessibility permission.

## Third-party code

`evals/benchmarks/` vendors MiniWoB++ (MIT) and WebGames (Apache-2.0); their licenses are in their folders. The OpenApps-style apps are written from scratch, but reuse task goals from [OpenApps](https://github.com/facebookresearch/OpenApps) (CC BY-NC).

## License

Not yet chosen.
