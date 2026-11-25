# Self-hosting a model

Senju talks to any OpenAI-compatible endpoint (`LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`; see `.env.example`). A hosted API is the easy path. These tools are for running an open model yourself with [vLLM](https://docs.vllm.ai) on a rented GPU:

- **`vast/serve.py`**: rent a GPU on Vast.ai by the hour. Fast and predictable, but it **bills until you destroy it**. See `vast/README.md`.
- **`modal/serve.py`**: deploy on Modal. Scales to zero when idle; the first call after idle waits for a cold start. See `modal/README.md`.
- **`modal/bench.mjs`**: times a realistic Senju worker turn against whatever endpoint an env file points at (hosted or self-hosted).

## What to serve

Both scripts read these from the environment, else the repo `.env`:

| Variable | Meaning | Default |
|---|---|---|
| `SERVE_MODEL` | Hugging Face repo to serve. **Required** to rent or deploy. | none |
| `SERVE_NAME` | Served model name; `env` writes it as `LLM_MODEL`. | `SERVE_MODEL` |
| `SERVE_MAX_LEN` | `--max-model-len` | `131072` |
| `SERVE_ARGS` | Extra vLLM flags as one string (shell-quoted, split with `shlex`). Tool-call and reasoning parsers, `--quantization`, `--speculative-config '{...}'` go here. | empty |
| `SERVE_GPU` | GPU type and count, e.g. `B200`, `H100:2` (Vast names such as `H100 SXM`). | `B200` |
| `SERVE_IMAGE` | vLLM Docker image. | `vllm/vllm-openai:latest` |
| `SERVE_DISK` | Vast only: disk in GB (must hold the weights). | `200` |

Every server also gets `--enable-auto-tool-choice` (Senju needs tool calls), `--enable-prefix-caching` and `--max-num-seqs 64`. vLLM accepts only `LLM_API_KEY` (Vast) or the `senju-vllm` Modal secret, so set a long random key.

## Example

```sh
# in .env
LLM_API_KEY=<any long random string>
SERVE_MODEL=<org>/<model>                 # the Hugging Face repo
SERVE_MAX_LEN=32768
SERVE_ARGS=--tool-call-parser <parser>    # plus --reasoning-parser <parser> for a reasoning model
```

Then follow `vast/README.md` (`offers`, `rent`, `env`) or `modal/README.md` (`deploy`). Pick the tool-call parser your model's card or the vLLM docs name; without the right one, tool calls come back as plain text.

**Speculative decoding** is just more flags in `SERVE_ARGS`, e.g. `--speculative-config '{"method": "ngram", "num_speculative_tokens": 4, "prompt_lookup_max": 4}'`, or a drafter model your model's vLLM recipe recommends.
