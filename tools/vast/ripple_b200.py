#!/usr/bin/env python3
"""Ripple-65B on a rented Vast.ai B200: the same vLLM server as tools/modal (nightly, NVFP4, ripple parsers, DFlash2).

    python3 tools/vast/ripple_b200.py offers                 # cheapest single-B200 offers (read-only)
    python3 tools/vast/ripple_b200.py rent <offer-id>        # starts billing; prints the new instance id
    python3 tools/vast/ripple_b200.py status <instance>      # state, address, $/hr
    python3 tools/vast/ripple_b200.py env <instance>         # put its address in .env and app/.env (both git-ignored)
    python3 tools/vast/ripple_b200.py stop|start <instance>  # stop keeps the disk (storage ~$0.05/hr); the GPU can be taken meanwhile
    python3 tools/vast/ripple_b200.py destroy <instance>     # deletes it; billing ends

Keys stay out of the repo:
  VAST_API_KEY_FILE  your Vast key (default ~/.config/vastai-personal/vast_api_key). Check `whoami` before renting
                     so the bill goes to the account you mean.
  The server's API key is RIPPLE_API_KEY from .env (pick any long random string); vLLM accepts only that key.
"""
import json
import os
import pathlib
import sys
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[2]
API = "https://console.vast.ai/api/v0"
KEY_FILE = pathlib.Path(os.environ.get("VAST_API_KEY_FILE", "~/.config/vastai-personal/vast_api_key")).expanduser()
ENV_SOURCE = ROOT / os.environ.get("ENV_SOURCE", ".env")
ENV_OUTS = [ENV_SOURCE, ROOT / "app" / ".env"]

VLLM_ARGS = [
    "ricursiveAI/Ripple-65B-Preview-NVFP4",
    "--served-model-name", "ricursiveai/ripple-65b-preview",
    "--host", "0.0.0.0", "--port", "8000",
    "--tensor-parallel-size", "1",
    "--max-model-len", "131072",
    "--reasoning-parser", "ripple",
    "--enable-auto-tool-choice", "--tool-call-parser", "ripple",
    "--speculative-config", json.dumps({"method": "dflash", "model": "ricursiveAI/Ripple-65B-Preview-DFlash2", "num_speculative_tokens": 7}),
    "--enable-prefix-caching", "--max-num-seqs", "64",
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
    p = (i.get("ports") or {}).get("8000/tcp")
    ip = (i.get("public_ipaddr") or "").strip()
    return f"http://{ip}:{p[0]['HostPort']}/v1" if p and ip else None


def server_key():
    for line in ENV_SOURCE.read_text().splitlines():
        if line.startswith("RIPPLE_API_KEY="):
            return line.split("=", 1)[1].strip()
    sys.exit(f"no RIPPLE_API_KEY in {ENV_SOURCE}")


def main(cmd, arg=None):
    if cmd == "whoami":
        u = call("GET", "/users/current/")
        print({k: u.get(k) for k in ("id", "is_team", "credit") if k in u})
    elif cmd == "offers":
        d = call("POST", "/bundles/", {"gpu_name": {"eq": "B200"}, "rentable": {"eq": True}, "rented": {"eq": False},
                                        "num_gpus": {"eq": 1}, "order": [["dph_total", "asc"]], "type": "on-demand", "limit": 8})
        for o in d.get("offers", []):
            print(f"{o['id']}  ${o['dph_total']:.2f}/hr  {o.get('inet_down', 0):.0f} Mbps  {o.get('geolocation', '')}  reliability {o.get('reliability2', 0):.3f}")
    elif cmd == "rent":
        body = {"client_id": "me", "image": "vllm/vllm-openai:nightly", "disk": 200, "label": "ripple-b200",
                "runtype": "args", "args": VLLM_ARGS, "env": {"-p 8000:8000": "1", "VLLM_API_KEY": server_key()}}
        r = call("PUT", f"/asks/{arg}/", body)
        print({k: r.get(k) for k in ("success", "new_contract", "msg", "error", "http", "body") if r.get(k) is not None})
    elif cmd == "status":
        i = instance(arg)
        print(i.get("actual_status"), "->", i.get("intended_status"), f"${i.get('dph_total', 0):.2f}/hr", base_url(i) or "(no address yet)")
    elif cmd == "env":
        url = base_url(instance(arg))
        if not url:
            sys.exit("no address yet; is it running?")
        lines = [l for l in ENV_SOURCE.read_text().splitlines() if not l.startswith("RIPPLE_BASE_URL=")]
        text = "\n".join([f"RIPPLE_BASE_URL={url}", *lines]) + "\n"
        for out in ENV_OUTS:
            out.write_text(text)
            print(f"wrote {out.relative_to(ROOT)} -> {url}")
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
