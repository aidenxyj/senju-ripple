# Self-hosted model on a rented Vast.ai GPU

`serve.py` rents a GPU on Vast.ai and starts a vLLM server on it for whatever model `SERVE_MODEL` names (settings: `tools/README.md`). It typically answers a few minutes after renting: the container starts, then the weights download, load and compile, so bigger models take longer.

On a dedicated GPU, a worker turn is usually faster and steadier than on a shared hosted API (no rate limits, low time to first token, and prefix caching for Senju's long repeated prompts). Measure your own setup with `node --env-file=.env tools/modal/bench.mjs`.

## Use it

```sh
python3 tools/vast/serve.py whoami          # check this is the account you want to bill (VAST_API_KEY_FILE)
python3 tools/vast/serve.py offers          # cheapest offers for SERVE_GPU (default one B200); pick one
python3 tools/vast/serve.py rent <offer>    # billing starts now; prints the vLLM command and the instance id
python3 tools/vast/serve.py status <inst>   # wait for "running" and an address
python3 tools/vast/serve.py env <inst>      # writes LLM_BASE_URL and LLM_MODEL into .env and app/.env

node --env-file=.env tools/modal/bench.mjs  # ready and fast?
npm run app                                 # the whole app on it
```

Before `rent`, set in `.env` (or the environment):

- `SERVE_MODEL` (the Hugging Face repo), and usually `SERVE_ARGS` with the model's parsers (`--tool-call-parser <parser>`). `rent` refuses to run without `SERVE_MODEL`.
- `LLM_API_KEY`: any long random string. vLLM accepts only that key, and the server is on the public internet.
- `HF_TOKEN` only for gated Hugging Face repos; it is passed to the container.

Your Vast key is read from `~/.config/vastai-personal/vast_api_key` (or `VAST_API_KEY_FILE`). Logs: the Vast console, under the instance.

## Billing: read this

- **Vast bills from the moment you rent until you destroy the instance,** whether or not it's in use.
- **`destroy <inst>`** deletes it and ends billing. Confirm it's gone with `status` or the Vast console.
- **`stop`** ends GPU billing but keeps the disk, for about $0.05/hr. While it's stopped, someone else can rent that GPU, and then `start` fails with `resources_unavailable` and waits in a queue. If you need it again soon, keep it running. Otherwise `destroy` it and rent again later.
- **Don't** use a team account's key for personal experiments. `whoami` shows `is_team`.
