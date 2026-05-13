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

- `index.ts` wires config loading and service registration.
- `config.ts` owns the JSON config file shape and validation.
- `http.ts` maps Kaizen request/messages/tools to OpenAI-compatible HTTP
  headers and body fields. It also contains the opt-in debug request dump.
- `service.ts` owns fetch, retry, abort, timeout, and model-list behavior.
- `sse.ts`, `parser.ts`, and `stream.ts` own SSE frame extraction and stream
  event assembly.

## Testing

Prefer narrow tests around provider behavior:

```sh
bun test plugins/openai-llm
bunx tsc -p plugins/openai-llm/tsconfig.json --noEmit
```

The live LM Studio test is gated by `KAIZEN_INTEGRATION=1`.
