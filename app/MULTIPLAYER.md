# Team mode

Several people, several computers, one session. The lead and workers run on a server; each person's desktop app lends its tools and shows the cursors; a web app handles accounts, teams, memory and a live view.

```
 Alex's Mac (desktop app) ---+                       +-- Supabase: sign-in, teams,
 Linda's Mac (desktop app) --+--> server (the hub) --+   memory, history, encrypted keys
 anyone's browser (web app) -+     runs the swarm    +-- Ripple API, on the session owner's key
```

## What it does

- **One agent, several desktops.** Every tool server belongs to a computer (`desktop@linda-mac`). A worker can be given servers from more than one computer, so it can read on one and write on another.
- **Docking.** While an agent is resting, its cursor shows on every teammate's screen. When it is called to a computer, its cursor shows there and disappears from the others. Its chip says where it is.
- **Consent per session.** A session's owner's own computers join automatically. Everyone else's computer shows a card ("Linda wants to use this Mac for ...") and nothing runs there until its owner allows it, for that session only. A computer can join or drop out mid-session and the lead replans.
- **Requests go to the right person.** A sign-in or task on a computer is shown in full only to the person at that computer, and only they can answer it. Everyone else sees that the agent is waiting for them, not what was asked. Questions from the lead go to everyone in the session; the first answer wins and is credited by name.
- **Joining a session that is already running.** Sign in on a computer or open the web app mid-session and you are offered the session. "Allow" shares the computer and joins you; "Just watch" (or "Join session" on the web) joins you without sharing anything. On joining you receive the session as it stands: the goal, every agent with its subtask and current status, the chat so far, worker reports, board notes, and any open requests you are allowed to see.
- **Everyone can talk to the lead.** Messages carry their author's name. The lead answers by name, and is told to raise conflicting instructions rather than pick one.
- **Session owner.** Whoever starts a session owns it: it runs on their API key, and only they can stop it. There is one session per team at a time.
- **Memory with attribution.**
  - *About a person*: lasting preferences someone states. Visible only to that person, and to the lead when they take part.
  - *Team notes*: for the whole team, saved only when a participant says it should apply to the team.
  - *Team skills*: how-tos the lead writes after a session, credited to the session owner, with every earlier revision kept.
  - Every entry records the single person it came from. Anyone can delete what is remembered about them; team members can prune team memory.

## Who sees what

The hub decides this per person, for live events and for the catch-up sent on joining. It is code, not an instruction to the model.

| | In the session | On the team, not joined |
|---|---|---|
| That a session is running, its goal and owner | yes | yes |
| Agent names, which computer each is on, coarse status (for docking) | yes | yes |
| Agent subtasks and step labels, chat, reports, board, summary | yes | no |
| A request tied to someone's computer (sign-in steps, a task) | only that person | no |
| "Remembered about you" notes | only you | no |
| Team notes and skills | yes | yes, in the web app |
| Tool results: page contents, screenshots, window contents | nobody (hub and model only) | no |
| API keys | nobody | nobody |

What this does not cover: a worker that reads something on Linda's computer can repeat it in its report, on the board, or in the lead's summary, and everyone in the session reads those. The prompts tell the lead and workers to carry across only what the goal needs and never to quote one person's notes to another, but that part is an instruction, not enforcement. Lend a computer to a session the same way you would share your screen with those people.

## Set it up

1. **Supabase.** Create a project. In the SQL editor, paste all of `server/schema.sql` and run it. Under Authentication, turn off "Confirm email" while you test: the built-in mail sender allows only a few messages an hour.
2. **Server settings.** Copy `server/env.example` to `.env.server` in the project folder. Fill in the project URL, the publishable key and the secret key (Settings > API Keys), and a `KEY_ENCRYPTION_SECRET` from `openssl rand -hex 32`. Keep the secret key and the encryption secret private: together they can read every stored API key.
3. **Run the server.** `npm install`, then `npm run server`. It serves the web app at `http://localhost:8787`.
4. **Accounts.** Open the web app, create an account, create a team, and share the invite code. Each person saves their own Ripple API key under Settings.
5. **Desktop apps.** Start the app and choose **With my team**, then sign in from the bar. While you test against a server on your own Mac, point the app at it in `swarm.config.json`:

   ```json
   "cloud": { "url": "http://localhost:8787" }
   ```

   Without a `cloud` entry, team mode uses the built-in server address. Choosing **On this Mac** at launch never contacts a server.

For two laptops on one network, run the server on one and use its address (`http://192.168.x.x:8787`) on both. For anything beyond that, deploy it (a `Dockerfile` is included) behind HTTPS, so sign-in tokens and screen contents are encrypted in transit.

## Deploy it

There are three things to deploy, not two.

| Piece | Where | Why |
|---|---|---|
| Sign-in and database | Supabase | Run `server/schema.sql` once. Nothing of ours runs there. |
| The hub and the web app (`server/index.js`) | One always-on container: Fly.io, Railway, Render, or a small VPS | It holds a WebSocket to every computer for hours and keeps each running session in memory. |
| The download site (`senju-website/`) | Vercel, or any static host | Plain files. |

Why the hub cannot live on Supabase or Vercel: Supabase Edge Functions stop after 150 seconds (400 on paid plans), and Vercel Functions close a WebSocket when the function reaches its maximum duration, about five minutes by default. A session runs for an hour or more and its state is in the hub's memory, so it needs a process that stays up.

**1. Supabase.** Create a project, run `server/schema.sql` in the SQL editor, and copy the project URL, the publishable key and the secret key. Under Authentication, set the Site URL to the hub's address so confirmation emails link back to the web app.

**2. The hub.** The included `Dockerfile` builds it. Set these on the host (the same names as `server/env.example`): `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `KEY_ENCRYPTION_SECRET`. A `fly.toml` is included. On Fly.io:

```sh
fly launch --copy-config --no-deploy   # keeps fly.toml; choose an app name
fly secrets set SUPABASE_URL=... SUPABASE_PUBLISHABLE_KEY=... SUPABASE_SECRET_KEY=... KEY_ENCRYPTION_SECRET=...
fly deploy
fly scale count 1
```

- **Exactly one instance, never scaled to zero.** Sessions live in that process's memory. A second instance would not know about them, and a restart or redeploy ends any running session.
- **HTTPS.** The host's TLS gives you `https://` and `wss://` on the same address. Check `https://your-hub/health`.
- **Keep `KEY_ENCRYPTION_SECRET` forever.** Change it and every stored API key becomes unreadable.
- 512 MB of memory is enough to start. The hub does no browser work; that happens on people's computers.

**3. The web app** is served by the hub at its own address (`https://your-hub/`). It expects to share an origin with the hub, so it does not go on Vercel separately.

**4. The download site.** Import `senju-website` into Vercel as a static project (no framework, no build command). The DMGs are over 100 MB each: publish them as a GitHub Release and point the two download buttons in `index.html` at the release URLs, rather than committing them to the site.

**5. Point the desktop app at the hub.** The app asks on every launch whether to work on this Mac or with the team. Team mode connects to the address in `DEFAULT_HUB` in `src/config.js`, which is built into the installers. To use another server, change that constant before `npm run release`, or add `"cloud": { "url": "https://your-hub" }` to `swarm.config.json` on one computer.

## Charging for hosted sessions

By default everyone brings their own Ripple API key. Give the server a key of its own and a Stripe account, and people can instead subscribe and run sessions on the server's key.

**How it works**

- Whoever starts a session pays for it. If they saved their own key, it is used and nothing is charged. Otherwise the session runs on the server's key and comes off their credits.
- A subscription is $20 a month and each paid month adds $20 of credits. Unused credits carry over. Subscribers can buy more in $10, $25 and $50 amounts.
- Credits are spent at what the tokens cost, times 1.3. The token rates in `server/billing.js` are defaults ($0.10 in, $0.30 out per million tokens); update them if you change the model.
- A session is charged in steps of about $0.25 while it runs and stops when the balance reaches zero. The most a session can overrun is roughly one step plus the model calls already in flight.
- Every change to a balance is a line in `credit_ledger`: monthly credits, purchases, and what each session used.

All of these numbers are settings (`SENJU_PLAN_USD`, `SENJU_PLAN_CREDITS_USD`, `SENJU_TOPUPS_USD`, `SENJU_MARKUP`, `SENJU_RATE_*`).

**Set it up in Stripe's test mode**

1. Run `server/schema.sql` in Supabase again. It is safe to re-run and adds the billing tables.
2. In the Stripe dashboard, stay in test mode and copy the secret key (`sk_test_...`).
3. Add to `.env.server`: `RIPPLE_API_KEY`, `STRIPE_SECRET_KEY`, and `PUBLIC_URL` (for local testing, `http://localhost:8787`).
4. Stripe has to be able to tell the server that a payment arrived. Locally, install the Stripe CLI and leave this running; it prints a `whsec_...` value to put in `.env.server` as `STRIPE_WEBHOOK_SECRET`:

   ```sh
   stripe listen --forward-to localhost:8787/api/stripe/webhook
   ```

5. Restart `npm run server`. In the web app, remove your own API key under Settings, click Subscribe, and pay with the test card `4242 4242 4242 4242`, any future date and any CVC. Your balance should show $20.00 a few seconds later.

**On the deployed server:** in Stripe, add a webhook endpoint at `https://your-hub/api/stripe/webhook` for the events `checkout.session.completed`, `invoice.paid`, `customer.subscription.updated` and `customer.subscription.deleted`, and set its signing secret, the Stripe key, the Ripple key and `PUBLIC_URL` with `fly secrets set`. Turn on the customer portal in Stripe's billing settings so "Change card or cancel" works.

**Before charging real money:** switch to the live Stripe keys, turn email confirmation back on in Supabase, and destroy the hub's Vast B200 when it is idle (Vast bills by the hour, see `tools/vast/README.md`). Anyone with database access can change a balance, so keep the Supabase secret key private.

## How it is built

- `server/hub.js`: the hub. Verifies sign-ins, keeps presence, runs one `Swarm` per session, routes tool calls to computers, and decides who each request is for.
- `server/store-supabase.js`: accounts, teams, encrypted keys, memory and history in Supabase. `server/store-memory.js` is the same shape in memory, for tests.
- `server/schema.sql`: tables and row level security.
- `src/cloud.js` and `src/toolhost.js`: the desktop app's side. It announces its tools, runs calls the hub sends (tiled windows, one desktop action at a time, waiting while you type), and relays events to the overlay.
- `web/`: the web app.

## What has and has not been tested

Tested with scripted models, over real WebSockets: the hub with two people, two computers and a browser (`test/hub.mjs`); two desktop clients end to end (`test/cloud.mjs`); the web app in a browser against the real hub.

Not yet run for real: anything that touches Supabase (`schema.sql`, `store-supabase.js`, sign-up and sign-in in the web app and desktop app), a session on two physical computers, and the server under Docker.

## Limits and risks

- **A teammate's session acts on your computer with your accounts.** Consent is per session and you can stop any agent on your computer, but the per-app rules are still instructions to the model, not enforcement.
- **The server sees everything**: prompts, page contents, screenshots, and (encrypted) API keys. With tracing on, it also writes them to its disk. Run it yourself, for people you trust.
- **Privacy between teammates stops at the model.** The hub filters what each person is sent, but it cannot filter what an agent chooses to write in a report or summary. See "Who sees what".
- **One session per team**, and the owner cannot be changed after it starts.
- **No offline queue.** If a computer disconnects, workers using it fail their next call and the lead routes around it.
