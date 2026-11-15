# WebGames (vendored)

Seven challenges from [convergence-ai/webgames](https://github.com/convergence-ai/webgames), Apache-2.0 (`LICENSE` here). They run as the `webgames-*` tasks in the `benchmarks` suite (`evals/tasks/benchmarks/`).

- **Source:** commit `309866f64642b864414ca2c7ff956e59e01d3317` (2025-06-02), folder `webgames/`.
- **Build:** `npm install && npx vite build`, run in a scratch checkout. That is the upstream `pnpm build` without its `tsc -b` type check. `dist/` is that build output, unchanged (2.1 MB). Nothing else from the repo is vendored.
- **Passwords:** `passwords.json` holds one password per id, from the [HF dataset](https://huggingface.co/datasets/convergence-ai/webgames) `test.jsonl` (`id`, `path`, `password`). They match the `PASSWORD_*` constants in the source.
- **Serving:** `task.mjs` serves `dist/` from `127.0.0.1` on a random port. Files go out with real content types, `index.html` is returned for every challenge path (it is a single-page app), and `/api/*` gets a 404 (the app's analytics calls fail quietly).

| Task | What it takes | Notes for a text-only agent |
|---|---|---|
| `webgames-date` | Type today's UTC date as YYYY-MM-DD and submit | The agent has to know today's date |
| `webgames-buttons` | Find the one element that reveals the password among many decoys: the text "this does nothing" | |
| `webgames-i-accept` | Tick the terms checkbox and submit | |
| `webgames-text-mirror` | Copy two paragraphs exactly into the text area and submit | |
| `webgames-key-combo` | Hold Control+Shift+Y | The page drops keys that arrive in the same instant. So `browser_press_key 'Control+Shift+Y'`, and `senju key` today, do not pass. Holding the keys one after another with a short pause does. |
| `webgames-wolf-goat-cabbage` | The river-crossing puzzle with Load, Move and Unload buttons | |
| `webgames-towers-of-hanoi` | 5 disks to the right peg, 31 moves | The disks have no text, only three "Select" buttons, so the agent must track the state itself. The start state and the rules are on the page. |

Each goal asks for the revealed password in `{workspace}/answer.txt`. `check()` passes when the file, trimmed and with surrounding quotes removed, equals the password. The stub really plays each challenge (navigate, click, type, keys, or a short page script for the puzzles), then reads the password off the page. It never reads `passwords.json`.

To rebuild, or to add a challenge: clone the repo, run the build above, replace `dist/`, add the id to `passwords.json` from `test.jsonl`, and add `evals/tasks/benchmarks/webgames-<id>.js` calling `webgamesTask()`.
