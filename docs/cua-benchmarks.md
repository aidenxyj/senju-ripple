# CUA benchmarks: what we can reuse for evals/ and the demo

Researched 2026-11-13. Fit is judged against Senju's limits: the agents only see text (Playwright MCP snapshots and accessibility trees), run on local pages and a scratch folder, and need automatic checkers. Setup also has to take under an hour.

Fit scores run from 0 to 5. **(V)** means I checked the claim on the primary source this session. **(M)** means it comes from memory or a paper abstract and I did not re-check it.

## Comparison

| Benchmark | Tasks | Environment | Checker | Text-only? | License | Setup | Evals | Demo |
|---|---|---|---|---|---|---|---|---|
| **MiniWoB++** | 100+ | Static HTML/JS, opened as `file://` (V) | Reward in JS globals (V) | Mostly yes; skip the shape, color and drag tasks | MIT (V) | About 5 min | **5** | 2 |
| **WebGames** | 53 families, 150 challenges (V) | Local React app via `pnpm dev` (V) | A password appears when the task is solved (V) | About half the tasks | Apache-2.0 (V) | About 10 min | **4** | 2 |
| **OpenApps** (Meta, Nov 2025) | YAML task sets (V) | Local Python apps (`uv run launch.py`), CPU only, no Docker (V) | Checks the app's state (V) | Yes, plain web UIs | **CC-BY-NC** (V) | About 15 min | **5** | **4** |
| REAL / agisdk | 112 tasks on 11 clone sites (V) | Copies of real sites (Amazon, Gmail, United and others), hosted by AGI Inc (V) | State checks, plus an LLM rubric for lookup tasks (V) | Yes | SDK Apache-2.0; paper CC BY-NC-SA (V) | `pip`, but the sites are remote | 3 (borrow the design) | 4 (borrow the design) |
| WebArena-Verified | 812, plus a 258-task Hard set (V) | Self-hosted Docker; images up to 92% smaller as of Feb 2026 (V) | Deterministic, no LLM judge (V) | Yes | Apache-2.0 (V) | Several GB, 1 h or more | 3 | 2 |
| WebArena / VisualWebArena | 812 / 910 (M) | Docker | Programmatic (M) | WebArena yes; VWA needs vision | Apache-2.0 (M) | Heavy | 2 / 0 | 1 |
| WorkArena / ++ | 33 atomic tasks; 682 at L2 (V) | ServiceNow instance through a gated HF dataset (V) | Programmatic | Yes | Not named on the page | Approval wait | 1 | 1 |
| WebShop | 12,087 instructions, 1.18M products (V) | Local Flask, with a text mode (V) | Reward from product attributes (M) | Yes | MIT (V) | Conda, Java, spaCy; 30-60 min | 3 | 3 |
| Online-Mind2Web | 300 tasks on 136 sites (V) | Live web (V) | WebJudge LLM judge (V) | Mostly | MIT code, CC-BY-4.0 data (V) | Low, but live sites | 0 | 1 |
| Mind2Web | 2,350 (M) | Offline page snapshots, scored step by step (M) | Element-match accuracy | Yes | (M) | Medium | 1 | 0 |
| WebVoyager | 643 tasks on 15 sites (M) | Live web | GPT-4V judge (M) | Partly | (M) | Low | 0 | 1 |
| AssistantBench | 214 (V) | Live web (M) | Answer accuracy (V) | Yes | CC BY-SA (site) (V) | Low | 1 (answer match is reusable) | 1 |
| BrowseComp | 1,266 (M) | Live web | Short answer | Yes | (M) | Low | 0 | 0 |
| OSWorld / -Verified | 369 (M); Verified update 2025-07-28 (V) | Ubuntu VM: VMware Fusion on Apple Silicon, or Docker with KVM (V) | Execution-based scripts (M) | The paper reports an a11y-tree mode (M) | Apache-2.0 (V) | Heavy | 2 (borrow the checkers) | 1 |
| OSWorld 2.0 / 2.1 (Jun 2026) | 108 tasks, median 1.6 h for a human (V) | VMs plus self-hosted mock sites and GitLab (V) | Evaluator metrics; official runs only by the maintainers (V) | Screenshot only is confirmed | Apache-2.0 (V) | Very heavy | 0 | 0 |
| **macOSWorld** | 202 tasks, 30 apps, 5 languages (V) | AWS EC2 Mac; unofficial VMware fork (V) | Scripts over SSH (V) | Unclear; leans on screenshots | LICENSE file not checked | Heavy, AWS cost | 2 (copy task ideas) | 3 (copy task ideas) |
| MacArena (2026) | 421 tasks, 50 apps (V) | UTM VMs on Apple Silicon, 2 per host (V) | Hand-written evaluator scripts (V) | Screenshots plus an optional a11y tree (V) | Not stated | Heavy | 2 (copy task ideas) | 3 (copy task ideas) |
| Windows Agent Arena | 154 (M) | Windows VM in Docker | Scripts | Partly | MIT (M) | Heavy | 0 | 0 |
| AndroidWorld | 116 tasks, 20 apps (M) | Android emulator | State checks | a11y tree | Apache-2.0 (M) | Medium to heavy | 0 | 0 |
| TheAgentCompany | 175 (V) | 4 Docker services, 30 GB or more (V) | Checkpoints plus an LLM judge (V) | Yes | MIT (V) | Heavy | 1 | 2 |
| ScienceBoard | 169 (M) | VM | Scripts (M) | Partly | (M) | Heavy | 0 | 0 |
| MyPCBench (Jun 2026) | Linux desktop with 17 mock web apps (V) | Docker (V) | Not checked | Not checked | Open source | Heavy | 1 | 1 |

## Recommendation 1: port these into evals/ first

### A. MiniWoB++ (MIT, static files)

Vendor `miniwob/html/miniwob/` at the commit BrowserGym pins, `7fd85d71` ([BrowserGym MiniWoB README](https://github.com/ServiceNow/BrowserGym/blob/main/browsergym/miniwob/README.md)). Serve it with the `servers.mjs` pattern.

How to set it up:

- BrowserGym starts each episode with `Math.seedrandom(seed); core.EPISODE_MAX_TIME=…; core.startEpisodeReal()`. It reads the goal from `core.getUtterance()` and scores with `[WOB_REWARD_GLOBAL, WOB_RAW_REWARD_GLOBAL, WOB_REWARD_REASON, WOB_DONE_GLOBAL]`, where pass is `RAW_REWARD > 0` ([base.py](https://raw.githubusercontent.com/ServiceNow/BrowserGym/main/browsergym/miniwob/src/browsergym/miniwob/base.py)).
- For our harness, `setup()` serves the task HTML with a small script added. The script seeds the RNG, starts the episode, and polls `WOB_DONE_GLOBAL`. Once the episode is done, it POSTs `{raw: WOB_RAW_REWARD_GLOBAL, reason: WOB_REWARD_REASON}` to `/report`.
- `check()` passes when `ctx.reports.at(-1).raw > 0`. This is the same pattern `web-form.js` already uses.
- Fix the seed so that `goal` (the utterance) is known when `setup()` runs. You can also have `setup()` fetch it from the page.

Text-friendly tasks to start with: `click-button`, `enter-text`, `login-user`, `click-checkboxes`, `choose-list`, `use-autocomplete`, `enter-date`, `email-inbox`, `search-engine`, `book-flight`, `social-media`. Leave out `click-color`, `count-shape`, `grid-coordinate`, `drag-*` and `bisect-angle`, because they need vision or pixels. All 11 names are verified against `miniwob/html/miniwob/` at `7fd85d71`. The folder also has `email-inbox-reply`, `login-user-popup`, `phone-book`, `read-table`, `form-sequence`, `order-food`, `terminal` and `text-editor`, which are worth a look.

### B. OpenApps (local apps, state-based tasks; CC BY-NC; our evals reuse only its task goals, see `evals/benchmarks/openapps/README.md`)

Repo: [facebookresearch/OpenApps](https://github.com/facebookresearch/OpenApps). Tasks are typed YAML entries ([original_tasks.yaml](https://raw.githubusercontent.com/facebookresearch/OpenApps/main/config/tasks/original_tasks.yaml)):

- `add_meeting_with_dennis`: an `AddEventTask` with title "Dennis-Bob" on date 2026-04-01.
- `add_paper_reading_meeting_with_einstein`: adds a description, the location "New York City" and the invitee Einstein.
- `remove_wacv_abstract_deadline`: a `RemoveEventTask`.
- `add_call_mom_to_my_todo`, `mark_water_plants_as_done`, `delete_call_aunt_lisa`: the to-do task types.
- `message_bob_to_meet`: a `SendMessageTask` whose expected reply is "Yes, let's play on Saturday!"
- `save_eiffel_tower_to_my_favorite_places`: a `SavePlaceTask` checked by lat/lon with `tolerance_km: 0.5`.
- There are also `files`, `contacts`, `passwords`, `payments` and `longer_horizon` sets.

How to set it up: either run `uv run launch.py` from `setup()`, or rebuild the 3-4 apps we need as small Node pages that keep state in `ctx`. Each task type maps directly to a predicate in `check()`. For example, `AddEventTask` becomes: some event in `ctx.state.events` has the expected `title`, `date` and `invitees`. A JS rebuild avoids both the license question and the Python dependency.

### C. WebGames (Apache-2.0)

Run it with `pnpm install && pnpm run dev`. Each challenge shows a unique password when it is solved ([repo](https://github.com/convergence-ai/webgames)). The [HF dataset](https://huggingface.co/datasets/convergence-ai/webgames) has `id/path/password` columns.

How to set it up: the goal asks the agent to write the revealed password to `{workspace}/answer.txt`. `check()` passes when that file contains `row.password`.

Text-friendly IDs: `date`, `buttons`, `i-accept`, `text-mirror`, `scroll-vertical`, `scroll-horizontal`, `key-combo`, `file-upload`, `wolf-goat-cabbage`, `towers-of-hanoi`. Leave out `bullseye`, `frog-crossing`, `brick-buster`, `herding`, `canvas-catch`, `slider-symphony` and `color-harmony`, which depend on timing or canvas.

### Patterns to borrow rather than run

- **REAL**: deterministic clones, a final-state check for actions, and an answer check for lookups ([arXiv 2504.11543](https://arxiv.org/abs/2504.11543)).
- **WebArena-Verified**: type-aware normalized answer comparison, with no substring matching or LLM judge ([repo](https://github.com/ServiceNow/webarena-verified)). Use it for any `answer.txt` checker.

## Recommendation 2: demo scenarios on the Mac

All three run on local clone pages (OpenApps- or REAL-style) or native Mac apps, so we can check them afterwards. Mac apps are checked with `osascript`, for example by querying Calendar events or Reminders.

1. **"Plan Friday's team dinner"**
   - Agent 1 finds a restaurant slot on a local OpenDining-style page.
   - Agent 2 adds the event in Calendar.app (a11y tree), with a check modeled on OpenApps `AddEventTask`.
   - Agent 3 messages three invitees in a local messenger clone, modeled on `SendMessageTask`.
   - **Interrupt:** the human says "make it Saturday, and Alice is vegetarian." Agents 1 and 2 have to redo their work, and agent 3 has to edit its message.
2. **"Close out the expense report"**
   - Three agents each pull receipts from a different local shop or ride clone: an order-history page, a ride-history page, and a PDF folder.
   - A fourth agent combines them into `expenses.csv` and Numbers or TextEdit. This is `sum-csv` at a larger scale.
   - **Interrupt:** "exclude anything personal, the taxi on the 4th." One worker re-filters, and the total has to update.
3. **"Restock the office"** (WebShop-style; stops at the cart, since SPEC puts payments out of scope)
   - Three agents each buy one item from a local shop clone under attribute and price limits.
   - A fourth agent logs the purchases in Reminders.
   - **Interrupt:** the budget drops mid-run, so one agent has to swap its item.
   - Checker: the cart and order state on our server, plus the reminder titles.

## Unverified or caveats

- I did not re-check the (M) rows: WebArena, VWA, WebVoyager, Mind2Web, Windows Agent Arena, AndroidWorld, ScienceBoard and BrowseComp.
- I did not open the license files for macOSWorld, WorkArena or MacArena. OpenApps (CC BY-NC 4.0) and WebGames (Apache-2.0) were checked from their LICENSE files.
- I could not confirm whether REAL's clone sites can be self-hosted. They appear to be hosted by AGI Inc.
- OSWorld's a11y-tree mode comes from the paper. The README only shows `screenshot`.
- The third-party 2026 leaderboard numbers (OSWorld 2.0 at 20.6%, Fara1.5 at 72% on Online-Mind2Web) were not checked against the original sources.
