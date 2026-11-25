# Model endpoint notes

What `adapter/` expects from an OpenAI-compatible endpoint, and what probing real endpoints taught us. Probe any endpoint with `harness/probe.mjs` (`node --env-file=.env harness/probe.mjs <plain|tool|toolresult|reasoning|context N>`); it reads the same `LLM_*` settings as everything else and never prints the key.

## Endpoint

- `LLM_BASE_URL` is the OpenAI-style base (it ends in `/v1` for most servers). The adapter calls `POST {LLM_BASE_URL}/chat/completions`.
- `LLM_MODEL` is the name that endpoint expects: an API's model id, or vLLM's `--served-model-name`.
- `LLM_API_KEY` is sent as `Authorization: Bearer <key>`. Leave it empty for a local server that takes none; then no header is sent.
- Most hosted APIs and self-hosted inference servers speak this format. `tools/` can start vLLM on a rented GPU.
- Some endpoints refuse `max_tokens` and want `max_completion_tokens`. The adapter switches on the first refusal and remembers.
- One server has no provider routing, so the adapter sends no `provider` field unless given one (multi-provider routers accept one).

## Context limit

- Set `LLM_MAX_CONTEXT` to the endpoint's limit, so the adapter fails fast on a request that is clearly over it. If the server rejects one anyway, the adapter maps its "maximum context length" error to `stop_reason: "model_context_window_exceeded"`.
- **Latency grows with prompt size**, and with several workers on one endpoint. `context/` aims far below any cap: a 32k working budget per worker, as SPEC says.
- Token counts: endpoints return `usage.prompt_tokens` and `usage.completion_tokens`. Use these for real numbers. Use `countTokens` only for estimates before sending.

## Tool-call format

Standard OpenAI function calling. Sent as `tools: [{ type: "function", function: { name, description, parameters } }]`. A reply has `finish_reason: "tool_calls"` and:

```json
{
  "role": "assistant",
  "content": "I'll run a shell command to list /tmp.",
  "tool_calls": [
    { "type": "function", "id": "call_ba6de4d8154aa956",
      "function": { "name": "sh", "arguments": "{\"cmd\": \"ls -la /tmp\"}" } }
  ]
}
```

- `arguments` is a JSON **string**. Parse it, and send it to `guard.repair` if it fails to parse.
- `content` can hold a sentence of narration next to the tool call, or be `null`. Keep it as a text block before the `tool_use` blocks.
- Tool results go back as `{ role: "tool", tool_call_id, content: "<string>" }` after the assistant message carrying the `tool_calls`.
- Call ids differ by server. Treat them as opaque strings.
- Parallel calls happen: a lead may send two `spawn_agent` calls in one turn.
- Some servers say `finish_reason: "stop"` while returning tool calls. The adapter treats any reply with tool calls as `tool_use`.
- Self-hosted servers need tool calling turned on, and the right parser for the model (vLLM: `--enable-auto-tool-choice --tool-call-parser <name>`).

## Reasoning

- Reasoning models return their reasoning in `message.reasoning` or `message.reasoning_content`, or inline in `<think>` tags. The adapter drops all three.
- **Reasoning counts against `max_tokens`** on most servers. A tiny budget can be used up by reasoning and come back as `content: null, finish_reason: "length"`. The adapter never sends less than 1,024 (`minOutputTokens`), and maps `length` to `stop_reason: "max_tokens"`.
- Content often starts with `\n`. The adapter trims it.

## Images

- Off by default: each image in a tool result becomes the text `[image omitted]`, and the harness works from text (`eyes/`, `senju look`).
- `LLM_VISION=1` passes images through as `image_url` parts in a user message after the tool message, for models that accept them.

## What a first run showed

`node --env-file=.env harness/live-smoke.mjs` runs the real `Swarm` against the echo MCP server, with every call going through `adapter/` and `sched/`: two workers each shout a word, post it on the board, and the lead reports. On a self-hosted 65B open model:

- **Plumbing: 8 of 8 runs clean.** Every reply parsed, and tool calls and results round-tripped, at 1 to 3 s per call.
- **Behaviour: 5 of 8 runs did everything.** Twice the lead answered itself instead of spawning workers; once a worker reported without posting to the board.
- So the adapter is not the bottleneck; instruction following is. That is why `guard/` refuses a lead `end_turn` before it spawns anything, and reminds a worker that has not posted before `done`.
