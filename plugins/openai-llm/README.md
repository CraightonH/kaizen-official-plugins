# openai-llm

OpenAI-compatible LLM provider for the local Kaizen harness.

This plugin implements the `llm:complete` service against OpenAI-style
`/chat/completions` streaming endpoints. It is a provider implementation, not
the owner of the shared LLM request/response interface. Cross-plugin LLM types,
including `LLMCompleteService`, `LLMRequest`, `LLMStreamEvent`, and `ModelInfo`,
are owned by `llm-contracts/public` and should be imported from there.

## What it does

- Sends streaming chat completion requests to `${baseUrl}/chat/completions`.
- Parses SSE frames, including `[DONE]`, content deltas, reasoning deltas,
  tool-call fragments, finish reasons, and trailing usage chunks.
- Accumulates fragmented OpenAI tool calls into Kaizen `ToolCall` objects.
- Retries network, connect-timeout, HTTP 429, and HTTP 5xx failures when no
  token or tool call has been yielded yet.
- Exposes `listModels()` via `${baseUrl}/models` and best-effort LM Studio
  context-window enrichment from `/api/v0/models`.

## Services

**Provides**: `llm:complete`

**Consumes**: `events:vocabulary`, `config:store`

The service implementation satisfies `LLMCompleteService` from
`llm-contracts/public`.

`llm-contracts` defines the neutral `llm:complete` service slot. `openai-llm`
declares a dependency on `events:vocabulary` so `llm-events` setup runs
first, then this plugin binds the concrete OpenAI-compatible implementation with
`ctx.provideService("llm:complete", ...)`. `config:store` is a topo-hint
optional dependency — if it is unavailable at boot the plugin falls back to
its compiled-in defaults and logs a single line.

## Public Surface

This package intentionally does not export `openai-llm/public`. Consumers should
not import provider-neutral LLM types from this plugin. Use:

```ts
import type { LLMCompleteService, LLMRequest } from "llm-contracts/public";
```

## Configuration

Configuration is routed through the harness `config:store` service
(`kaizen-config`). The plugin section in the user's harness config file is
`openai-llm`:

```jsonc
// ~/.kaizen/harnesses/<key>/config.json
{
  "plugins": {
    "openai-llm": {
      "baseUrl": "http://localhost:1234/v1",
      "apiKey": { "$ref": "keychain:openai-llm/apiKey" },
      "defaultModel": "local-model",
      "defaultTemperature": 0.7,
      "requestTimeoutMs": 120000,
      "connectTimeoutMs": 10000,
      "retry": {
        "maxAttempts": 3,
        "initialDelayMs": 500,
        "maxDelayMs": 8000,
        "jitter": "full"
      },
      "extraHeaders": {}
    }
  }
}
```

Use the `/config` slash commands exposed by `kaizen-config` to inspect and
edit values; `set()` validates against the schema before writing.

| Key | Effect |
|-----|--------|
| `baseUrl` | OpenAI-compatible API base URL, such as `https://api.openai.com/v1` or `http://localhost:1234/v1`. |
| `apiKey` | Bearer token (**secret field**). Stored via `secrets:registry`; only a `{ $ref: ... }` pointer is persisted in `config.json`. Sent as `Authorization: Bearer <apiKey>` when non-empty. The default is `""` (LM Studio and other local OpenAI-compatible servers do not require a key). |
| `defaultModel` | Model sent when `LLMRequest.model` is omitted or empty. |
| `defaultTemperature` | Temperature sent when `LLMRequest.temperature` is omitted. |
| `requestTimeoutMs` | Per-attempt deadline covering response headers and the full stream. |
| `connectTimeoutMs` | Per-attempt deadline for response headers before the stream starts. |
| `retry.maxAttempts` | Maximum attempts. `1` disables retries. |
| `retry.initialDelayMs` | First retry delay before exponential backoff. |
| `retry.maxDelayMs` | Backoff cap. |
| `retry.jitter` | `"full"` randomizes within the backoff window; `"none"` uses deterministic delays. |
| `extraHeaders` | String headers merged into every request after defaults. |

## Debug Requests

When `KAIZEN_DEBUG_REQUESTS=1`, `buildChatBody()` writes prompt previews to
`~/.kaizen/debug/request-<timestamp>.txt` and
`~/.kaizen/debug/last-request.txt`. These files can contain sensitive prompt and
message content. Leave this unset unless you are debugging local request
construction.

## Permissions

`tier: "unscoped"` is intentional. The plugin:

- Connects to an arbitrary user-configured `baseUrl`.
- Optionally writes debug request files under `~/.kaizen/debug` when
  `KAIZEN_DEBUG_REQUESTS=1` is set (see *Debug Requests* above).

Config I/O happens inside `kaizen-config`'s permission boundary; this plugin
does not need `fs.read` / `fs.write` paths for its own configuration.

## Tests

```sh
bun test plugins/openai-llm
bunx tsc -p plugins/openai-llm/tsconfig.json --noEmit
```
