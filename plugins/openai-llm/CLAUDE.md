# openai-llm Notes

`openai-llm` is a provider implementation. Keep provider-neutral LLM contracts in
`llm-events/public`; do not add or re-export shared LLM request/response types
from this plugin.

## Ownership

- Provides `llm:complete`; `llm-contracts` defines the service slot.
- Consumes `events:vocabulary` to force foundation setup before provider
  binding.
- Uses `LLMCompleteService`, `LLMRequest`, `LLMStreamEvent`, and `ModelInfo` from
  `llm-contracts/public`.
- OpenAI wire-protocol details belong here: request body mapping, SSE parsing,
  tool-call accumulation, retry, timeout, and model-list enrichment.

Do not call `ctx.defineService("llm:complete", ...)` here. That would move
interface ownership back into this concrete provider and break alternate LLM
providers that should slot into the same service.

## File Map

- `index.ts` wires config loading (via `config:store`) and service
  registration. Only file touching `ctx`.
- `config.ts` exports `DEFAULT_CONFIG` (frozen) and `CONFIG_SCHEMA`
  (`Record<keyof OpenAILLMConfig, FieldSchema>`) for `config:store`
  registration. Pure module — no I/O, no `ctx`.
- `http.ts` maps Kaizen request/messages/tools to OpenAI-compatible HTTP
  headers and body fields. It also contains the opt-in debug request dump.
- `service.ts` owns fetch, retry, abort, timeout, and model-list behavior.
- `sse.ts`, `parser.ts`, and `stream.ts` own SSE frame extraction and stream
  event assembly.

## Config invariants

- **`apiKey` is a secret field** (`{ type: "string", secret: true }`).
  `config:store` stores plaintext via `secrets:registry` and only persists a
  `{ $ref: ... }` pointer in `config.json`. INTEGRATION.md cites this plugin
  as the canonical secrets example.
- **`apiKey` schema omits `min: 1`** even though INTEGRATION.md's snippet
  shows it. The default is `""` (LM Studio and other local OpenAI-compatible
  servers accept no key); pairing `default: ""` with `min: 1` would fail
  validation on every boot for unconfigured users. Do not "fix" this.
- **`await cfgSvc.ready()` runs before the first `get()`** so the secret-ref
  for `apiKey` is resolved to plaintext before the service captures the
  config object.
- **No `envVars` on the `ConfigSpec`.** Env-var resolution is being removed
  from `config:store` — `OPENAI_API_KEY` is no longer honored. Users must
  set `apiKey` via `/config` (the harness stores it as a secret).
- **`KAIZEN_DEBUG_REQUESTS` in `http.ts` is the one remaining env read.** It
  is a developer-only debug toggle, not config; intentionally left as an
  env var until a debug-namespace config field exists across plugins.
- **`config:store` is topo-hint optional.** `setup()` falls back to
  `DEFAULT_CONFIG` if the service is missing or `register()` throws, so
  plugin tests with a bare fake `ctx` keep working.

## Testing

Prefer narrow tests around provider behavior:

```sh
bun test plugins/openai-llm
bunx tsc -p plugins/openai-llm/tsconfig.json --noEmit
```

The live LM Studio test is gated by `KAIZEN_INTEGRATION=1`.
