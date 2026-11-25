#!/usr/bin/env python3
"""Self-host any open model with vLLM on a rented Vast.ai GPU, as an OpenAI-compatible endpoint for Senju.

    python3 tools/vast/serve.py whoami                 # which Vast account the key bills (read-only)
    python3 tools/vast/serve.py offers                 # cheapest offers for SERVE_GPU (read-only)
    python3 tools/vast/serve.py rent <offer-id>        # starts billing; prints the new instance id
    python3 tools/vast/serve.py status <instance>      # state, address, $/hr
    python3 tools/vast/serve.py env <instance>         # put LLM_BASE_URL and LLM_MODEL in .env and app/.env
    python3 tools/vast/serve.py stop|start <instance>  # stop keeps the disk (storage ~$0.05/hr); the GPU can be taken meanwhile
    python3 tools/vast/serve.py destroy <instance>     # deletes it; billing ends

What to serve (process env, else the repo .env):
  SERVE_MODEL     Hugging Face repo to serve, <org>/<model> (required for rent)
  SERVE_NAME      served model name, what LLM_MODEL becomes (default: SERVE_MODEL)
  SERVE_MAX_LEN   --max-model-len (default 131072)
  SERVE_ARGS      extra vLLM flags as one string, e.g. "--tool-call-parser <parser>";
                  speculative decoding and quantization go here too (--speculative-config '{...}', --quantization fp8)
  SERVE_GPU       Vast GPU name and count, e.g. B200, H100 SXM, "H100 SXM:2" (default B200)
  SERVE_IMAGE     Docker image (default vllm/vllm-openai:latest)
  SERVE_DISK      disk in GB (default 200; must hold the weights)

Keys stay out of the repo:
  VAST_API_KEY_FILE  your Vast key (default ~/.config/vastai-personal/vast_api_key). Check `whoami` before renting
                     so the bill goes to the account you mean.
  The server's API key is LLM_API_KEY from .env (pick any long random string); vLLM accepts only that key.
"""
import json
import os
import pathlib
import shlex
import sys
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[2]
API = "https://console.vast.ai/api/v0"
KEY_FILE = pathlib.Path(os.environ.get("VAST_API_KEY_FILE", "~/.config/vastai-personal/vast_api_key")).expanduser()
ENV_SOURCE = ROOT / os.environ.get("ENV_SOURCE", ".env")
ENV_OUTS = [ENV_SOURCE, ROOT / "app" / ".env"]
PORT = 8000


def dotenv(path=ENV_SOURCE):
    """KEY=value lines of an env file (quotes stripped); {} if it does not exist."""
    out = {}
    if path.exists():
        for line in path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                v = v.strip()
                if len(v) >= 2 and v[0] == v[-1] and v[0] in "'\"":
                    v = v[1:-1]
                out[k.strip()] = v
    return out


FILE_ENV = dotenv()


def setting(name, default=""):
    v = os.environ.get(name)
    if v is None:
        v = FILE_ENV.get(name, "")
    return v.strip() or default


GPU = setting("SERVE_GPU", "B200")
GPU_NAME, _, GPU_COUNT = GPU.partition(":")
GPU_COUNT = int(GPU_COUNT or 1)


def served_name():
    return setting("SERVE_NAME", setting("SERVE_MODEL"))


def vllm_args():
    model = setting("SERVE_MODEL")
    if not model:
        sys.exit("SERVE_MODEL is not set: put the Hugging Face repo to serve (SERVE_MODEL=<org>/<model>) "
                 "in .env or the environment. See tools/README.md.")
    return [
        model,
        "--served-model-name", served_name(),
        "--host", "0.0.0.0", "--port", str(PORT),
        "--tensor-parallel-size", str(GPU_COUNT),
        "--max-model-len", setting("SERVE_MAX_LEN", "131072"),
        "--enable-auto-tool-choice",  # needed for tool calls; pick the model's parser with --tool-call-parser in SERVE_ARGS
        "--enable-prefix-caching", "--max-num-seqs", "64",
        *shlex.split(setting("SERVE_ARGS")),
    ]


def call(method, path, body=None):
    req = urllib.request.Request(API + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"Authorization": "Bearer " + KEY_FILE.read_text().strip(), "content-type": "application/json"})
    try:
        return json.loads(urllib.request.urlopen(req, timeout=60).read().decode(), strict=False)
    except urllib.error.HTTPError as e:
        return {"success": False, "http": e.code, "body": e.read().decode()[:300]}


def instance(iid):
    d = call("GET", f"/instances/{iid}/")
    i = d.get("instances", d)
    return i[0] if isinstance(i, list) and i else i


def base_url(i):
    p = (i.get("ports") or {}).get(f"{PORT}/tcp")
    ip = (i.get("public_ipaddr") or "").strip()
    return f"http://{ip}:{p[0]['HostPort']}/v1" if p and ip else None


def server_key():
    # An older .env may still have the key under the product's pre-rename prefix (also read by adapter/).
    key = setting("LLM_API_KEY")
    if not key:
        sys.exit(f"no LLM_API_KEY in {ENV_SOURCE} or the environment: set it to any long random string first; "
                 "the server accepts only that key")
    return key


def set_env_lines(path, values):
    """Replace KEY= lines in place (or prepend them), leaving every other line alone."""
    lines = path.read_text().splitlines() if path.exists() else []
    todo = dict(values)
    for n, line in enumerate(lines):
        k = line.split("=", 1)[0].strip()
        if "=" in line and k in todo:
            lines[n] = f"{k}={todo.pop(k)}"
    lines = [f"{k}={v}" for k, v in todo.items()] + lines
    path.write_text("\n".join(lines) + "\n")


def main(cmd, arg=None):
    if cmd == "whoami":
        u = call("GET", "/users/current/")
        print({k: u.get(k) for k in ("id", "is_team", "credit") if k in u})
    elif cmd == "offers":
        d = call("POST", "/bundles/", {"gpu_name": {"eq": GPU_NAME}, "rentable": {"eq": True}, "rented": {"eq": False},
                                        "num_gpus": {"eq": GPU_COUNT}, "order": [["dph_total", "asc"]], "type": "on-demand", "limit": 8})
        for o in d.get("offers", []):
            print(f"{o['id']}  ${o['dph_total']:.2f}/hr  {o.get('inet_down', 0):.0f} Mbps  {o.get('geolocation', '')}  reliability {o.get('reliability2', 0):.3f}")
        if not d.get("offers"):
            print(f"no offers for {GPU_COUNT}x {GPU_NAME!r} (SERVE_GPU); response: {str(d)[:300]}")
    elif cmd == "rent":
        args, key = vllm_args(), server_key()  # both checked before any API call
        body = {"client_id": "me", "image": setting("SERVE_IMAGE", "vllm/vllm-openai:latest"), "disk": int(setting("SERVE_DISK", "200")),
                "label": "senju-vllm", "runtype": "args", "args": args, "env": {f"-p {PORT}:{PORT}": "1", "VLLM_API_KEY": key}}
        hf = setting("HF_TOKEN")
        if hf:
            body["env"]["HF_TOKEN"] = hf  # for gated repos
        print("serving:", shlex.join(args))
        r = call("PUT", f"/asks/{arg}/", body)
        print({k: r.get(k) for k in ("success", "new_contract", "msg", "error", "http", "body") if r.get(k) is not None})
    elif cmd == "status":
        i = instance(arg)
        print(i.get("actual_status"), "->", i.get("intended_status"), f"${i.get('dph_total', 0):.2f}/hr", base_url(i) or "(no address yet)")
    elif cmd == "env":
        url = base_url(instance(arg))
        if not url:
            sys.exit("no address yet; is it running?")
        values = {"LLM_BASE_URL": url}
        if served_name():
            values["LLM_MODEL"] = served_name()
        else:
            print("SERVE_MODEL/SERVE_NAME not set, so LLM_MODEL is left as it is")
        for out in ENV_OUTS:
            set_env_lines(out, values)
            print(f"wrote {out.relative_to(ROOT)} -> {values}")
    elif cmd in ("stop", "start"):
        print(call("PUT", f"/instances/{arg}/", {"state": "stopped" if cmd == "stop" else "running"}))
    elif cmd == "destroy":
        print(call("DELETE", f"/instances/{arg}/"))
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    if len(sys.argv) < 2 or (sys.argv[1] not in ("offers", "whoami") and len(sys.argv) < 3):
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None)
