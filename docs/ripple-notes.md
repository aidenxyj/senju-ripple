# Ripple endpoint notes

Probed 2026-11-13 with `harness/probe.mjs` (`node --env-file=.env harness/probe.mjs <plain|tool|toolresult|reasoning|context N>`). The tool-call and reasoning findings below were probed on a hosted copy of the same model before moving to the B200.

## Endpoint

- Ripple runs on a Vast.ai B200 with vLLM (`tools/vast/ripple_b200.py`): `RIPPLE_BASE_URL=http://<vast-ip>:<port>/v1`, OpenAI-style `POST /chat/completions`.
- `RIPPLE_MODEL=ricursiveai/ripple-65b-preview` (vLLM's `--served-model-name`).
- `RIPPLE_API_KEY` is the key the server was started with (`VLLM_API_KEY`). There is one server and no provider routing, so `adapter/` sends no `provider` field.
- vLLM runs with the `ripple` reasoning and tool-call parsers, prefix caching, and DFlash2 speculative decoding. A realistic worker turn takes 1.4 to 4.8 s, at about 125 output tokens/s (`tools/vast/README.md`).

## Context limit

- **Hard cap: 131,072 tokens**, vLLM's `--max-model-len` on the B200. Set `RIPPLE_MAX_CONTEXT=131072` so `adapter/` fails fast before sending a request that is clearly over it. If the server rejects one anyway, `adapter/` maps vLLM's "maximum context length" error to `stop_reason: "model_context_window_exceeded"`.
- **Latency grows with prompt size**, and four workers share one GPU. `context/` aims far below the cap: a 32k working budget per worker, with 16k still required to work, as SPEC says.
- Token counts: vLLM returns `usage.prompt_tokens` and `usage.completion_tokens`. Use these for real numbers. Use `countTokens` only for estimates before sending.

## Tool-call format

Standard OpenAI function calling. Sent as `tools: [{ type: "function", function: { name, description, parameters } }]`.

The reply has `finish_reason: "tool_calls"` and this message:

```json
{
  "role": "assistant",
  "content": "I'll run a shell command to enumerate /tmp and then tally the entries.",
  "tool_calls": [
    { "type": "function", "id": "chatcmpl-tool-ba6de4d8154aa956",
      "function": { "name": "sh", "arguments": "{\"cmd\": \"ls -la /tmp\"}" } }
  ]
}
```

- `arguments` is a JSON **string**. Parse it, and send it to `guard.repair` if it fails to parse.
- `content` can hold a sentence of narration next to the tool call (PrimeIntellect did this; GMICloud returned `null`). Keep it as a text block before the `tool_use` blocks.
- Tool results go back as `{ role: "tool", tool_call_id, content: "<string>" }` after an assistant message carrying the `tool_calls`. Ripple read a result correctly and answered from it.
- Call IDs differ by provider (`call_…` or `chatcmpl-tool-…`). Treat them as opaque strings.
- Parallel calls do happen: the lead sent two `spawn_agent` calls in one turn, and `board_read` + `wait` in another.
- The model picked `ls -la /tmp` and `ls -1 /tmp` without prompting: it does think in shell commands, which supports the `senju` shell plan.

## Reasoning format

- Reasoning comes back in `message.reasoning` (a string) and `message.reasoning_details: [{ type: "reasoning.text", text }]`. It never appeared inside `content`, and there were no `<think>` tags.
- With `reasoning: { enabled: true }`, Ripple thought briefly (15 tokens for `17 * 23`).
- **Reasoning counts against `max_tokens`.** A 20-token budget was used up by reasoning and the reply came back with `content: null, finish_reason: "length"`. Never send a tiny `max_tokens`. `adapter/` maps `length` to `stop_reason: "max_tokens"`.
- The `tool` probe used 338 completion tokens to make one short call, with `reasoning: null`. So the model may spend hidden tokens. Budget at least 1,000 output tokens per worker turn.
- Content often starts with `\n`. `adapter/` trims it.

## Other

- `finish_reason` values seen: `stop`, `tool_calls`, `length`.
- Cost is tiny: $0.10 per M input and $0.30 per M output. The 370k-token probe cost about $0.04.
- Supported params include `tool_choice`, `response_format`, `structured_outputs`, `reasoning`, `seed`, `stop`.

## Result: the Swarm on Ripple

`node --env-file=.env harness/live-smoke.mjs` runs the real `Swarm` against the echo MCP server, with every call going through `adapter/` and `sched/`. The goal: two workers each shout a word, post it on the board, and the lead reports.

- **Plumbing: 8 of 8 runs clean.** No errors, every reply parsed, and tool calls and results round-tripped. Each run took 8 to 16 calls in 13 to 36 s, mostly 1 to 3 s per call.
- **Behaviour: 5 of 8 runs did everything.** Twice the lead answered "HELLO WORLD" itself instead of spawning workers. Once a worker reported without posting to the board.
- So the adapter is not the bottleneck. Instruction following is, as SPEC predicted. Ideas for `guard/` and the harness: refuse a lead `end_turn` before it spawns anything, and remind a worker that hasn't posted to the board before `done`.
