# Working in `llm-tavily-search`

Notes for agents editing this plugin. See `README.md` for the user-facing contract.

## Module map

```
index.ts        Plugin lifecycle. Loads config, builds handler with injected fetch,
                registers web_search via tools:registry. Only file that touches ctx.
config.ts       loadConfig() — reads ~/.kaizen/plugins/llm-tavily-search/config.json,
                falls back to env var (default TAVILY_API_KEY). DI-friendly.
tool.ts         Schema + makeHandler({config, fetch, log}). Pure factory — no I/O,
                no globals. POSTs to Tavily /search. Wires ctx.signal to AbortController.
public.d.ts     Re-exports ToolSchema, declares TOOL_NAMES = ["web_search"].
test/           bun:test suites — config.test.ts, tool.test.ts, scaffold.test.ts.
```

Boundaries:
- Only `index.ts` imports `kaizen/types` or touches `ctx`.
- `config.ts` and `tool.ts` are framework-free. `tool.ts` takes `fetch` as a dep so tests stub it.
- API key plumbing lives entirely in `config.ts`. Don't re-read env in `tool.ts`.

## Invariants

- **No API call without an API key.** Handler throws a clear error before reaching out. Setup logs a warning (does not throw) if no key — the plugin should still load so the user gets a sensible error at call time.
- **Errors throw native `Error` with a `web_search:` prefix.** Matches the local-tools convention. The registry catches; the dispatch turns it into a tool message.
- **Cancellation.** Handler must abort the underlying fetch when `ctx.signal` fires. `turn:cancel` relies on this.
- **HTTP errors surface verbatim (truncated to 500 chars).** The body usually contains Tavily's "quota exceeded" / "invalid key" messages — keep them visible.
- **`include_raw_content` is forced to false.** Raw content can be hundreds of KB per result and blows up context. If a caller needs the full page, they should call `web_fetch` on the URL.

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

The Kaizen runtime prefers bundled `dist/index.js`. After editing:

```bash
mkdir -p ~/.kaizen/marketplaces/official/plugins/llm-tavily-search@0.1.0/
cp -R plugins/llm-tavily-search/. ~/.kaizen/marketplaces/official/plugins/llm-tavily-search@0.1.0/
(cd ~/.kaizen/marketplaces/official/plugins/llm-tavily-search@0.1.0 \
  && bun build --target=bun --outfile=dist/index.js index.ts)
```

Then update `~/.kaizen/marketplaces/official/repo/.kaizen/marketplace.json` and the harness manifest if needed (`kaizen marketplace update` will overwrite local edits there).
