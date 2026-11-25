---
name: autoresearch
description: Run the autoresearch loop on one eval task. Each call runs one generation, reads the failures, makes one change to evals/skills/<task>/SKILL.md, and keeps or reverts it. Use as "/autoresearch <task-id>", or "/loop /autoresearch <task-id>" to run unattended.
---

# Autoresearch: teach the model one task

You are the researcher. The model in `.env` (the student, `LLM_*`) runs a computer-use task through the Senju swarm, built exactly as the desktop app (`app/`) builds it: `makeSwarm({ shell: true })`, so browser workers act through one `browser__sh` tool with `senju` commands (`senju look`, `senju click e12`, `senju type e3 "text"`, `senju done "report"`). Its weights never change. What changes is the task's skill folder, which is injected into the lead's and the workers' prompts and served through `read_skill`:

```
evals/skills/<task>/
  SKILL.md        frontmatter (name, description) + the method. Your main lever.
  examples/*.md   optional: one shortened winning run (workers see it)
  policy.json     optional knobs: see evals/lib/policy.mjs (inject, examples, lead/worker append+drop, tools, sampling, bestOf)
  HISTORY.md      written by the runner, one line per generation. Do not edit.
```

The argument is the task id (for example `web-form`, `expense-report`, `minesweeper-swarm`). Tasks live in `evals/tasks/`, `evals/tasks/hard/` and `evals/tasks/games/`.

## Work in the sandbox, never in the shared checkout

Other work happens in the main checkout, and the app reads its `app/skills/`. The loop works on its own copy: run `evals/research/sandbox.sh <id>` (it prints a path, `../senju-research-<id>` by default, a git worktree on branch `research/<id>` with `app/node_modules` and `.env` linked). Run every command below from that path (`cd <path> && ...`), and commit only there. Use `--concurrency 2` at most: one B200 serves every run, and the app may be using it too.

## One generation (do exactly this, once per invocation)

1. **Status.** Run `node evals/research/run.mjs --status --task <id>`. If the task is DEMO-READY, say so and stop. If the ledger has no rows for it yet, run step 2 with `--label "g0 baseline, empty skill"` and do not change anything first.
2. **Run.** `node evals/research/run.mjs --task <id> --k 6 --concurrency 2 --label "<one line: the change you made and why>"`. It takes a few minutes. It prints the verdict (BASELINE, KEEP, REVERT or INFRA), the first missed milestones, and paths to transcripts. On REVERT it has already restored the skill folder from the champion.
3. **If the verdict is KEEP or BASELINE:** commit the skill and the ledger (`git add evals/skills/<id> evals/research/ledger.jsonl && git commit -m "autoresearch <id> g<N>: <change>"`). Only those paths.
   **If INFRA:** something outside the model broke (an MCP server, the network, a timeout in setup). Rerun once. After 2 INFRA verdicts in a row, stop and tell the human what broke.
4. **Readiness.** If this generation passed at least 5 of 6, run `node evals/research/run.mjs --task <id> --seeds unseen --k 6`. Two `ready` checks in a row make the task demo-ready. Never open those transcripts.
5. **Read.** Open 2 or 3 failing transcripts from step 2 (`transcript.md` in each episode folder) and 1 passing one. Find, for each failure, the first moment the model went wrong. Label it: invalid call, wrong target, wrong tool, loop, quit early, never finished, misread the screen, lead planned badly, worker ignored the playbook.
6. **Change one thing** for the most common label, in the skill folder only. The next invocation's step 2 tests it. In order of preference:
   - a line or step in `SKILL.md` (most fixes);
   - the winning run in `examples/` (when the model has passed at least once: shorten a passing transcript to its calls and the key observations, with the values replaced by `<placeholders>`);
   - a knob in `policy.json` (`sampling.temperature`, `bestOf: 3` against invalid calls, `worker.drop` for prompt sections that confuse it, `worker.append` for one hard rule).
7. **Demo-ready?** Once a task is demo-ready, push `research/<id>` and tell the human. Only when they say so, ship it: open a PR of `evals/skills/<id>/`, or run `node evals/research/run.mjs --task <id> --export --to <shared checkout>/app/skills`, which writes `<id>.md` where the app's lead lists it and can `read_skill` it. Post on the board when it is there.
8. **Report** in 2 or 3 lines: generation, score versus champion, verdict, and the change queued for the next generation.

## Writing SKILL.md for the model

Write for the weakest model you plan to run. Small and lightly post-trained models follow short, concrete, numbered instructions far better than prose, and strong models lose nothing from it.

- Keep the body under about 1,500 tokens. Every worker gets all of it.
- Start with `## Lead plan`: how many workers, what each one does, and what each must report. Then `## Method`: numbered steps a worker follows. Then `## Traps`: one line per failure seen, each with the fix. Then `## Check before done`: what to verify on screen or on disk before the final report.
- Name tools and commands exactly as the transcripts show them (`browser__sh` with `senju look`, `senju click`, `senju type`; `files__write_file`; `board_post`), and name page elements by their visible label or role, never by id.
- Keep the frontmatter `description` a sentence the app's lead can match a goal against (it starts as the goal's first sentence). In the app, the lead sees only the name and description and must choose to read the skill.
- **Never** put a variant's values in the skill: no names, amounts, file names, URLs, ports or element ids such as `e12` or `ref=s1e5`. Seeds change these every generation, and the stage run uses unseen ones. Write "the name given in the goal", not "Ada Lovelace".
- Fold each generation's wins in: when a passing run found a shortcut, write it down as a step.
- Remove lines that did not help. A shorter skill that scores the same is better.

## Rules

- One change per generation, so the ledger can say what caused each gain.
- Edit only `evals/skills/<id>/`. Never edit tasks, checkers, `evals/research/` or other folders. If a fix needs code (a new `senju` verb, a guard rule, an eyes/ change), note it for the human and keep going with what you can change.
- Do not read checker code to tune for it. Read the goal and the transcripts, as a person would.
- Never print or commit `.env`.
