# Ripple on a rented B200 (Vast.ai)

This is where Ripple runs: a vLLM server (nightly image, NVFP4 checkpoint, `ripple` parsers, DFlash2) on a B200 rented by the hour. Every lead and worker, in the app and in evals, calls it. It typically answers about 7 minutes after renting: 3 minutes to start, then about 4 minutes to download, load and compile.

Measured on a Vast B200 against a shared hosted API (OpenRouter), for a realistic worker turn (`node --env-file=... tools/modal/bench.mjs`):

| | OpenRouter | Vast B200 |
|---|---|---|
| One call at a time, median | 8.0 s (spikes to 32 s) | **1.4 to 4.8 s** |
| 4 calls at once | 6.0 s for all four | **3.6 to 4.9 s** |
| Time to first token | 0.6 s | **0.1 s** |
| Output speed | 25 to 47 tokens/s | **about 125 tokens/s** |
| Errors | bursts of 503 and 429 | none seen |

### DFlash2 draft length

The server drafts 10 tokens per step (`num_speculative_tokens`). DFlash2 was trained on blocks of 16, and a sweep on one B200 on 2026-11-24 compared 7, 10, 12 and 16. Each was measured on a worker turn (one tool call, about 200 output tokens) and a lead plan (long free text). Values are median output tokens/s:

| Draft length | Worker, one at a time | Worker, 4 at once | Lead, one at a time | Tokens accepted per draft (worker / lead) |
|---|---|---|---|---|
| 7 | 256 | 215 | 149 | 3.61 / 2.47 |
| **10** | **289** | 217 | **156** | 3.82 / 2.50 |
| 12 | 289 | 242 | 141 | 3.75 / 2.18 |
| 16 | 283 | 282 | 128 | 4.01 / 2.20 |

10 is the only length that is faster than 7 for both workers and the lead. Longer drafts slow down the lead's free text, because few of the extra tokens are accepted. Each length had only 5 sequential calls and one batch of 4, so the "4 at once" column is noisy.

## Use it

```sh
python3 tools/vast/ripple_b200.py whoami          # check this is the account you want to bill (VAST_API_KEY_FILE)
python3 tools/vast/ripple_b200.py offers          # pick one; about $7.50 to $12.50/hr
python3 tools/vast/ripple_b200.py rent <offer>    # billing starts now; note the instance id
python3 tools/vast/ripple_b200.py env <instance>  # once it is running: writes its address into .env and app/.env

node --env-file=.env tools/modal/bench.mjs        # ready and fast?
npm run app                                       # the whole app on it
```

`rent` starts vLLM with `RIPPLE_API_KEY` from `.env` as its only accepted key, so set that first (any long random string). Your Vast key is read from `~/.config/vastai-personal/vast_api_key` (or `VAST_API_KEY_FILE`).

## Billing: read this

- **Vast bills from the moment you rent until you destroy the instance,** whether or not it's in use.
- **`stop`** ends GPU billing but keeps the disk, for about $0.05/hr. While it's stopped, someone else can rent that GPU, and then `start` fails with `resources_unavailable` and waits in a queue. If you need it again soon, keep it running. Otherwise `destroy` it and rent again later, which takes about 7 minutes.
- **Don't** use a team account's key for personal experiments. `whoami` shows `is_team`.
