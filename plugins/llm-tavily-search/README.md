# llm-tavily-search

Registers a single `web_search` tool backed by [Tavily](https://tavily.com). Tavily's free tier (1,000 searches/month as of 2026) gives LLM-friendly results: title + URL + cleaned snippet, with an optional synthesized one-paragraph answer.

## Setup

Get an API key at https://tavily.com and set it via either:

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

If `apiKey` is empty, the env var named by `apiKeyEnv` (default `TAVILY_API_KEY`) is consulted as a fallback.

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

Use `search_depth: "advanced"` for research-grade queries (costs more Tavily credits). Default `basic` is fine for navigational/fact lookups.

## Pairs with `web_fetch`

The companion `web_fetch` tool from `llm-local-tools` will fetch the raw body of any URL Tavily returns — useful when the snippet isn't enough.
