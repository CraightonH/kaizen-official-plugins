// plugins/llm-local-tools/test/tools/web_fetch.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schema, handler } from "../../tools/web_fetch.ts";

function makeResp(body: string | ArrayBuffer | Uint8Array, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(body, {
    status: init.status ?? 200,
    headers: init.headers ?? { "content-type": "text/plain" },
  });
}

function ctxWith(fetchImpl: typeof fetch, signal?: AbortSignal) {
  return { signal: signal ?? new AbortController().signal, callId: "c1", log: () => {}, fetch: fetchImpl } as any;
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "llt-wf-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("web_fetch tool", () => {
  it("schema metadata", () => {
    expect(schema.name).toBe("web_fetch");
    expect(schema.tags).toEqual(["local", "web"]);
    expect(schema.parameters.required).toEqual(["url"]);
  });

  it("fetches a URL and returns body + status", async () => {
    const fakeFetch = (async () => makeResp("hello world")) as unknown as typeof fetch;
    const r = await handler({ url: "https://example.com/" }, ctxWith(fakeFetch));
    expect(r.status).toBe(200);
    expect(r.body).toBe("hello world");
    expect(r.content_type).toBe("text/plain");
    expect(r.is_binary).toBe(false);
    expect(r.saved_path).toBe(null);
    expect(r.truncated).toBe(false);
  });

  it("refuses non-http schemes", async () => {
    await expect(handler({ url: "file:///etc/passwd" }, ctxWith(fetch))).rejects.toThrow(/non-http/);
  });

  it("rejects malformed URLs", async () => {
    await expect(handler({ url: "not a url" }, ctxWith(fetch))).rejects.toThrow(/invalid URL/);
  });

  it("truncates oversized text bodies", async () => {
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

  it("refuses binary content without save_to", async () => {
    const fakeFetch = (async () => makeResp("not really pdf", { headers: { "content-type": "application/pdf" } })) as unknown as typeof fetch;
    await expect(handler({ url: "https://example.com/file.pdf" }, ctxWith(fakeFetch)))
      .rejects.toThrow(/binary.*save_to/);
  });

  it("saves binary content to disk and returns metadata only", async () => {
    const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]); // "%PDF-"
    const fakeFetch = (async () => makeResp(bytes, { headers: { "content-type": "application/pdf" } })) as unknown as typeof fetch;
    const out = join(dir, "doc.pdf");
    const r = await handler({ url: "https://example.com/doc.pdf", save_to: out }, ctxWith(fakeFetch));
    expect(r.saved_path).toBe(out);
    expect(r.body).toBe("");
    expect(r.is_binary).toBe(true);
    expect(r.content_type).toBe("application/pdf");
    expect(existsSync(out)).toBe(true);
    expect(readFileSync(out)).toEqual(bytes);
  });

  it("saves text content too when save_to is set, omits body from result", async () => {
    const fakeFetch = (async () => makeResp("hello\nworld\n", { headers: { "content-type": "text/plain" } })) as unknown as typeof fetch;
    const out = join(dir, "page.txt");
    const r = await handler({ url: "https://example.com/page.txt", save_to: out }, ctxWith(fakeFetch));
    expect(r.saved_path).toBe(out);
    expect(r.body).toBe("");
    expect(r.is_binary).toBe(false);
    expect(readFileSync(out, "utf8")).toBe("hello\nworld\n");
  });

  it("detects image content-types as binary", async () => {
    const fakeFetch = (async () => makeResp(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { headers: { "content-type": "image/png" } })) as unknown as typeof fetch;
    await expect(handler({ url: "https://example.com/a.png" }, ctxWith(fakeFetch))).rejects.toThrow(/binary/);
  });

  it("refuses to save when parent dir does not exist", async () => {
    const fakeFetch = (async () => makeResp("x", { headers: { "content-type": "application/octet-stream" } })) as unknown as typeof fetch;
    await expect(handler({ url: "https://example.com/", save_to: join(dir, "nope", "out.bin") }, ctxWith(fakeFetch)))
      .rejects.toThrow(/parent directory/);
  });
});
