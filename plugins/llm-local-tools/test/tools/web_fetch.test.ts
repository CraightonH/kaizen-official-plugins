// plugins/llm-local-tools/test/tools/web_fetch.test.ts
import { describe, it, expect } from "bun:test";
import { schema, handler } from "../../tools/web_fetch.ts";

function makeResp(body: string, init: { status?: number; headers?: Record<string, string>; url?: string; redirected?: boolean } = {}) {
  return new Response(body, {
    status: init.status ?? 200,
    headers: init.headers ?? { "content-type": "text/plain" },
  });
}

function ctxWith(fetchImpl: typeof fetch, signal?: AbortSignal) {
  return { signal: signal ?? new AbortController().signal, callId: "c1", log: () => {}, fetch: fetchImpl } as any;
}

describe("web_fetch tool", () => {
  it("schema metadata", () => {
    expect(schema.name).toBe("web_fetch");
    expect(schema.tags).toEqual(["local", "web"]);
    expect(schema.parameters.required).toEqual(["url"]);
  });

  it("fetches a URL and returns body + status", async () => {
    const fakeFetch = (async (_url: any, _init: any) => makeResp("hello world")) as unknown as typeof fetch;
    const r = await handler({ url: "https://example.com/" }, ctxWith(fakeFetch));
    expect(r.status).toBe(200);
    expect(r.body).toBe("hello world");
    expect(r.content_type).toBe("text/plain");
    expect(r.truncated).toBe(false);
  });

  it("refuses non-http schemes", async () => {
    await expect(handler({ url: "file:///etc/passwd" }, ctxWith(fetch))).rejects.toThrow(/non-http/);
  });

  it("rejects malformed URLs", async () => {
    await expect(handler({ url: "not a url" }, ctxWith(fetch))).rejects.toThrow(/invalid URL/);
  });

  it("truncates oversized bodies", async () => {
    const big = "x".repeat(2048);
    const fakeFetch = (async () => makeResp(big)) as unknown as typeof fetch;
    const r = await handler({ url: "https://example.com/", max_bytes: 1024 }, ctxWith(fakeFetch));
    expect(r.truncated).toBe(true);
    expect(r.body).toContain("[truncated:");
  });

  it("HEAD returns no body", async () => {
    const fakeFetch = (async () => makeResp("ignored")) as unknown as typeof fetch;
    const r = await handler({ url: "https://example.com/", method: "HEAD" }, ctxWith(fakeFetch));
    expect(r.body).toBe("");
    expect(r.bytes).toBe(0);
  });

  it("propagates ctx.signal aborts", async () => {
    const ac = new AbortController();
    const fakeFetch = ((url: any, init: any) => new Promise((_, rej) => {
      init.signal.addEventListener("abort", () => {
        const e: any = new Error("aborted"); e.name = "AbortError"; rej(e);
      });
    })) as unknown as typeof fetch;
    setTimeout(() => ac.abort(), 10);
    await expect(handler({ url: "https://example.com/" }, ctxWith(fakeFetch, ac.signal))).rejects.toThrow(/cancelled|aborted/);
  });
});
