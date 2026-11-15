# context/

Keeps one conversation inside a token budget. Zero dependencies, Node 20+.

```js
import { fit, countTokens } from '../context/index.js';

const messages2 = fit(messages, { maxTokens: 32000 });               // contract form: counts messages only
const messages3 = fit(messages, { maxTokens: 32000, system, tools }); // also counts system + tools against the budget
```

Messages are the swarm engine's Messages shape: `{ role, content }`, where `content` is a string or an array of `text`, `image`, `tool_use { id, name, input }` and `tool_result { tool_use_id, content, is_error }` blocks.

## What `fit` does

It returns the input unchanged (a new array holding the same message objects) when the conversation already fits. Otherwise it works in three stages and stops as soon as the estimate fits:

1. **Trim old observations.** Old `tool_result` contents become `[old observation trimmed] <first line>`, for example `... ok` or `... error: no element e4`. `is_error` is kept. It trims the oldest first and keeps the newest `keepToolResults` (default 4) whole for as long as it can. Old images are replaced too.
2. **Summarise.** The oldest middle messages collapse into one summary block, `[context summary] ...`. It is appended to the goal message, after the goal text. The summary is extractive and deterministic, with no model call. It has one line per step (`- sh senju click e12 -> ok`), what the agent said, and every user or lead message. It is capped at 15% of `maxTokens` (clamped to 300..4000, set with `summaryTokens`), and the oldest lines are dropped first. If a fitted list is fitted again, the old summary lines carry forward, so summaries never nest.
3. **Truncate.** This stage runs only if the goal plus the newest turn are still over budget. It cuts the middle out of the longest texts, keeping 2/3 head and 1/3 tail plus a `[... N chars trimmed ...]` marker. The order is: the summary, then the newest turn's observations (largest first), then its other text, then the goal (whose start is always kept). It never throws for being too big.

Guarantees:

- The system prompt is never edited. The goal (the first user message's content) stays first, word for word.
- The newest turn is kept: the last message, plus the assistant `tool_use` message it answers. Stage 3 is the only stage that can shorten it.
- A `tool_use` and its `tool_result` are kept or summarised together. The output alternates user/assistant, and every `tool_result` answers a `tool_use` in the message just before it (see `checkMessages`).
- The output is ≤ `maxTokens` by the estimate whenever that is possible. It is not possible only when `system` + `tools` alone are too big. Then `fitReport(...).fits` is `false`.
- It is pure. The input is never mutated. Running it again on output that already fits returns the same messages.

You can keep the full history and call `fit` before every model call, which is deterministic. Or you can store its output and keep appending. Both work.

## API

| Export | |
|---|---|
| `fit(messages, { maxTokens, system?, tools?, keepToolResults?, summaryTokens? }) -> messages` | the contract |
| `countTokens(text) -> number` | estimate fitted to Ripple's real `usage.prompt_tokens`: per class weights for whitespace runs, digits and punctuation (see `WEIGHTS` in `tokens.js`), times `SAFETY` 1.2. It errs high: snapshots ~5% over, prose ~25% over. Live check: a transcript fit to 16k came back as 13.7k real tokens. Real counts come back as `usage` |
| `countMessages(messages, { system?, tools? }) -> number` | estimate for a whole request; `countMessage`, `countContent`, `countBlock` for parts |
| `fitReport(messages, opts) -> { messages, tokens, fits, trimmed, summarized, truncated, summary }` | `fit` plus what it did, for traces |
| `fitAsync(messages, { ...opts, summarize })` | same as `fit`, but asks `summarize(transcript) -> Promise<string>` (for example a cheap model call) for the summary text. Falls back to the extractive summary if it throws or does not fit |
| `checkMessages(messages) -> string[]` | problems with alternation or tool pairing; empty when valid |
| `truncateText(text, maxTokens)` | the head/tail cut used in stage 3 |

Budget note: `maxTokens` is what the prompt may use. Leave room for the reply. Reasoning counts against `max_tokens` on Ripple (docs/ripple-notes.md). For example, use `fit(messages, { maxTokens: 32000 - 4000, system, tools })`.

## Tests

```sh
node --test context/test/*.test.mjs
```

They use synthetic worker transcripts (`test/transcripts.mjs`): 10 to 500 `sh` steps with page dumps of 2 to 8k chars, errors, two calls in one turn, lead messages, images and cut-off replies. They run at 16k and 32k and check every guarantee above.
