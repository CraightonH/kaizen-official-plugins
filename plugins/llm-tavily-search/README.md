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

Get an API key at <https://tavily.com> and store it via the harness `config:store`:

```sh
/config:set llm-tavily-search apiKey=tvly-...
```

`apiKey` is a **secret field**. The plaintext value is stashed in the
harness's `secrets:registry` backend (e.g. the OS keychain); only a
`{ "$ref": "..." }` pointer is persisted in
`~/.kaizen/harnesses/<harnessKey>/config.json` under
`plugins["llm-tavily-search"]`.

If no key is configured, the plugin still loads but logs a warning; the first
`web_search` call returns a clear `web_search: TAVILY_API_KEY not set` error.

## Configuration

| Key | Default | Effect |
|-----|---------|--------|
| `apiKey` | `""` | Tavily API key. Secret field — stored via `secrets:registry`. |
| `endpoint` | `"https://api.tavily.com/search"` | Tavily search endpoint. |
| `defaultMaxResults` | `5` | Default `max_results` (1..20). |
| `defaultSearchDepth` | `"basic"` | Default `search_depth` (`"basic"` or `"advanced"`). |
| `defaultIncludeAnswer` | `false` | Default `include_answer`. |
| `requestTimeoutMs` | `30000` | Per-call timeout for the underlying HTTP request. |

All fields are managed by `kaizen-config` via the `config:store` service.
Set via `/config:set llm-tavily-search <key>=<value>` or edit the harness
config file directly.

## Permissions

`tier: "trusted"` is intentional. The plugin:

- Reads its configuration via the harness `config:store` service (the
  underlying filesystem reads happen inside `kaizen-config`, not this plugin).
- Connects to the configured Tavily endpoint (default
  `https://api.tavily.com/search`) over HTTPS during tool execution.

No filesystem reads/writes from this plugin, no other network destinations.
Outbound traffic is limited to whatever `endpoint` resolves to; override it
only if you front Tavily with a corporate proxy you trust.

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
