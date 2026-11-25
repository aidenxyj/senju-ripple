# Self-host any open model with vLLM on Modal: an OpenAI-compatible endpoint for Senju (an alternative to tools/vast).
#
#   modal secret create senju-vllm VLLM_API_KEY=<random>     # once; use the same value as LLM_API_KEY
#   SERVE_MODEL=<org>/<model> modal deploy tools/modal/serve.py   # prints the URL; LLM_BASE_URL=<url>/v1
#
# Settings come from the environment at deploy time, else the repo .env (see tools/README.md):
#   SERVE_MODEL (required), SERVE_NAME (default SERVE_MODEL), SERVE_MAX_LEN (default 131072),
#   SERVE_ARGS (extra vLLM flags as one string: parsers, --speculative-config, --quantization ...),
#   SERVE_GPU (default B200; e.g. H100:2), SERVE_IMAGE (default vllm/vllm-openai:latest).
# They are baked into the image, so the container (which re-imports this file) sees the same values.
# It scales to zero when idle.
import os
import pathlib
import shlex
import subprocess
import sys

import modal


def _dotenv():
    path = pathlib.Path(__file__).resolve().parents[2] / ".env"
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


_FILE_ENV = _dotenv()


def setting(name, default=""):
    v = os.environ.get(name)
    if v is None:
        v = _FILE_ENV.get(name, "")
    return v.strip() or default


MODEL = setting("SERVE_MODEL")
SERVED_NAME = setting("SERVE_NAME", MODEL)
MAX_MODEL_LEN = setting("SERVE_MAX_LEN", "131072")
EXTRA_ARGS = setting("SERVE_ARGS")
# Which GPUs: SERVE_GPU=B200 (default), B200:2, H100:2 ... Each GPU type deploys as its own app.
GPU = setting("SERVE_GPU", "B200")
GPU_COUNT = int(GPU.split(":")[1]) if ":" in GPU else 1
APP_NAME = f"senju-vllm-{GPU.split(':')[0].lower()}" + ("" if GPU_COUNT == 1 else f"-x{GPU_COUNT}")
PORT = 8000

image = (
    modal.Image.from_registry(setting("SERVE_IMAGE", "vllm/vllm-openai:latest"))
    .entrypoint([])
    # Modal looks for `python`; the vLLM image only ships python3.
    .run_commands("ln -sf $(command -v python3) /usr/local/bin/python", "python -m pip install -q -U huggingface_hub")
    .env({"SERVE_MODEL": MODEL, "SERVE_NAME": SERVED_NAME, "SERVE_MAX_LEN": MAX_MODEL_LEN, "SERVE_ARGS": EXTRA_ARGS,
          "SERVE_GPU": GPU, "HF_HOME": "/cache/hf", "VLLM_CACHE_ROOT": "/cache/vllm"})
)

cache = modal.Volume.from_name("senju-vllm-cache", create_if_missing=True)
app = modal.App(APP_NAME)


def _require_model():
    if not MODEL:
        raise SystemExit("SERVE_MODEL is not set: put the Hugging Face repo to serve (SERVE_MODEL=<org>/<model>) "
                         "in .env or the environment. See tools/README.md.")


# Refuse to deploy (or download) nothing: fail on the laptop, before Modal builds anything or assigns a GPU.
# `modal run tools/modal/serve.py::check` still works without a model.
if modal.is_local() and not MODEL and not any(a.endswith("::check") for a in sys.argv):
    _require_model()


@app.function(image=image, volumes={"/cache": cache}, secrets=[modal.Secret.from_name("huggingface")], timeout=60 * 60)
def download():
    """Pre-fetch weights into the volume (optional; the server also downloads on first start).
    A speculative-decoding drafter named in SERVE_ARGS is downloaded by vLLM on first start."""
    from huggingface_hub import snapshot_download

    _require_model()
    snapshot_download(MODEL)
    cache.commit()


@app.function(image=image, timeout=10 * 60)
def check_image():
    """CPU only: the vLLM version in the image. Run before paying for GPUs."""
    import vllm

    return {"vllm": vllm.__version__, "model": MODEL or "(SERVE_MODEL not set)", "gpu": GPU}


@app.function(
    image=image,
    gpu=GPU,
    volumes={"/cache": cache},
    secrets=[modal.Secret.from_name("huggingface"), modal.Secret.from_name("senju-vllm")],
    scaledown_window=15 * 60,
    timeout=24 * 60 * 60,
    max_containers=1,
)
@modal.concurrent(max_inputs=64)
@modal.web_server(port=PORT, startup_timeout=40 * 60)
def serve():
    _require_model()
    cmd = [
        "vllm", "serve", MODEL,
        "--served-model-name", SERVED_NAME,
        "--host", "0.0.0.0", "--port", str(PORT),
        "--tensor-parallel-size", str(GPU_COUNT),
        "--max-model-len", MAX_MODEL_LEN,
        "--enable-auto-tool-choice",  # needed for tool calls; pick the model's parser with --tool-call-parser in SERVE_ARGS
        "--enable-prefix-caching",
        "--max-num-seqs", "64",
        *shlex.split(EXTRA_ARGS),
    ]
    print("serving:", shlex.join(cmd), flush=True)
    # vLLM reads VLLM_API_KEY from the senju-vllm secret and rejects requests without it.
    proc = subprocess.Popen(cmd)

    # If vLLM dies (bad flag, out of memory), end the container at once instead of holding a GPU until
    # startup_timeout. Modal then reports the failure to the caller.
    import threading

    def watch():
        code = proc.wait()
        print(f"vllm exited with code {code}; stopping the container", flush=True)
        os._exit(1)

    threading.Thread(target=watch, daemon=True).start()


@app.local_entrypoint()
def check():
    """modal run tools/modal/serve.py::check  -> the image's vLLM version (CPU only)."""
    print(check_image.remote())
