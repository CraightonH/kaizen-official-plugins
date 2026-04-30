import { describe, it, expect } from "bun:test";
import { readSseFrames } from "../sse.ts";

function bodyOf(...chunks: (Uint8Array | string)[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(typeof c === "string" ? enc.encode(c) : c);
      controller.close();
    },
  });
}

async function collect(it: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const s of it) out.push(s);
  return out;
}

describe("readSseFrames", () => {
  it("yields one frame from a single chunk", async () => {
    const r = collect(readSseFrames(bodyOf("data: hello\n\n"), new AbortController().signal));
    expect(await r).toEqual(["hello"]);
  });

  it("handles a frame split byte-by-byte across many chunks", async () => {
    const text = "data: hello\n\ndata: world\n\n";
    const enc = new TextEncoder().encode(text);
    const chunks = Array.from(enc).map((b) => new Uint8Array([b]));
    const out = await collect(readSseFrames(bodyOf(...chunks), new AbortController().signal));
    expect(out).toEqual(["hello", "world"]);
  });

  it("treats \\r\\n\\r\\n as a frame delimiter", async () => {
    const out = await collect(readSseFrames(bodyOf("data: a\r\n\r\ndata: b\r\n\r\n"), new AbortController().signal));
    expect(out).toEqual(["a", "b"]);
  });

  it("ignores comment lines and event:/id:/retry:", async () => {
    const out = await collect(readSseFrames(bodyOf(": keepalive\n\nevent: foo\nid: 1\ndata: x\n\n"), new AbortController().signal));
    expect(out).toEqual(["x"]);
  });

  it("decodes a 4-byte emoji split across two chunks", async () => {
    const enc = new TextEncoder().encode("data: 😀\n\n");  // 😀 = F0 9F 98 80
    const mid = enc.length - 4 + 2;                         // split inside the codepoint
    const a = enc.slice(0, mid);
    const b = enc.slice(mid);
    const out = await collect(readSseFrames(bodyOf(a, b), new AbortController().signal));
    expect(out).toEqual(["😀"]);
  });

  it("[DONE] terminates the iterator and ignores trailing frames", async () => {
    const out = await collect(readSseFrames(bodyOf("data: a\n\ndata: [DONE]\n\ndata: ignored\n\n"), new AbortController().signal));
    expect(out).toEqual(["a", "[DONE]"]);
  });

  it("aborts cleanly when signal fires mid-stream", async () => {
    const ac = new AbortController();
    const stream = new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode("data: a\n\n")); /* hang */ },
    });
    const it = readSseFrames(stream, ac.signal)[Symbol.asyncIterator]();
    expect((await it.next()).value).toBe("a");
    ac.abort();
    const r = await it.next();
    expect(r.done).toBe(true);
  });
});
