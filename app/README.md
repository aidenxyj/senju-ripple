# Senju 千手

> Senju on any model: an OpenAI-compatible endpoint you choose, through the repo's `adapter/`. Every action is visible: popups, cookie banners and YouTube ads are closed with the cursor; on-screen keyboards are clicked key by key (Wordle, calculators); desktop apps are brought on screen when opened; "find a website" clicks the result and leaves it open; scripted page clicks are blocked. `skills/` holds learned skills (Wordle, Minesweeper, price hunt, Google lookup and others); the app rewrites them after each job. The model is set in the app's model settings form, or with `LLM_*` in `.env`. The harness is text first: images in tool results reach the model as `[image omitted]` unless `LLM_VISION=1`, so the desktop server works from the accessibility tree, not screenshots.

A prompt bar at the top of your screen. Type a goal, and a swarm of agents splits it up and works on it in parallel through MCP servers. Each agent has a ghost cursor that parks on the window of the app it is working in. Your real mouse and keyboard stay yours.

## Run it

```bash
npm install
cp ../.env .env           # optional: the repo-root .env with LLM_*; otherwise the app asks for the model on first run
npm start
```

Try `npm run demo` first. It uses scripted fake agents, needs no API key, and lets you check the overlay, cursors, idle state and dismiss.

## Using it

- Type a goal in the bar and press Enter. A lead agent plans, spawns workers, and their cursors fly out.
- Keep using your computer. The overlay passes clicks through everywhere except its own bar, chips and cards.
- **Windows are tiled.** Each browser worker opens its own Chrome window in its own slot below the bar.
- **When a worker needs you** (sign-in, 2FA, a decision, confirming something irreversible), your Mac beeps, its cursor pulses "needs you", and a card appears on top of that worker's window. Several workers can ask at once; each card sits on its own window. Click Done or an option, or type a reply in the card. Cards sit along the bottom of the window; drag one by its header or press Hide if it covers something you need.
- **Chat mid-job.** The bar talks to the lead by default: ask for progress or change the plan. Click a worker's chip to talk to that worker instead; click it again to go back to the lead. Replies show in a thread under the chips.
- When the job finishes, a summary appears, the cursors rest under the bar, and the bar waits for the next prompt.
- **Stop** cancels the current job.
- **Hide** or Esc hides the bar and cursors. A running job keeps going, and the overlay comes back by itself when an agent needs you or the job finishes. Set `"dismissCancels": true` in `swarm.config.json` if you want hiding to also stop the job.
- **`Cmd+Shift+Space` shows and hides it from anywhere.** Change it with `"hotkey"` in `swarm.config.json` (for example `"Alt+Space"`). If another app owns the key, the app picks a free one and tells you which. The key is shown in the bar's placeholder and in the ◎ menu, which also has Show, Hide, Stop and Quit.

## How it works

- `src/orchestrator.js` holds the swarm and all the agent prompts.
  - **Lead agent.** A long-running model loop with `spawn_agent`, `wait`, `message_agent`, `stop_agent` and `ask_user`. It spawns workers, waits for events (a worker finished or failed, a worker flagged something, you wrote to it), and replans: adds workers, redirects them, or stops them.
  - **Workers.** One model tool loop each, acting through MCP tools. They also have `handoff` and `ask_user` (bring you in), `wait_for` (block on another worker's result), `tell_lead` (flag something that changes the plan), and a shared board.
  - **Dependencies.** A worker that depends on others starts right away, does its own setup such as sign-in, then calls `wait_for` and receives their final reports. A wait that would deadlock is refused.
  - **Board.** `board_post` pushes a note to every other working agent on its next step, so partial results spread without going through the lead.
- `src/skills.js`: stores and loads the skills the lead writes after each job.
- `src/mcp.js`: connects to MCP servers and exposes their tools to the model.
- `src/windows.js`: finds app windows so each ghost cursor and card can sit on the right one.
- `src/main.js` and `renderer/`: the transparent overlay.

## Building the download

`npm start` runs the app from this folder. To make an installable Mac app:

```bash
npm install
npm run release
```

This builds `dist/Senju-arm64.dmg` (Apple silicon) and `dist/Senju-x64.dmg` (Intel), then prints the command that publishes them as a GitHub Release on the website's repository. The download buttons on the site point at the latest release, so a new release needs no change to the site. `npm run dist` only builds. It must run on a Mac.

What changes in the installed app:

- **Nothing else to install.** The browser and files tool servers ship inside the app and run on its own runtime, so Node is not needed. Browser agents still need Google Chrome.
- **Settings live in the app's data folder**, not this project: `swarm.config.json`, traces and skills are under `~/Library/Application Support/Senju/`. The ◎ menu has "Open settings folder".
- **The API key is asked for in the bar** the first time you run a job, and stored encrypted with the Mac's keychain.

**Signing.** The build is ad-hoc signed, not notarized. On another person's Mac, the first launch is blocked until they choose Open Anyway under System Settings > Privacy & Security. To remove that step you need an Apple Developer ID: set `mac.identity` and notarization in the `build` section of `package.json`.

## Team mode

Several people can share one session across their computers: an agent can work on your Mac and a teammate's, its cursor shows on whichever screen it is called to, and everyone can talk to the lead. Each time the app opens it asks how you want to work: **On this Mac** (no account, your own API key) or **With my team** (sign in). You can switch from the menu bar icon whenever no job is running. To skip the question, set `"mode": "local"` or `"mode": "team"` in `swarm.config.json`. Team mode needs a small server and a Supabase project. See [MULTIPLAYER.md](MULTIPLAYER.md).

## Working together

**You and the agents**

- **Tasks for you, anywhere.** An agent can ask you to do something outside its own window with `user_task`: type something into another app, pick a file, plug in a device, anything physical. The card says what to do, where, and what to type back (for example a port name). It waits as long as you need, then checks the result itself when it can.
- **Take over a window.** Click a worker's chip, then **Pause**. The worker stops before its next action and its window is yours. **Resume** hands it back, and the worker re-reads the window before acting. **Stop** ends just that worker and tells the lead not to restart it.
- **Agents wait while you type.** A desktop action is held while you are typing or clicking and goes ahead about two seconds after you pause (`"typingPause"` seconds in `swarm.config.json`; it gives up waiting after `"typingWaitMax"`, default 120). Reading the screen never waits.

**Agents with each other**

- **Direct messages.** `tell_agent` sends a result, question or warning straight to another worker, and wakes it if it is waiting.
- **Claims.** A worker claims a shared thing (a window, a document, a file) before changing it, so two workers never edit it at once. Claims are released when the worker finishes.
- **Board, dependencies, lead.** Posts to the board reach everyone, `wait_for` blocks on another worker's result, and `tell_lead` asks for a change of plan.

## Desktop apps

Workers can drive your own Mac apps (Cursor, Word, Slack, Discord and others), already signed in as you, through the `desktop` server in `swarm.config.json`. It uses [Cua Driver](https://github.com/trycua/cua), an open-source (MIT) background computer-use driver: it reads a window's accessibility tree and screenshot and delivers clicks and keys to that one app without moving your pointer, where the app allows it.

**Set it up once** (this installs third-party software that gets Accessibility and Screen Recording rights, so read its page first):

```bash
/bin/bash -c "$(curl -fsSL https://cua.ai/driver/install.sh)"
open -n -g -a CuaDriver --args serve
cua-driver permissions grant
npm run doctor
```

`npm run doctor` starts every configured server, lists its tools, checks that windows can be seen and arranged, and writes `traces/doctor.json`. Until the driver is installed, the app says so once and works with the browser and files servers only.

**How it behaves**

- **One app per worker.** The lead gives each desktop worker its own app, and desktop calls run one at a time across workers, since they share one keyboard.
- **Windows are arranged.** The first time a worker uses an app, that app's window is moved into the worker's slot so nothing overlaps, and put back when the job ends (`"restoreWindows": false` to leave them). The desktop driver moves the windows, using the permission you already gave it. Without the driver, this falls back to System Events, which needs the app you start Senju from allowed under Privacy & Security > Accessibility.
- **One cursor.** Cua Driver draws its own agent cursor; Senju hides it so only Senju's ghost cursors show. Senju runs its calls in a driver session of its own, so other tools that use Cua Driver keep their cursor. Set `"driverCursor": true` on the `desktop` server to show it anyway.
- **Focus.** Workers act in the background where they can. For an app that ignores background input, a worker may bring it to the front for a single action, and never while you are typing.
- **Messaging and mail.** Workers may read and draft. Every send needs your click on a card that shows the exact text and recipient. Note that Discord's terms prohibit automating a user account.
- **Off limits unless you name them.** Terminal, System Settings, password managers, and banking apps.

These rules are instructions to the model, not enforcement. Cua Driver has its own permission modes if you want hard limits on which apps it may touch.

To use a different desktop server, change `command` and `args` under `desktop`. Keep `"kind": "desktop"` (adds the rules above), `"serial": true` and `"tile": "window"`.

## Skills (self-improvement)

After every finished job that used workers, the lead runs a short retrospective in the background and writes what the swarm learned into a skill: a markdown file in `skills/`.

- **What goes in.** Each worker ends its report with a "Lessons" section (the method that worked, dead ends, what it needed from you). The lead turns those into instructions for a future agent: the plan shape, the per-site method with exact tool usage, pitfalls, and when to ask you to sign in. It is told to record methods only, never passwords, codes, personal details, or the content of your work.
- **How it is used.** At the start of each job the lead sees the list of skills, reads the ones that fit, and attaches them to the workers that need them.
- **How it improves.** If a skill already covers the same ground, the lead reads it and saves a merged, corrected version. The old version is kept in `skills/.history/`.
- **You are in control.** Skills are plain files. Read them, edit them, or delete them. A toast tells you whenever one is created or improved. Set `"skills": false` in `swarm.config.json` to turn this off.

## Long-running jobs

Jobs can run for hours. These are set under `context`, `maxSteps` and `tokenBudget` in `swarm.config.json`:

- **Long context.** The default model has a 1M-token window, so agents keep a lot of history verbatim.
- **Tool-result clearing** (`clearToolResultsAt`, default 200k tokens). Past that size, the API drops old tool results such as page snapshots, keeping the newest `keepToolResults` (default 10).
- **Compaction** (`compactAt`, default 500k tokens, minimum 50k). Past that size, the API replaces the agent's history with a summary written to preserve its task, your instructions, results so far, the exact current state, and what remains. A toast tells you when it happens.
- **Prefix caching.** Each step re-reads the conversation so far from cache, which is what makes long contexts affordable.
- **Token budget** (`tokenBudget`, default 40M tokens processed per job; set `null` for no limit). At 100% the lead is told to wrap up. At 150% the job stops.
- **Steps.** A worker gets `maxSteps` model turns (default 300).
- **Keep-awake and notifications.** The Mac stays awake while a job runs, and you get a banner when an agent needs you or the job finishes.

If the model or account rejects the server-side features, the app says so once and falls back to trimming old tool results itself. Set `"context": { "enabled": false }` to force that fallback.

## Traces

Every job writes a folder under `traces/` (turn off with `"trace": false` in `swarm.config.json`):

- `timeline.log`: one readable line per event, all agents interleaved. Start here.
- `lead.jsonl` and one `<Worker>.jsonl` per worker: every model reply (stop reason, token counts, text, tool calls) and every tool result.
- Compactions and cleared tool results show up as `compaction` and `context` lines.

To see why a worker stopped, find its `END reason=` line: `reported` (it chose to stop), `step_limit`, `cut_off` (replies kept hitting the output limit), `error`, or `stopped`.

## Adding MCP servers

Edit `swarm.config.json`. Each server has:

- `command`, `args`, `env`: how to start it (same shape as other MCP clients). `${WORKSPACE}` expands to `~/Senju`.
- `app`: the macOS app name its ghost cursor should park on.
- `shared`: `true` to start one instance all agents share (stateless servers like files), `false` to give every agent its own instance (stateful servers like a browser).
- `tile`: `"playwright"` makes each agent's browser window open in its own slot on screen.

The defaults are a Playwright browser server (each agent gets its own Chrome window) and a filesystem server scoped to `~/Senju`.

## Known limits

- Ghost cursors show where an agent is working, not the exact element it is clicking.
- Each browser worker has its own fresh browser session, so two workers on the same site each need their own sign-in. The lead is told to keep one signed-in site with one worker where it can.
- Windows are placed when they open. A window is not moved again if the layout changes later.
- Agents can only do what the configured MCP servers allow.
- Desktop control depends on the app: games, canvas apps and some Electron apps ignore background input, and a write can appear to succeed without applying.
- The first job is slow to start while `npx` downloads the servers.

`npm test` runs the agent core against a fake model and a real MCP server.
