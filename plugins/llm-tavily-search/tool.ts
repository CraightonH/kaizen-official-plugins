// plugins/llm-tavily-search/tool.ts
import type { ToolExecutionContext, ToolSchema } from "llm-tools-registry/public";
import type { TavilyConfig } from "./public.d.ts";

export const schema: ToolSchema = {
  name: "web_search",
  description: "Search the web via Tavily. Returns a list of result {title, url, content snippet, score}. Use search_depth=advanced for harder/research queries (costs more credits). Set include_answer=true to also get a synthesized one-paragraph answer.",
  parameters: {
    type: "object",
    properties: {
      query:           { type: "string", description: "Search query." },
      max_results:     { type: "integer", minimum: 1, maximum: 20, description: "Default 5." },
      search_depth:    { type: "string", enum: ["basic", "advanced"], description: "Default basic." },
      include_answer:  { type: "boolean", description: "If true, response includes a one-paragraph synthesized answer." },
      include_domains: { type: "array", items: { type: "string" }, description: "Allowlist." },
      exclude_domains: { type: "array", items: { type: "string" }, description: "Denylist." },
    },
    required: ["query"],
  },
  tags: ["web", "search"],
};

interface SearchArgs {
  query: string;
  max_results?: number;
  search_depth?: "basic" | "advanced";
  include_answer?: boolean;
  include_domains?: string[];
  exclude_domains?: string[];
}

interface TavilyResultItem {
  title: string;
  url: string;
  content: string;
  score: number;
  raw_content?: string | null;
}

interface TavilyApiResponse {
  query: string;
  answer?: string | null;
  results: TavilyResultItem[];
  response_time?: number;
}

export interface SearchResult {
  query: string;
  answer: string | null;
  results: Array<{ title: string; url: string; content: string; score: number }>;
  response_time_ms: number;
}

export interface HandlerDeps {
  config: TavilyConfig;
  fetch: typeof fetch;
  log: (msg: string) => void;
}

export function makeHandler(deps: HandlerDeps) {
  return async function handler(rawArgs: unknown, ctx: ToolExecutionContext): Promise<SearchResult> {
    const args = (rawArgs ?? {}) as SearchArgs;
    if (!args.query || typeof args.query !== "string") {
      throw new Error("web_search: query is required");
    }
    if (!deps.config.apiKey) {
      throw new Error("web_search: TAVILY_API_KEY not set (or apiKey missing in config)");
    }

    const body = {
      api_key: deps.config.apiKey,
      query: args.query,
      max_results: Math.min(20, Math.max(1, args.max_results ?? deps.config.defaultMaxResults)),
      search_depth: args.search_depth ?? deps.config.defaultSearchDepth,
      include_answer: args.include_answer ?? deps.config.defaultIncludeAnswer,
      include_raw_content: false,
      include_domains: args.include_domains,
      exclude_domains: args.exclude_domains,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("timeout")), deps.config.requestTimeoutMs);
    const onAbort = () => controller.abort(new Error("cancelled"));
    const outer = ctx.signal;
    if (outer.aborted) controller.abort(new Error("cancelled"));
    else outer.addEventListener("abort", onAbort, { once: true });

    const start = Date.now();
    try {
      const resp = await deps.fetch(deps.config.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`web_search: Tavily HTTP ${resp.status}: ${text.slice(0, 500)}`);
      }
      const json = (await resp.json()) as TavilyApiResponse;
      const results = Array.isArray(json.results) ? json.results : [];
      return {
        query: json.query ?? args.query,
        answer: typeof json.answer === "string" ? json.answer : null,
        results: results.map((r) => ({
          title: r.title,
          url: r.url,
          content: r.content,
          score: r.score,
        })),
        response_time_ms: Date.now() - start,
      };
    } catch (err) {
      const e = err as { name?: string; message?: string };
      if (e?.name === "AbortError" || controller.signal.aborted) {
        const reason = controller.signal.reason instanceof Error ? controller.signal.reason.message : "aborted";
        throw new Error(`web_search: ${reason}`);
      }
      if (typeof e?.message === "string" && e.message.startsWith("web_search:")) throw err;
      throw new Error(`web_search: ${e?.message ?? String(err)}`);
    } finally {
      clearTimeout(timer);
      outer.removeEventListener("abort", onAbort);
    }
  };
}
