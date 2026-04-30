import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeService } from "../service.ts";
import { DEFAULT_CONFIG } from "../config.ts";

function loadFixture(name: string): Uint8Array {
  const text = readFileSync(join(import.meta.dir, "fixtures", name), "utf8")
    .split("\n").filter(l => !l.startsWith("# ")).join("\n");
  return new TextEncoder().encode(text);
}

function bodyOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } });
}

const cfg = { ...DEFAULT_CONFIG };
const ctxStub = { log: () => {} } as any;

describe("fixture replay", () => {
  it("openai-tool-call-fragmented yields exactly one tool-call with parsed args", async () => {
    const bytes = loadFixture("openai-tool-call-fragmented.txt");
    const fetchStub = async () => new Response(bodyOf(bytes), { status: 200 });
    const svc = makeService(cfg, ctxStub, { fetch: fetchStub as any, version: "0.1.0" });
    const events: any[] = [];
    for await (const e of svc.complete({ model: "x", messages: [{ role: "user", content: "weather?" }] }, { signal: new AbortController().signal })) events.push(e);
    const calls = events.filter(e => e.type === "tool-call");
    expect(calls.length).toBe(1);
    expect(calls[0].toolCall.name).toBe("get_weather");
    expect(calls[0].toolCall.arguments).toEqual({ location: "SLC" });
    expect(events.at(-1)!.type).toBe("done");
  });

  it("openai-chat-stream yields tokens then done with usage", async () => {
    const bytes = loadFixture("openai-chat-stream.txt");
    const fetchStub = async () => new Response(bodyOf(bytes), { status: 200 });
    const svc = makeService(cfg, ctxStub, { fetch: fetchStub as any, version: "0.1.0" });
    const events: any[] = [];
    for await (const e of svc.complete({ model: "x", messages: [{ role: "user", content: "hi" }] }, { signal: new AbortController().signal })) events.push(e);
    expect(events.filter(e => e.type === "token").length).toBeGreaterThan(0);
    expect(events.at(-1)!.type).toBe("done");
  });
});
