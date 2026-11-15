# MiniWoB++ (vendored)

Eleven tasks from [Farama-Foundation/miniwob-plusplus](https://github.com/Farama-Foundation/miniwob-plusplus), MIT (`LICENSE` here). They run as the `miniwob-*` tasks in the `benchmarks` suite (`evals/tasks/benchmarks/`).

- **Source:** commit `7fd85d71a4b60325c6585396ec4f48377d049838`, the commit BrowserGym pins. Only what these 11 pages load is vendored under `html/` (1 MB):
  - their `.html` files
  - `core/` (without `record.js`, `d3.v4` and `jscolor`)
  - `common/ui_utils.js`
  - `common/special/{book-flight,email-inbox,search-engine,social-media}` (the social-media icons were added later, from upstream `master`; without them its reply, retweet, like and more icons are 0 px wide and cannot be clicked)
- **Episodes:** `serve.mjs` serves `html/` from `127.0.0.1` and adds a script to the task page that does what BrowserGym does when an episode starts:
  - it seeds the RNG (`Math.seedrandom(seed)`), with 42 by default and `ctx.seed` overriding it
  - it raises `core.EPISODE_MAX_TIME` to the task timeout, since MiniWoB's 10 to 30 s is meant for RL agents
  - it calls `core.startEpisodeReal()`
  - when `WOB_DONE_GLOBAL` turns true, it POSTs `WOB_RAW_REWARD_GLOBAL` and `WOB_REWARD_REASON` to `/report`
- **Checker:** passes when the **first** finished episode has a raw reward above 0, which is how BrowserGym scores MiniWoB. Reloading after a wrong final click starts a new episode, but the first one still counts.
- **Goal:** quotes the page's own instruction for seed 42 (`utterances.json`, regenerated with `node evals/benchmarks/miniwob/utterances.mjs`, which also checks that the seed makes it repeatable). For other seeds, the goal points the agent to the instruction at the top of the page.
- **Stub:** opens the page and runs `solver.mjs` inside it with `browser_evaluate`. The solver reads the instruction and the DOM, then fills in and clicks the right elements. It works for any seed.

| Task | Instruction for seed 42 | Notes for a text-only agent |
|---|---|---|
| `miniwob-click-button` | Click on the "Yes" button. | |
| `miniwob-enter-text` | Enter "Keli" into the text field and press Submit. | |
| `miniwob-login-user` | Enter the username "kenda" and the password "GjVJ8" … press login. | |
| `miniwob-click-checkboxes` | Select nothing and click Submit. | Other seeds ask for some boxes. A partly right answer can still score above 0, as in MiniWoB. |
| `miniwob-choose-list` | Select Audrye from the list and click Submit. | |
| `miniwob-use-autocomplete` | Enter an item that starts with "Afgh" and ends with "tan". | |
| `miniwob-enter-date` | Enter 01/06/2010 as the date and hit submit. | A native date input |
| `miniwob-email-inbox` | Find the email by Tiffanie and click the trash icon to delete it. | Trash, star, reply and send are icons with no text |
| `miniwob-search-engine` | … enter "Lyda" and press "Search", then … click the 5th search result. | Results are paged 3 per page |
| `miniwob-book-flight` | Book the shortest one-way flight from: ABI to: North Platte, NE on 12/11/2016. | The date field is a read-only jQuery UI date picker |
| `miniwob-social-media` | For the user @quis, click on the "Embed Tweet" button. | Reply, Retweet and Like are icons with no text, and the other actions sit behind a "more" icon |

`node evals/benchmarks/miniwob/test.mjs` checks near misses in a real browser: a wrong button fails, a reload after a wrong answer does not get a second try, an opened but unfinished task fails, and another seed gives a different instance that the solver still passes.
