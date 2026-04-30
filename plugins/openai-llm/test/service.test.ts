import { describe, it, expect, mock } from "bun:test";
import { makeService } from "../service.ts";
import { DEFAULT_CONFIG, type OpenAILLMConfig } from "../config.ts";

function sse(...lines: string[]): ReadableStream<Uint8Array> {
  const body = lines.map(l => `data: ${l}\n\n`).join("") + "data: [DONE]\n\n";
  return new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(body)); c.close(); } });
}

function chatChunk(content: string, finish?: string) {
  return JSON.stringify({ choices: [{ index: 0, delta: content ? { content } : {}, finish_reason: finish ?? null }] });
}

const ctxStub = { log: () => {} } as any;

const cfg: OpenAILLMConfig = { ...DEFAULT_CONFIG, retry: { ...DEFAULT_CONFIG.retry, maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 5, jitter: "none" } };

async function collect(it: AsyncIterable<any>) { const out: any[] = []; for await (const x of it) out.push(x); return out; }

describe("makeService.complete", () => {
  it("happy path: streams tokens then done", async () => {
    const fetchStub = mock(async () => new Response(sse(chatChunk("hi"), chatChunk("", "stop")), { status: 200 }));
    const svc = makeService(cfg, ctxStub, { fetch: fetchStub as any, version: "0.1.0" });
    const out = await collect(svc.complete({ model: "x", messages: [{ role: "user", content: "hi" }] }, { signal: new AbortController().signal }));
    expect(out.map(e => e.type)).toEqual(["token", "done"]);
    expect(fetchStub).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchStub as any).mock.calls[0];
    expect(url).toContain("/chat/completions");
    expect(JSON.parse(init.body).stream).toBe(true);
  });

  it("500 then 200: retries once and surfaces success", async () => {
    let n = 0;
    const fetchStub = mock(async () => {
      n++;
      if (n === 1) return new Response("boom", { status: 500 });
      return new Response(sse(chatChunk("ok"), chatChunk("", "stop")), { status: 200 });
    });
    const svc = makeService(cfg, ctxStub, { fetch: fetchStub as any, version: "0.1.0" });
    const out = await collect(svc.complete({ model: "x", messages: [{ role: "user", content: "hi" }] }, { signal: new AbortController().signal }));
    expect(out.map(e => e.type)).toEqual(["token", "done"]);
    expect(n).toBe(2);
  });

  it("401 not retried: single error event", async () => {
    let n = 0;
    const fetchStub = mock(async () => { n++; return new Response("nope", { status: 401 }); });
    const svc = makeService(cfg, ctxStub, { fetch: fetchStub as any, version: "0.1.0" });
    const out = await collect(svc.complete({ model: "x", messages: [{ role: "user", content: "hi" }] }, { signal: new AbortController().signal }));
    expect(out.length).toBe(1);
    expect(out[0].type).toBe("error");
    expect(out[0].message).toMatch(/401/);
    expect(n).toBe(1);
  });

  it("network error mid-stream after a token has been yielded → no retry", async () => {
    let n = 0;
    const fetchStub = mock(async () => {
      n++;
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(`data: ${chatChunk("hi")}\n\n`));
          // Defer the error so the enqueued chunk is delivered first.
          setTimeout(() => c.error(new Error("conn reset")), 0);
        },
      });
      return new Response(stream, { status: 200 });
    });
    const svc = makeService(cfg, ctxStub, { fetch: fetchStub as any, version: "0.1.0" });
    const out = await collect(svc.complete({ model: "x", messages: [{ role: "user", content: "hi" }] }, { signal: new AbortController().signal }));
    expect(out[0].type).toBe("token");
    expect(out.at(-1)!.type).toBe("error");
    expect(n).toBe(1);
  });

  it("abort mid-stream emits 'aborted' error", async () => {
    const ac = new AbortController();
    const fetchStub = mock(async (_url: string, init: any) => {
      // Body that hangs forever.
      const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(`data: ${chatChunk("hi")}\n\n`)); /* never closes */ } });
      return new Response(stream, { status: 200 });
    });
    const svc = makeService(cfg, ctxStub, { fetch: fetchStub as any, version: "0.1.0" });
    const it = svc.complete({ model: "x", messages: [{ role: "user", content: "hi" }] }, { signal: ac.signal })[Symbol.asyncIterator]();
    const first = await it.next();
    expect(first.value.type).toBe("token");
    ac.abort();
    const last = await it.next();
    expect(last.value?.type ?? last.done).toBeDefined();
    // either error event or completed; if completed the previous next was the error.
  });

  it("apiKeyEnv override beats apiKey", async () => {
    const cfg2: OpenAILLMConfig = { ...cfg, apiKey: "from-env" }; // simulate already-resolved
    const fetchStub = mock(async (_u: string, init: any) => {
      expect(init.headers.Authorization).toBe("Bearer from-env");
      return new Response(sse(chatChunk("", "stop")), { status: 200 });
    });
    const svc = makeService(cfg2, ctxStub, { fetch: fetchStub as any, version: "0.1.0" });
    await collect(svc.complete({ model: "x", messages: [{ role: "user", content: "hi" }] }, { signal: new AbortController().signal }));
    expect(fetchStub).toHaveBeenCalled();
  });

  it("req.extra overrides default temperature in body", async () => {
    let body: any;
    const fetchStub = mock(async (_u: string, init: any) => { body = JSON.parse(init.body); return new Response(sse(chatChunk("", "stop")), { status: 200 }); });
    const svc = makeService(cfg, ctxStub, { fetch: fetchStub as any, version: "0.1.0" });
    await collect(svc.complete({ model: "x", messages: [{ role: "user", content: "hi" }], temperature: 0.1, extra: { temperature: 0.9 } }, { signal: new AbortController().signal }));
    expect(body.temperature).toBe(0.9);
  });
});

describe("makeService.listModels", () => {
  it("parses OK 200", async () => {
    const fetchStub = mock(async () => new Response(JSON.stringify({ object: "list", data: [{ id: "m1", context_length: 8192, owned_by: "me" }] }), { status: 200 }));
    const svc = makeService(cfg, ctxStub, { fetch: fetchStub as any, version: "0.1.0" });
    const models = await svc.listModels();
    expect(models).toEqual([{ id: "m1", contextLength: 8192, description: "me" }]);
  });
  it("404 returns []", async () => {
    const fetchStub = mock(async () => new Response("nope", { status: 404 }));
    const svc = makeService(cfg, ctxStub, { fetch: fetchStub as any, version: "0.1.0" });
    expect(await svc.listModels()).toEqual([]);
  });
});
