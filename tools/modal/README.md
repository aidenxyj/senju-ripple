# Ripple on Modal, opt-in

The same vLLM server as `tools/vast/` (the default), on Modal instead of a rented Vast.ai B200. Modal scales to zero when idle, but B200s can queue there. Run `tools/modal/bench.mjs` to measure either one.

## The server

`ripple_vllm.py` follows the vLLM recipe (recipes.vllm.ai/ricursiveAI/Ripple-65B-Preview):

- **vLLM nightly image.** The `ripple` tool-call and reasoning parsers come from vLLM PR #65745, and the 0.33 release doesn't have them (`invalid tool call parser: ripple`).
- **B200 (the default).** It uses the official NVFP4 checkpoint (`Ripple-65B-Preview-NVFP4`, about 62 GB in GPU memory), which fits one GPU.
- **Older GPUs** (`RIPPLE_GPU=H100:2`) load BF16 and quantize to FP8.
- **The DFlash2 drafter** handles speculative decoding (7 tokens), plus prefix caching.
- **Fails fast.** If vLLM exits, the container exits, so it doesn't hold a GPU until the startup timeout.

## One-time setup

```sh
modal secret create ripple-vllm VLLM_API_KEY=<random>     # becomes RIPPLE_API_KEY
modal run tools/modal/ripple_vllm.py::check                # CPU only: confirms the image has the ripple parsers
RIPPLE_GPU=B200 modal run tools/modal/ripple_vllm.py::download   # CPU only: weights into the ripple-cache volume
RIPPLE_GPU=B200 modal deploy tools/modal/ripple_vllm.py          # prints https://<...>-ripple-vllm-b200-serve.modal.run
```

Put the printed URL plus `/v1` in a git-ignored env file, for example `.env.modal-b200`, alongside the same `RIPPLE_API_KEY`, `RIPPLE_MODEL` and `RIPPLE_MAX_CONTEXT` lines as `.env`.

## Using it

```sh
node --env-file=.env.modal-b200 tools/modal/bench.mjs                  # how fast is it
npm run eval -- --model ripple --suite hard                           # evals on it (export the .env.modal-b200 values first)
set -a; . ./.env.modal-b200; set +a; (cd app && npm start)             # the app: values already in the environment win over .env
```

## Cost and behaviour

- Modal bills only while a container runs. It scales to zero after 15 minutes idle, and the first request after that waits for a cold start.
- **B200s can queue.** It once took Modal about 13 minutes to assign one, and nothing bills while it waits.
- Stop it completely: `modal app stop --yes ripple-vllm-b200`.
- It serves `ricursiveai/ripple-65b-preview` with up to 131k context. vLLM ignores the `provider` field that adapter/ sends.
