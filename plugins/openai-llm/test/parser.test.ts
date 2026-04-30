import { describe, it, expect } from "bun:test";
import { parseChunk } from "../parser.ts";

function frame(obj: unknown): string { return JSON.stringify(obj); }

describe("parseChunk", () => {
  it("returns malformed on bad JSON", () => {
    expect(parseChunk("{not")).toEqual({ kind: "malformed", raw: "{not" } as any);
  });

  it("returns malformed when choices missing", () => {
    expect(parseChunk(frame({ id: "x" })).kind).toBe("malformed");
  });

  it("returns empty when delta has no fields", () => {
    expect(parseChunk(frame({ choices: [{ index: 0, delta: {} }] })).kind).toBe("empty");
  });

  it("returns content delta", () => {
    const p = parseChunk(frame({ choices: [{ index: 0, delta: { content: "hi" } }] }));
    expect(p).toEqual({ kind: "content", delta: "hi" } as any);
  });

  it("skips empty-string content as empty", () => {
    expect(parseChunk(frame({ choices: [{ index: 0, delta: { content: "" } }] })).kind).toBe("empty");
  });

  it("returns tool-call fragment", () => {
    const p = parseChunk(frame({
      choices: [{
        index: 0,
        delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "f", arguments: "{\"a" } }] },
      }],
    }));
    expect(p).toEqual({
      kind: "tool-fragment",
      fragments: [{ index: 0, id: "c1", name: "f", argsDelta: "{\"a" }],
    } as any);
  });

  it("returns finish with reason", () => {
    const p = parseChunk(frame({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
    expect(p).toEqual({ kind: "finish", reason: "stop" } as any);
  });

  it("returns usage on trailing chunk", () => {
    const p = parseChunk(frame({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }));
    expect(p).toEqual({ kind: "usage", usage: { promptTokens: 1, completionTokens: 2 } } as any);
  });
});
