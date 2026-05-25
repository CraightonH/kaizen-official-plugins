# Working in `llm-tavily-search`

Notes for agents editing this plugin. See `README.md` for the user-facing contract.

## Module map

```
index.ts        Plugin lifecycle. Registers config:store spec, awaits ready()
                so the secret apiKey resolves to plaintext, fetches the merged
                config, builds handler with injected fetch, registers
                web_search via tools:registry. Holds the unregister callback
                in module scope and calls it from stop(). Only file that
                touches ctx.
config.ts       DEFAULT_CONFIG (frozen) + CONFIG_SCHEMA for config:store.
                apiKey is declared `secret: true` so the store routes it
                through `secrets:registry` and persists only a `$ref` pointer.
defaults.ts     Thin re-export of DEFAULT_CONFIG from config.ts (back-compat).
tool.ts         Schema + makeHandler({config, fetch, log}). Pure factory — no I/O,
                no globals. POSTs to Tavily /search. Wires ctx.signal to AbortController.
                Imports ToolSchema and ToolExecutionContext from llm-tools-registry/public.
public.d.ts     TavilyConfig type, plus re-exports ToolSchema from
                llm-tools-registry/public. Declares TOOL_NAMES = ["web_search"].
test/           bun:test suites — tool.test.ts, scaffold.test.ts.
```

Boundaries:
- Only `index.ts` imports `kaizen/types` or touches `ctx`.
- `tool.ts` is framework-free and takes `fetch` as a dep so tests stub it.
- API key plumbing comes from `config:store`. `apiKey` is a secret field —
  the user sets it via `/config:set llm-tavily-search apiKey=<key>` and the
  store stashes plaintext in `secrets:registry`; `config.json` holds only a
  `$ref` pointer. The plugin must `await cfgSvc.ready()` between `register()`
  and the first `get()` so the secret resolves to plaintext. Don't re-read
  env in `tool.ts`.
- Shared tool types come from `llm-tools-registry/public`. Don't import
  `llm-events/public` here — this plugin doesn't depend on `llm-events`.

## Invariants

- **No API call without an API key.** Handler throws a clear error before reaching out. Setup logs a warning (does not throw) if no key — the plugin should still load so the user gets a sensible error at call time.
- **Errors throw native `Error` with a `web_search:` prefix.** Matches the local-tools convention. The registry catches; the dispatch turns it into a tool message.
- **Cancellation.** Handler must abort the underlying fetch when `ctx.signal` fires. `turn:cancel` relies on this. The `addEventListener` is matched by a `removeEventListener` in `finally` so we don't leak listeners on the outer signal across calls.
- **HTTP errors surface verbatim (truncated to 500 chars).** The body usually contains Tavily's "quota exceeded" / "invalid key" messages — keep them visible.
- **`include_raw_content` is forced to false.** Raw content can be hundreds of KB per result and blows up context. If a caller needs the full page, they should call `web_fetch` on the URL.
- **Lifecycle uses `stop()`, not a returned `teardown`.** `KaizenPlugin.setup` is typed `Promise<void>`; the unregister callback lives in module-scope and is invoked from the optional `stop()` hook. `stop()` is idempotent.

## Config location

Reads via `config:store` from the harness-scoped file at
`~/.kaizen/harnesses/<harnessKey>/config.json` under
`plugins["llm-tavily-search"]`. For the `official/local`
harness, `<harnessKey>` is `official_local`.

Set via `/config:set llm-tavily-search apiKey=<key>`. The `apiKey` field is
a secret — plaintext is held in `secrets:registry`; only a `$ref` pointer
appears in the on-disk config file. No env-var override.

## Tavily API quick reference

`POST https://api.tavily.com/search`

Body (JSON):
- `api_key` — required
- `query` — required
- `search_depth` — `"basic"` (1 credit) or `"advanced"` (2 credits)
- `max_results` — 1..20
- `include_answer` — boolean
- `include_raw_content` — boolean (we force false)
- `include_domains` / `exclude_domains` — string arrays

Response: `{ query, answer?, results: [{title, url, content, score, raw_content?}], response_time }`

Free tier: 1,000 searches/month (May 2026).

## Testing

```bash
cd plugins/llm-tavily-search && bun test
```

No real network in tests — `fetch` is always injected. Use `Response` constructor for fakes.

## Local deploy

See repo CLAUDE.md.
