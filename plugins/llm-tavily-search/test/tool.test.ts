// plugins/llm-tavily-search/test/tool.test.ts
import { describe, it, expect } from "bun:test";
import { schema, makeHandler } from "../tool.ts";
import { DEFAULT_CONFIG } from "../config.ts";

function makeCtx(signal?: AbortSignal) {
  return { signal: signal ?? new AbortController().signal, callId: "c1", log: () => {} } as any;
}

function configWith(apiKey: string) {
  return { ...DEFAULT_CONFIG, apiKey };
}

describe("web_search tool", () => {
  it("schema metadata", () => {
    expect(schema.name).toBe("web_search");
    expect(schema.tags).toEqual(["web", "search"]);
    expect(schema.parameters.required).toEqual(["query"]);
  });

  it("errors without api key", async () => {
    const handler = makeHandler({ config: configWith(""), fetch: (async () => new Response("{}")) as any, log: () => {} });
    await expect(handler({ query: "x" }, makeCtx())).rejects.toThrow(/TAVILY_API_KEY/);
  });

  it("errors without query", async () => {
    const handler = makeHandler({ config: configWith("k"), fetch: (async () => new Response("{}")) as any, log: () => {} });
    await expect(handler({ query: "" } as any, makeCtx())).rejects.toThrow(/query/);
  });

  it("posts to endpoint with merged body and parses results", async () => {
    let captured: { url: string; init: any } | null = null;
    const fakeFetch = (async (url: any, init: any) => {
      captured = { url, init };
      return new Response(JSON.stringify({
        query: "claude",
        answer: "Claude is an AI assistant.",
        results: [
          { title: "Anthropic", url: "https://anthropic.com", content: "Claude...", score: 0.9 },
          { title: "Docs", url: "https://docs.anthropic.com", content: "API docs", score: 0.7 },
        ],
        response_time: 0.42,
      }), { headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const handler = makeHandler({ config: configWith("tvly-test"), fetch: fakeFetch, log: () => {} });
    const r = await handler({ query: "claude", max_results: 2, include_answer: true }, makeCtx());

    expect(captured).not.toBeNull();
    expect(captured!.url).toBe(DEFAULT_CONFIG.endpoint);
    const body = JSON.parse(captured!.init.body);
    expect(body.api_key).toBe("tvly-test");
    expect(body.query).toBe("claude");
    expect(body.max_results).toBe(2);
    expect(body.include_answer).toBe(true);

    expect(r.answer).toBe("Claude is an AI assistant.");
    expect(r.results).toHaveLength(2);
    expect(r.results[0].url).toBe("https://anthropic.com");
  });

  it("surfaces HTTP error from Tavily", async () => {
    const fakeFetch = (async () => new Response("forbidden", { status: 401 })) as unknown as typeof fetch;
    const handler = makeHandler({ config: configWith("bad"), fetch: fakeFetch, log: () => {} });
    await expect(handler({ query: "x" }, makeCtx())).rejects.toThrow(/HTTP 401/);
  });

  it("propagates ctx.signal aborts", async () => {
    const ac = new AbortController();
    const fakeFetch = ((_url: any, init: any) => new Promise((_, rej) => {
      init.signal.addEventListener("abort", () => {
        const e: any = new Error("aborted"); e.name = "AbortError"; rej(e);
      });
    })) as unknown as typeof fetch;
    setTimeout(() => ac.abort(), 10);
    const handler = makeHandler({ config: configWith("k"), fetch: fakeFetch, log: () => {} });
    await expect(handler({ query: "x" }, makeCtx(ac.signal))).rejects.toThrow(/cancelled|aborted/);
  });
});
