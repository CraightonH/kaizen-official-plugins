# llm-tavily-search

Registers a single `web_search` tool backed by [Tavily](https://tavily.com).
Tavily's free tier (1,000 searches/month as of 2026) returns LLM-friendly
results: title, URL, and a cleaned snippet, plus an optional one-paragraph
synthesized answer.

## Services

**Consumes**: `tools:registry` (owned by `llm-tools-registry`).

This plugin only registers a tool; it does not provide a service.

## Tool surface

`web_search(query, max_results?, search_depth?, include_answer?, include_domains?, exclude_domains?)`

Returns:

```ts
{
  query: string;
  answer: string | null;        // present when include_answer=true
  results: Array<{
    title: string;
    url: string;
    content: string;            // cleaned snippet
    score: number;
  }>;
  response_time_ms: number;
}
```

Use `search_depth: "advanced"` for research-grade queries (costs more Tavily
credits). Default `basic` is fine for navigational and fact lookups.

`include_raw_content` is intentionally forced off — raw page bodies can be
hundreds of KB per result and blow up the model context. Pair with
`web_fetch` from `llm-local-tools` when full page content is needed.

## Setup

Get an API key at <https://tavily.com> and supply it via either:

**Environment variable (recommended):**

```sh
export TAVILY_API_KEY=tvly-...
```

**Or config file** at `~/.kaizen/plugins/llm-tavily-search/config.json`:

```json
{
  "apiKey": "tvly-...",
  "defaultMaxResults": 5,
  "defaultSearchDepth": "basic",
  "defaultIncludeAnswer": false
}
```

If `apiKey` is empty, the environment variable named by `apiKeyEnv` (default
`TAVILY_API_KEY`) is consulted as a fallback.

If no key is found, the plugin still loads but logs a warning; the first
`web_search` call returns a clear `web_search: TAVILY_API_KEY not set` error.

## Configuration

| Key | Default | Effect |
|-----|---------|--------|
| `apiKey` | `""` | Tavily API key. Overridden by the env var named by `apiKeyEnv` when set. |
| `apiKeyEnv` | `"TAVILY_API_KEY"` | Environment variable name to consult when `apiKey` is empty. |
| `endpoint` | `"https://api.tavily.com/search"` | Tavily search endpoint. |
| `defaultMaxResults` | `5` | Default `max_results` (1..20). |
| `defaultSearchDepth` | `"basic"` | Default `search_depth` (`"basic"` or `"advanced"`). |
| `defaultIncludeAnswer` | `false` | Default `include_answer`. |
| `requestTimeoutMs` | `30000` | Per-call timeout for the underlying HTTP request. |

Set `KAIZEN_TAVILY_CONFIG=/path/to/config.json` to override the config-file
location. Missing override paths log a warning and fall back to defaults;
malformed JSON or invalid field types fail setup.

## Permissions

`tier: "trusted"` is intentional. The plugin:

- Reads config from the user's home directory (or `KAIZEN_TAVILY_CONFIG`).
- Reads the configured API-key environment variable (default
  `TAVILY_API_KEY`).
- Connects to the configured Tavily endpoint (default
  `https://api.tavily.com/search`) over HTTPS during tool execution.

No filesystem writes, no other network destinations. Outbound traffic is
limited to whatever `endpoint` resolves to; override it only if you front
Tavily with a corporate proxy you trust.

## Errors

Failures are surfaced as `web_search:`-prefixed `Error` throws — caught by the
registry and turned into a tool-role message by the dispatch layer. Common
shapes:

- `web_search: query is required` — empty/missing `query` argument.
- `web_search: TAVILY_API_KEY not set (or apiKey missing in config)`.
- `web_search: Tavily HTTP <status>: <body>` — Tavily error response body is
  preserved (truncated to 500 chars); contains the upstream quota / invalid-key
  message verbatim.
- `web_search: cancelled` / `web_search: timeout` — `ctx.signal` aborts and the
  configured `requestTimeoutMs` map to these.

## Pairs with `web_fetch`

The companion `web_fetch` tool from `llm-local-tools` will fetch the raw body
of any URL Tavily returns — useful when the snippet isn't enough.

## Tests

```sh
bun test plugins/llm-tavily-search
bunx tsc -p plugins/llm-tavily-search/tsconfig.json --noEmit
```

Tests inject `fetch`; no live network is required.
