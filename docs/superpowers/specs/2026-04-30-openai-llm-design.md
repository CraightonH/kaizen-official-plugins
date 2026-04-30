# `openai-llm` Plugin — Design (Spec 1)

**Status:** draft
**Date:** 2026-04-30
**Scope:** Tier 1. Single plugin `openai-llm`. Provides the `llm:complete` service against any OpenAI-compatible HTTP endpoint (OpenAI, LM Studio, vLLM, Together, Groq, Ollama with `/v1` shim). Reads its own configuration. Owns retry, streaming SSE parsing, and abort handling. Depends on Spec 0 contracts only.

## Goal

Implement a single, swappable provider plugin that satisfies the `LLMCompleteService` interface defined in Spec 0. It is the only plugin in the ecosystem that knows the OpenAI wire protocol; future Anthropic/Bedrock/Ollama-native plugins satisfy the same service interface and replace this plugin without touching anything else.

## Non-goals

- Tool execution. This plugin emits `tool-call` stream events only; dispatch is owned by Tier 2 strategy plugins.
- Conversation/turn-loop logic. Owned by `llm-driver` (Spec 2).
- Mutating `LLMRequest` for memory/skill injection. Subscribers to `llm:before-call` (Spec 0) do that *before* the driver calls `complete`.
- Anthropic, Bedrock, Ollama-native, or any non-OpenAI wire protocol.
- A request-level cache. Caching/observability are added later via event subscribers.
- UI surface. Status updates, if any, go through the `status:item-update` event vocabulary already defined in Spec 0.

## Plugin shape

Structural twin of `plugins/claude-events/index.ts`:

```ts
const plugin: KaizenPlugin = {
  name: "openai-llm",
  apiVersion: "3.0.0",
  permissions: { tier: "trusted" },          // makes outbound HTTP
  services: { provides: ["llm:complete"] },
  async setup(ctx) {
    const config = await loadConfig(ctx);    // see "Configuration"
    ctx.defineService("llm:complete", { description: "..." });
    ctx.provideService<LLMCompleteService>("llm:complete", makeService(config, ctx));
  },
};
```

`permissions.tier: "trusted"` is required because the plugin opens arbitrary outbound TCP connections (default localhost, but the user may point it anywhere). Restricted-tier sandboxing would block that.

## Configuration

### Location

`~/.kaizen/openai-llm/config.json`. The plugin reads its own config (microservice ownership — no global config service). Path resolution rules:

1. `KAIZEN_OPENAI_LLM_CONFIG` env var (absolute path) wins if set.
2. Otherwise `${process.env.HOME}/.kaizen/openai-llm/config.json`.
3. If the file does not exist, the plugin uses defaults and logs (via `ctx.log`) the path it would have read so the user can create it.
4. Malformed JSON is a hard failure during `setup` — do not silently fall back.

### Schema

```jsonc
{
  "baseUrl": "http://localhost:1234/v1",  // LM Studio default; OpenAI is "https://api.openai.com/v1"
  "apiKey": "lm-studio",                   // optional; sent as `Authorization: Bearer ...` if non-empty
  "apiKeyEnv": "OPENAI_API_KEY",           // optional; if set, value of this env var overrides `apiKey`
  "defaultModel": "local-model",           // used when LLMRequest.model is the empty string
  "defaultTemperature": 0.7,               // used when LLMRequest.temperature is undefined
  "requestTimeoutMs": 120000,              // per-attempt; covers headers + entire stream
  "connectTimeoutMs": 10000,               // headers/first-byte deadline; separate from requestTimeoutMs
  "retry": {
    "maxAttempts": 3,                      // 1 = no retry
    "initialDelayMs": 500,
    "maxDelayMs": 8000,
    "jitter": "full"                       // "full" | "none"
  },
  "extraHeaders": {                        // merged into every request; useful for OpenAI-Beta, x-api-version, etc.
    "OpenAI-Beta": "..."
  }
}
```

### Defaults

If the config file is absent, defaults match LM Studio:

- `baseUrl = "http://localhost:1234/v1"`
- `apiKey = ""` (no Authorization header sent)
- `defaultModel = "local-model"`
- `defaultTemperature = 0.7`
- `requestTimeoutMs = 120000`
- `connectTimeoutMs = 10000`
- `retry = { maxAttempts: 3, initialDelayMs: 500, maxDelayMs: 8000, jitter: "full" }`
- `extraHeaders = {}`

`apiKeyEnv` is recommended for OpenAI usage; it allows the user to commit a config file to dotfiles without leaking the key.

## `complete()` implementation contract

Signature (from Spec 0):

```ts
complete(req: LLMRequest, opts: { signal: AbortSignal }): AsyncIterable<LLMStreamEvent>
```

### Wire request construction

POST `${baseUrl}/chat/completions`. Body is JSON:

```jsonc
{
  "model": req.model || config.defaultModel,
  "messages": [
    // If req.systemPrompt is set, prepend { "role": "system", "content": req.systemPrompt }
    // (only if no message with role:"system" already exists at index 0).
    ...mapMessages(req.messages)
  ],
  "stream": true,
  "stream_options": { "include_usage": true },  // requests trailing usage chunk
  "temperature": req.temperature ?? config.defaultTemperature,
  "max_tokens": req.maxTokens,                  // omit field if undefined
  "stop": req.stop,                              // omit if undefined or empty
  "tools": mapTools(req.tools),                  // omit if undefined or empty
  ...req.extra                                   // shallow merge, last-wins; provider-specific extensions
}
```

`req.extra` is shallow-merged AFTER the standard fields so callers can override (e.g., `top_p`, `seed`, `response_format`, `logit_bias`, vendor-specific knobs). Document this precedence in the `public.d.ts` JSDoc on `LLMRequest.extra` so callers know `extra` wins.

### Headers

- `Content-Type: application/json`
- `Accept: text/event-stream`
- `Authorization: Bearer <key>` if `apiKey` (after env override) is non-empty
- `User-Agent: kaizen-openai-llm/<version>`
- All entries from `config.extraHeaders` (merged last; user override wins).

### Message mapping (`mapMessages`)

`ChatMessage` (Spec 0) → OpenAI message object:

| ChatMessage | OpenAI shape |
|---|---|
| `{ role: "system", content }` | `{ role: "system", content }` |
| `{ role: "user", content }` | `{ role: "user", content }` |
| `{ role: "assistant", content, toolCalls? }` | `{ role: "assistant", content, tool_calls?: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] }` |
| `{ role: "tool", content, toolCallId, name }` | `{ role: "tool", content, tool_call_id, name }` |

`ToolCall.arguments` is already-parsed (Spec 0). On the way out, re-stringify to satisfy OpenAI's `arguments: string` field. On the way *in* (streaming), parse before emitting (see "Tool-call accumulation").

### Tool mapping (`mapTools`)

`ToolSchema` (Spec 0) → OpenAI `tools` entry:

```jsonc
{
  "type": "function",
  "function": {
    "name": schema.name,
    "description": schema.description,
    "parameters": schema.parameters     // JSONSchema7, passed through verbatim
  }
}
```

`ToolSchema.tags` is **not** sent — it's a registry-side filter, not part of the wire protocol.

If `req.tools` is non-empty, also set `tool_choice: "auto"` unless `req.extra.tool_choice` overrides it.

## SSE streaming parser

The HTTP body is `text/event-stream`. Frames are `\n\n`-delimited. Within a frame, lines starting with `data: ` carry the payload. The terminal frame is `data: [DONE]`.

### Byte-level reader

Following the pattern in `plugins/claude-driver/spawn.ts` (`async function* lines()`):

1. Read the `Response.body` `ReadableStream` as bytes.
2. Decode with a stateful `TextDecoder({ fatal: false, ignoreBOM: false }, { stream: true })` — never `String(chunk)`; that breaks on multibyte UTF-8 codepoints split across chunks.
3. Split on `\n\n` to get frames; carry a residual buffer.
4. For each frame, split on `\n`; for each line starting with `data:`, take the suffix (lstrip exactly one space).
5. If the suffix is `[DONE]`, end the stream.
6. Otherwise `JSON.parse` the suffix. On parse error, emit an `{ type: "error", message: "malformed SSE data", cause }` event and terminate (do NOT continue — a malformed frame likely means the framing is desynced).

Ignore non-`data:` lines (`event:`, `id:`, `retry:`, comments starting with `:`). LM Studio sometimes emits `: keep-alive` comment frames.

### Delta interpretation

Each successfully-parsed frame is an OpenAI chunk:

```jsonc
{
  "id": "chatcmpl-...",
  "object": "chat.completion.chunk",
  "created": 1700000000,
  "model": "...",
  "choices": [
    {
      "index": 0,
      "delta": {
        "role": "assistant",            // first chunk only, usually
        "content": "string fragment",   // optional
        "tool_calls": [                 // optional, fragmented (see below)
          {
            "index": 0,
            "id": "call_abc",           // appears once, on first fragment for this index
            "type": "function",         // appears once
            "function": {
              "name": "get_w",          // pieces; concatenate across fragments
              "arguments": "{\"loc"     // pieces of a JSON string; concatenate
            }
          }
        ]
      },
      "finish_reason": null | "stop" | "length" | "tool_calls" | "content_filter"
    }
  ],
  "usage": null | { "prompt_tokens": N, "completion_tokens": N, "total_tokens": N }
}
```

Per-chunk handling:

- `choices[0].delta.content`: emit `{ type: "token", delta: content }`. Empty string → skip; null/undefined → skip. Do not coalesce; the consumer (TUI) handles batching.
- `choices[0].delta.tool_calls`: accumulate (see below). Do not emit per-fragment.
- `choices[0].finish_reason`:
  - `"stop"` / `"length"` / `"content_filter"`: stash; emit `done` after `[DONE]` (or stream end).
  - `"tool_calls"`: stash; flush accumulated tool calls (see "Tool-call accumulation"), then emit `done`.
- `usage` (only present on the trailing chunk when `stream_options.include_usage=true`): stash for the `done` payload.

### Tool-call accumulation

OpenAI fragments tool calls across deltas. The state machine, keyed by `delta.tool_calls[i].index`:

```
state[idx] = { id?: string, name: string, argsJson: string }
```

For each fragment in `delta.tool_calls`:

1. If `id` is present, set `state[idx].id = id`. (Arrives on the first fragment for the index; never changes after.)
2. If `function.name` is present, append to `state[idx].name`. (Usually arrives whole on the first fragment, but spec allows pieces.)
3. If `function.arguments` is present, append to `state[idx].argsJson`. (Almost always arrives in pieces — this is the most-fragmented field.)

When `finish_reason === "tool_calls"`, walk `state` in ascending `index` order. For each entry:

1. `JSON.parse(state[idx].argsJson)`. On parse error, emit an `{ type: "error", message: "tool_calls arguments not valid JSON", cause }` event with `cause` containing the raw `argsJson`, then terminate. Do NOT emit `done` — the response is broken and the driver must surface it.
2. Emit `{ type: "tool-call", toolCall: { id: state[idx].id, name: state[idx].name, arguments: parsed } }`.

If `state[idx].id` is missing (some non-conformant servers omit it), generate `call_${index}_${random}` as a fallback rather than failing — log a warning via `ctx.log`.

After all tool calls are emitted, emit `{ type: "done", response: { content: <accumulatedContent>, toolCalls: [...], finishReason: "tool_calls", usage } }`.

### Final `done` event

Build the `LLMResponse` from accumulated state:

- `content`: concatenation of every emitted `token.delta`.
- `toolCalls`: parsed tool calls, or `undefined` if none.
- `finishReason`: map OpenAI value to Spec 0's union — direct passthrough except unknown values map to `"error"`.
- `usage`: `{ promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens }` if usage chunk arrived; else `undefined`.

### `[DONE]` without `finish_reason`

Some servers omit `finish_reason` and just send `[DONE]`. Treat this as `finish_reason: "stop"` and emit `done` normally. Do NOT flush partial tool-call state in this case — emit an error event, since arriving at end-of-stream with non-empty tool-call state but no `tool_calls` finish reason is a wire protocol violation.

## Error handling

Every error path produces exactly one `{ type: "error", message, cause? }` event and then terminates the iterator. The driver translates the error event into `llm:error` (Spec 0).

### Error categories and mapping

| Source | `message` | `cause` | Retryable? |
|---|---|---|---|
| `fetch()` rejected (DNS, connect refused, TLS) | `"network error: <kind>"` | original Error | Yes |
| Connect timeout (no headers within `connectTimeoutMs`) | `"connect timeout"` | — | Yes |
| Request timeout (whole-stream `requestTimeoutMs` elapsed) | `"request timeout"` | — | No (already streaming) |
| HTTP 4xx | `"HTTP <code> <statusText>: <bodySnippet>"` | `{ status, body }` | No |
| HTTP 5xx | `"HTTP <code> <statusText>: <bodySnippet>"` | `{ status, body }` | Yes |
| HTTP 429 | `"HTTP 429: <bodySnippet>"` | `{ status, body, retryAfterMs? }` | Yes (honor `Retry-After` header) |
| Malformed SSE frame | `"malformed SSE data"` | original parse error + raw frame | No |
| Tool-call args not valid JSON | `"tool_calls arguments not valid JSON"` | `{ raw: argsJson }` | No |
| Aborted via `signal` | `"aborted"` | — | No |
| Non-conformant chunk shape (no `choices`) | `"unexpected chunk shape"` | `{ chunk }` | No |

`bodySnippet` is the first 512 bytes of the response body, UTF-8 decoded with replacement.

### Abort handling

`opts.signal` MUST be honored at every await boundary:

1. Before sending the request: if already aborted, emit error and return.
2. During `fetch()`: pass `signal` directly to `fetch`.
3. During stream read: the underlying reader is cancelled when the abort fires. The async iterator emits `{ type: "error", message: "aborted" }` and returns.
4. Between attempts (retry backoff): the backoff delay is interruptible via the same signal.

Aborting after at least one `token` event has been emitted is still an error event from this plugin's perspective — the driver decides whether to surface it as a user-cancel (success-ish) or a true error.

## Retry policy

Wraps the entire `complete` call. Pseudocode:

```
attempt = 0
while attempt < retry.maxAttempts:
  attempt++
  result = runOnce()                        # returns "ok" | { retryable: bool, error }
  if result == "ok": return
  if not result.retryable: emit error; return
  if attempt >= retry.maxAttempts: emit result.error; return
  if any token has been yielded this attempt: emit error; return  # never retry mid-stream
  delay = min(initialDelayMs * 2^(attempt-1), maxDelayMs)
  if jitter == "full": delay = random(0, delay)
  await sleep(delay, signal)                # interruptible
```

Hard rule (do not violate):

- **No retry once any `token` event has been yielded.** Tokens are observable side effects; retrying produces duplicate output. The pre-check before the retry decision must be: "has this attempt yielded at least one stream event of type `token` or `tool-call`?" If yes → no retry.

`Retry-After` header on 429/503: parse as integer seconds OR HTTP-date. If present and ≤ `maxDelayMs`, use it instead of computed backoff. If > `maxDelayMs`, cap at `maxDelayMs` and log.

## `listModels()` implementation

GET `${baseUrl}/models` with the same auth/headers as `complete`.

Response shape:

```jsonc
{
  "object": "list",
  "data": [
    { "id": "gpt-4o", "object": "model", "created": 1700000000, "owned_by": "openai", "context_length": 128000 }
  ]
}
```

Map to `ModelInfo[]`:

- `id`: `data[i].id`
- `contextLength`: `data[i].context_length` if present (LM Studio includes it; OpenAI does not).
- `description`: `data[i].owned_by` if present, else undefined.

Errors throw — no streaming, no event emission. Caller handles. Apply the same retry policy as `complete` (no streaming concern, so retries are unconditional within `maxAttempts`).

If the server returns 404 on `/models` (some self-hosted servers omit it), return `[]` and log via `ctx.log`. Do not throw.

## File layout

Mirror `plugins/claude-driver/`:

```
plugins/openai-llm/
  index.ts            # plugin registration, config load, service wiring
  config.ts           # config schema, loader, env override
  http.ts             # fetch wrapper, headers, timeout helpers
  sse.ts              # SSE frame reader (byte stream → frame strings)
  parser.ts           # frame string → ParsedChunk (analogous to claude-driver/parser.ts)
  stream.ts           # ParsedChunk stream → AsyncIterable<LLMStreamEvent> (accumulation, tool-call state machine)
  retry.ts            # backoff policy, retryability classifier
  service.ts          # makeService(): assembles complete() and listModels()
  public.d.ts         # re-exports (LLMRequest, LLMResponse, LLMStreamEvent, LLMCompleteService) from llm-events
  test/
    sse.test.ts
    parser.test.ts
    stream.test.ts
    retry.test.ts
    service.test.ts   # mock-fetch end-to-end
```

`parser.ts` mirrors `plugins/claude-driver/parser.ts`: a pure function from a single decoded frame to a discriminated-union `ParsedChunk`. Keeps the byte/string boundary, the parse boundary, and the state-machine boundary in separate files so each is unit-testable in isolation.

## Test plan

### `sse.test.ts` — frame reader

- Single frame in single chunk
- Single frame split across multiple chunks at every byte position (table-driven)
- Multiple frames in one chunk
- `\r\n\r\n` and `\n\n` both treated as frame delimiters (be lenient on input, strict on output)
- Comment lines (`: keep-alive`) ignored
- `event:`, `id:`, `retry:` lines ignored
- UTF-8 multibyte codepoint split across two chunks decodes correctly (use a 4-byte emoji)
- `[DONE]` terminates the iterator
- Frames after `[DONE]` are ignored (not an error)

### `parser.test.ts` — chunk → ParsedChunk

- Content-only delta
- Tool-call delta with `id` + name + first args fragment
- Tool-call delta with only args fragment (continuation)
- Multiple tool-call indices in one delta
- Trailing usage chunk (empty choices, populated `usage`)
- `finish_reason: "stop"` with no content
- Missing `choices` → returns `{ kind: "malformed" }` (caller decides)
- Empty delta object (`delta: {}`) → returns `{ kind: "empty" }`

### `stream.test.ts` — accumulation state machine

- 5 content fragments → 5 `token` events + 1 `done` with concatenated content
- Tool-call across 8 fragments (id, name, then 6 arg-string pieces) → 1 `tool-call` event with parsed args, then `done` with `finishReason: "tool_calls"`
- Two parallel tool calls (indices 0 and 1) interleaved → 2 `tool-call` events emitted in index order
- Malformed JSON in accumulated `arguments` → `error` event, no `done`
- Mixed content + tool-calls (assistant emits prose then calls a tool) → tokens then tool-call then done
- Trailing usage chunk populates `done.response.usage`
- Stream ends without `[DONE]` and without `finish_reason` → emit `error` ("unexpected end of stream")
- Tool-call state non-empty but `finish_reason: "stop"` → `error`

### `retry.test.ts`

- 5xx then success → 1 retry, success surfaced
- 4xx → no retry, error surfaced immediately
- 429 with `Retry-After: 2` → waits 2s then retries
- 429 with `Retry-After: 9999` capped at `maxDelayMs`
- Network error mid-stream after a token has been emitted → no retry, error surfaced
- Abort during backoff → error surfaced as `aborted`
- `maxAttempts: 1` → no retry on any class

### `service.test.ts` — end-to-end with mock fetch

- Inject a fetch stub that yields a scripted byte sequence.
- Happy path: streaming chat completion → tokens → done.
- Streaming with tool calls → tokens → tool-call → done.
- 500 → retry → 200 success.
- 401 → no retry, error surfaces.
- Abort signal mid-stream cancels reader and emits `aborted` error.
- `extra` field overrides the default `temperature` in the wire request body.
- `apiKeyEnv` env-var override beats `apiKey` config field.
- `listModels()` parses 200 OK and 404-empty correctly.

### Reference fixtures

Capture real wire traces from LM Studio and OpenAI as text files under `test/fixtures/`:

- `lmstudio-chat-stream.txt`
- `lmstudio-tool-call-stream.txt`
- `openai-chat-stream.txt`
- `openai-tool-call-fragmented.txt` (the canonical fragmented case — id arrives in fragment 1, name in 2, args split across 3-12)

Tests should consume these byte-for-byte. When OpenAI changes their wire format, regenerate fixtures and review diff.

## Acceptance criteria

- `openai-llm` plugin builds, registers `llm:complete` service.
- All test files above pass.
- Against a live LM Studio at `http://localhost:1234/v1`: a smoke test (in `test/integration/`, gated on `KAIZEN_INTEGRATION=1`) completes a 1-turn chat with streaming tokens.
- Against a mock OpenAI server replaying `openai-tool-call-fragmented.txt`, the parser produces exactly one `tool-call` event with fully-reassembled, JSON-parsed `arguments`.
- `signal.abort()` mid-stream produces a single `error` event (`message: "aborted"`) within 50ms.
- Retry policy never retries after any `token` event has been yielded (property test: random failure injection at random byte offsets in fixture replay).
- The plugin reads no global Kaizen config — only its own file. Verified by grep of the plugin source for any path matching `/config/` or `kaizen.config`.
- `public.d.ts` re-exports the Spec 0 types verbatim — no shape drift.
- Marketplace catalog `entries` updated for `openai-llm`.

## Open questions for downstream

- **Token usage on streamed responses without `stream_options.include_usage`:** older OpenAI-compatible servers ignore the option. Should `llm-driver` (Spec 2) tolerate `usage: undefined`, or should this plugin synthesize an estimate? Recommendation: tolerate undefined; the driver already handles the case in its `RunConversationOutput.usage` aggregation.
- **Tool-choice field surface:** Spec 0's `LLMRequest` has no `toolChoice` field. Today it's reachable via `extra.tool_choice`. If `llm-native-dispatch` (Spec 4) needs to force a specific tool, do we promote it to a first-class field? Defer until Spec 4.
- **Function-call vs tool-call legacy field:** very old OpenAI-compat servers emit `delta.function_call` instead of `delta.tool_calls`. Out of scope for v1; document as known incompatibility. Add to v2 if a user reports it.
- **Streaming JSON-mode / structured outputs:** `response_format: { type: "json_schema", ... }` works through `req.extra` today. If we want first-class support, promote to `LLMRequest`. Defer.
- **`stream: false` fallback:** some endpoints behind corporate proxies don't tolerate SSE. Should this plugin support a non-streaming code path that buffers and synthesizes a single `done` event? Defer to user demand; the contract requires `AsyncIterable` either way so the consumer is unaffected.
- **Multiple `choices`:** OpenAI supports `n > 1`. Spec 0's `LLMResponse` is single-content. Not supported in v1; reject `req.extra.n > 1` with an error event at request build time.
