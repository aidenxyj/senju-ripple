# Self-hosted model on Modal

The same vLLM server as `tools/vast/`, on Modal instead of a rented Vast.ai GPU. Modal scales to zero when idle, but large GPUs can queue there. Settings (`SERVE_MODEL`, `SERVE_ARGS`, `SERVE_GPU`, ...) are in `tools/README.md`; they are read at deploy time from the environment or `.env` and baked into the image.

`serve.py`:

- Serves `SERVE_MODEL` as `SERVE_NAME` on `SERVE_GPU` (default one B200; `B200:2`, `H100:2` ... use tensor parallel). Each GPU type deploys as its own app, `senju-vllm-<gpu>[-x<count>]`.
- Adds `--enable-auto-tool-choice`, prefix caching and `--max-num-seqs 64`, plus whatever `SERVE_ARGS` holds (parsers, `--quantization fp8` for weights too big for the GPU, `--speculative-config`).
- **Fails fast.** Deploy refuses without `SERVE_MODEL`, and if vLLM exits, the container exits, so it doesn't hold a GPU until the startup timeout.

## One-time setup

```sh
modal secret create senju-vllm VLLM_API_KEY=<random>   # use the same value as LLM_API_KEY
modal secret create huggingface HF_TOKEN=<token>       # needed by the app; any token works for public repos
modal run tools/modal/serve.py::check                  # CPU only: the image's vLLM version
modal run tools/modal/serve.py::download               # CPU only, optional: weights into the senju-vllm-cache volume
modal deploy tools/modal/serve.py                      # prints https://<...>-senju-vllm-b200-serve.modal.run
```

For example, with `SERVE_MODEL=<org>/<model>` and `SERVE_ARGS=--tool-call-parser <parser>` in `.env`. Put the printed URL plus `/v1` in a git-ignored env file, for example `.env.modal`, as `LLM_BASE_URL`, with `LLM_API_KEY`, `LLM_MODEL` (= `SERVE_NAME`) and optionally `LLM_MAX_CONTEXT`.

## Using it

```sh
node --env-file=.env.modal tools/modal/bench.mjs                # how fast is it
set -a; . ./.env.modal; set +a; (cd app && npm start)           # the app: values already in the environment win over .env
```

## Cost and behaviour

- Modal bills only while a container runs. It scales to zero after 15 minutes idle, and the first request after that waits for a cold start (loading the weights again).
- **Big GPUs can queue.** Assigning a B200 can take many minutes; nothing bills while it waits.
- Stop it completely: `modal app stop --yes senju-vllm-b200` (or whichever app name deploy printed).
