# Ripple-65B Preview on Modal with vLLM: an OpenAI-style endpoint that adapter/ can use in place of the Vast B200.
#
#   modal secret create ripple-vllm VLLM_API_KEY=<random>     # once; this becomes RIPPLE_API_KEY
#   modal deploy tools/modal/ripple_vllm.py                   # prints the URL; RIPPLE_BASE_URL=<url>/v1
#
# Default one B200 (RIPPLE_GPU, see below); BF16 weights quantized to FP8 at load (~65 GB),
# and the DFlash2 drafter for speculative decoding (recipe: recipes.vllm.ai/ricursiveAI).
# Served as "ricursiveai/ripple-65b-preview", so RIPPLE_MODEL stays the same. It scales to zero when idle.
import os
import subprocess

import modal

# Which GPUs, chosen at deploy time: RIPPLE_GPU=B200 (default), B200:2, H100:2 ...
# One B200 (192 GB) holds the FP8 weights (~65 GB) with plenty of KV cache and needs no tensor parallel,
# which is the fastest setup for many short agent turns. Each GPU type deploys as its own app.
GPU = os.environ.get("RIPPLE_GPU", "B200")
GPU_COUNT = int(GPU.split(":")[1]) if ":" in GPU else 1
APP_NAME = "ripple-vllm" if GPU == "H100:2" else f"ripple-vllm-{GPU.split(':')[0].lower()}" + ("" if GPU_COUNT == 1 else f"-x{GPU_COUNT}")

# Blackwell (B200/B300) runs the official NVFP4 checkpoint (~69 GB, fits one GPU). Older GPUs load the BF16
# checkpoint (~156 GB) and quantize it to FP8. Recipe: recipes.vllm.ai/ricursiveAI/Ripple-65B-Preview.
BLACKWELL = GPU.split(":")[0].upper() in ("B200", "B300")
MODEL = "ricursiveAI/Ripple-65B-Preview-NVFP4" if BLACKWELL else "ricursiveAI/Ripple-65B-Preview"
DRAFTER = "ricursiveAI/Ripple-65B-Preview-DFlash2"
SERVED_NAME = "ricursiveai/ripple-65b-preview"
MAX_MODEL_LEN = 131072  # the harness budgets 32k per call; more only costs KV memory and startup time
PORT = 8000

image = (
    # The "ripple" tool-call and reasoning parsers come from vLLM PR #65745; the recipe uses nightly builds,
    # and the 0.33 release on PyPI does not have them ("invalid tool call parser: ripple").
    modal.Image.from_registry("vllm/vllm-openai:nightly")
    .entrypoint([])
    # Modal looks for `python`; the vLLM image only ships python3.
    .run_commands("ln -sf $(command -v python3) /usr/local/bin/python", "python -m pip install -q -U huggingface_hub")
    # RIPPLE_GPU is baked in, so the container (which re-imports this file) uses the same GPU count.
    .env({"RIPPLE_GPU": GPU, "HF_HOME": "/cache/hf", "VLLM_CACHE_ROOT": "/cache/vllm"})
)

cache = modal.Volume.from_name("ripple-cache", create_if_missing=True)
app = modal.App(APP_NAME)


@app.function(image=image, volumes={"/cache": cache}, secrets=[modal.Secret.from_name("huggingface")], timeout=60 * 60)
def download():
    """Pre-fetch weights into the volume (optional; the server also downloads on first start)."""
    from huggingface_hub import snapshot_download

    for repo in (MODEL, DRAFTER):
        snapshot_download(repo)
    cache.commit()


@app.function(image=image, timeout=10 * 60)
def check_image():
    """CPU only: the vLLM version in the image, and whether it has the ripple parsers. Run before paying for GPUs."""
    import os as _os
    import subprocess as sp

    import vllm

    root = _os.path.dirname(vllm.__file__)
    hits = sp.run(["grep", "-rlE", "--include=*.py", r"""(register_module|register_lazy_module)\(\s*\[?\s*["']ripple["']|["']ripple["']\s*:""", root],
                  capture_output=True, text=True).stdout.split()
    hits = [h[len(root) + 1:] for h in hits]
    return {"vllm": vllm.__version__, "ripple_tool_parser": any("tool" in h for h in hits), "ripple_reasoning_parser": any("reasoning" in h for h in hits), "files": hits}


@app.function(
    image=image,
    gpu=GPU,
    volumes={"/cache": cache},
    secrets=[modal.Secret.from_name("huggingface"), modal.Secret.from_name("ripple-vllm")],
    scaledown_window=15 * 60,
    timeout=24 * 60 * 60,
    max_containers=1,
)
@modal.concurrent(max_inputs=64)
@modal.web_server(port=PORT, startup_timeout=40 * 60)
def serve():
    import json

    cmd = [
        "vllm", "serve", MODEL,
        "--served-model-name", SERVED_NAME,
        "--host", "0.0.0.0", "--port", str(PORT),
        "--tensor-parallel-size", str(GPU_COUNT),
        *([] if BLACKWELL else ["--quantization", "fp8"]),
        "--max-model-len", str(MAX_MODEL_LEN),
        "--reasoning-parser", "ripple",
        "--enable-auto-tool-choice", "--tool-call-parser", "ripple",
        "--speculative-config", json.dumps({"method": "dflash", "model": DRAFTER, "num_speculative_tokens": 7}),
        "--enable-prefix-caching",
        "--max-num-seqs", "64",
    ]
    # vLLM reads VLLM_API_KEY from the ripple-vllm secret and rejects requests without it.
    proc = subprocess.Popen(cmd)

    # If vLLM dies (bad flag, out of memory), end the container at once instead of holding a GPU until
    # startup_timeout. Modal then reports the failure to the caller.
    import os as _os
    import threading

    def watch():
        code = proc.wait()
        print(f"vllm exited with code {code}; stopping the container", flush=True)
        _os._exit(1)

    threading.Thread(target=watch, daemon=True).start()


@app.local_entrypoint()
def check():
    """modal run tools/modal/ripple_vllm.py::check  -> the image's vLLM version and whether it has the ripple parsers."""
    print(check_image.remote())
