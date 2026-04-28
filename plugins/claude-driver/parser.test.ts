import { describe, it, expect } from "bun:test";
import { parseStreamJsonLine } from "./parser.ts";

describe("parseStreamJsonLine", () => {
  it("returns null on empty/whitespace lines", () => {
    expect(parseStreamJsonLine("")).toBeNull();
    expect(parseStreamJsonLine("   ")).toBeNull();
  });

  it("returns 'malformed' on bad JSON", () => {
    const r = parseStreamJsonLine("{not json");
    expect(r?.kind).toBe("malformed");
  });

  it("extracts model from system/init", () => {
    const r = parseStreamJsonLine(JSON.stringify({
      type: "system", subtype: "init", model: "claude-opus-4-7", session_id: "abc",
    }));
    expect(r).toEqual({ kind: "init", model: "claude-opus-4-7", sessionId: "abc" });
  });

  it("extracts text deltas from stream_event", () => {
    const r = parseStreamJsonLine(JSON.stringify({
      type: "stream_event", event: { delta: { type: "text_delta", text: "Hi" } },
    }));
    expect(r).toEqual({ kind: "text-delta", text: "Hi" });
  });

  it("extracts tokens + session id from result", () => {
    const r = parseStreamJsonLine(JSON.stringify({
      type: "result", session_id: "abc", duration_ms: 1234,
      usage: {
        input_tokens: 100, output_tokens: 50,
        cache_read_input_tokens: 10, cache_creation_input_tokens: 5,
      },
    }));
    expect(r).toEqual({
      kind: "result",
      sessionId: "abc",
      durationMs: 1234,
      tokensIn: 100,
      tokensOut: 50,
      cacheReadTokens: 10,
      cacheCreationTokens: 5,
    });
  });

  it("returns 'retry' for system/api_retry", () => {
    const r = parseStreamJsonLine(JSON.stringify({
      type: "system", subtype: "api_retry",
      attempt: 2, max_retries: 5, retry_delay_ms: 1000, error: "rate_limit",
    }));
    expect(r?.kind).toBe("retry");
  });

  it("returns 'unknown' for events we don't care about", () => {
    expect(parseStreamJsonLine(JSON.stringify({ type: "assistant", message: {} }))?.kind).toBe("unknown");
  });
});
