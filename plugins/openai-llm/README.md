# openai-llm

OpenAI-compatible LLM provider for the openai-compatible Kaizen harness.

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

**Consumes**: `events:vocabulary`

The service implementation satisfies `LLMCompleteService` from
`llm-contracts/public`.

`llm-contracts` defines the neutral `llm:complete` service slot. `openai-llm`
declares a dependency on `events:vocabulary` so `llm-events` setup runs
first, then this plugin binds the concrete OpenAI-compatible implementation with
`ctx.provideService("llm:complete", ...)`.

## Public Surface

This package intentionally does not export `openai-llm/public`. Consumers should
not import provider-neutral LLM types from this plugin. Use:

```ts
import type { LLMCompleteService, LLMRequest } from "llm-contracts/public";
```

## Configuration

Configuration is read during `setup()` from:

1. `KAIZEN_OPENAI_LLM_CONFIG`, when set.
2. `~/.kaizen/plugins/openai-llm/config.json`, otherwise.

If the default path is missing, defaults are used. If an override path is
missing, the plugin logs that it fell back to defaults. Malformed JSON or invalid
field types fail setup.

```json
{
  "baseUrl": "http://localhost:1234/v1",
  "apiKey": "",
  "apiKeyEnv": "OPENAI_API_KEY",
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
```

| Key | Effect |
|-----|--------|
| `baseUrl` | OpenAI-compatible API base URL, such as `https://api.openai.com/v1` or `http://localhost:1234/v1`. |
| `apiKey` | Optional bearer token. Sent as `Authorization: Bearer <apiKey>` when non-empty. |
| `apiKeyEnv` | Optional environment variable name. When set and non-empty, its value overrides `apiKey`. |
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

- Reads config from the user's home directory or an arbitrary override path.
- Reads environment variables for config and optional API keys.
- Connects to an arbitrary user-configured `baseUrl`.
- Optionally writes debug request files under `~/.kaizen/debug`.

## Tests

```sh
bun test plugins/openai-llm
bunx tsc -p plugins/openai-llm/tsconfig.json --noEmit
```
