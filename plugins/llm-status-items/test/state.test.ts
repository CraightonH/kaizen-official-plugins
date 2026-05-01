import { describe, it, expect } from "bun:test";
import { initialState, applyEvent, type StatusState } from "../state.ts";

function step(s: StatusState, name: string, payload: any = {}): StatusState {
  return applyEvent(s, name, payload);
}

describe("applyEvent", () => {
  it("turn:start sets turn-state to thinking", () => {
    const s = step(initialState(), "turn:start", { turnId: "t-1" });
    expect(s.turnState).toBe("thinking");
    expect(s.turnInFlight).toBe(true);
  });

  it("tool:before-execute sets turn-state to calling <name>", () => {
    let s = step(initialState(), "turn:start", { turnId: "t-1" });
    s = step(s, "tool:before-execute", { name: "bash", args: {}, callId: "c1" });
    expect(s.turnState).toBe("calling bash");
    expect(s.currentTool).toBe("bash");
  });

  it("tool:result returns to thinking", () => {
    let s = step(initialState(), "turn:start", {});
    s = step(s, "tool:before-execute", { name: "bash", args: {}, callId: "c1" });
    s = step(s, "tool:result", { callId: "c1", result: "ok" });
    expect(s.turnState).toBe("thinking");
    expect(s.currentTool).toBeNull();
  });

  it("tool:error returns to thinking", () => {
    let s = step(initialState(), "turn:start", {});
    s = step(s, "tool:before-execute", { name: "bash", args: {}, callId: "c1" });
    s = step(s, "tool:error", { callId: "c1", message: "boom" });
    expect(s.turnState).toBe("thinking");
    expect(s.currentTool).toBeNull();
  });

  it("turn:end sets turn-state to ready", () => {
    let s = step(initialState(), "turn:start", {});
    s = step(s, "turn:end", { turnId: "t-1", reason: "complete" });
    expect(s.turnState).toBe("ready");
    expect(s.turnInFlight).toBe(false);
  });

  it("llm:before-call updates the active model", () => {
    const s = step(initialState(), "llm:before-call", {
      request: { model: "gpt-4.1-mini", messages: [] },
    });
    expect(s.model).toBe("gpt-4.1-mini");
  });

  it("llm:before-call respects upstream subscriber mutation", () => {
    // Memory-injection plugin would have already mutated request.model.
    const s = step(initialState(), "llm:before-call", {
      request: { model: "gpt-4.1", messages: [] },
    });
    expect(s.model).toBe("gpt-4.1");
  });

  it("llm:before-call is idempotent for turnState=thinking", () => {
    let s = step(initialState(), "turn:start", {});
    s = step(s, "llm:before-call", { request: { model: "x", messages: [] } });
    expect(s.turnState).toBe("thinking");
  });

  it("llm:done accumulates tokens", () => {
    let s = step(initialState(), "llm:done", {
      response: { content: "", finishReason: "stop", usage: { promptTokens: 100, completionTokens: 50 } },
    });
    expect(s.promptTokens).toBe(100);
    expect(s.completionTokens).toBe(50);
    s = step(s, "llm:done", {
      response: { content: "", finishReason: "stop", usage: { promptTokens: 300, completionTokens: 150 } },
    });
    expect(s.promptTokens).toBe(400);
    expect(s.completionTokens).toBe(200);
  });

  it("llm:done without usage leaves token totals unchanged", () => {
    let s = step(initialState(), "llm:done", {
      response: { content: "", finishReason: "stop", usage: { promptTokens: 10, completionTokens: 5 } },
    });
    s = step(s, "llm:done", { response: { content: "", finishReason: "stop" } });
    expect(s.promptTokens).toBe(10);
    expect(s.completionTokens).toBe(5);
  });

  it("conversation:cleared zeros tokens and clears model+cost markers", () => {
    let s = step(initialState(), "llm:done", {
      response: { content: "", finishReason: "stop", usage: { promptTokens: 100, completionTokens: 50 } },
    });
    s = step(s, "conversation:cleared", {});
    expect(s.promptTokens).toBe(0);
    expect(s.completionTokens).toBe(0);
    expect(s.cleared).toBe(true);
  });

  it("llm:done with no further tool calls and ended turn → ready", () => {
    let s = step(initialState(), "turn:start", {});
    s = step(s, "llm:done", { response: { content: "ok", finishReason: "stop" } });
    s = step(s, "turn:end", { turnId: "t-1", reason: "complete" });
    expect(s.turnState).toBe("ready");
  });
});
