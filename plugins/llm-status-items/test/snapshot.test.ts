import { describe, it, expect } from "bun:test";
import { buildSnapshot } from "../snapshot.ts";
import { initialState, type StatusState } from "../state.ts";

function makeState(overrides: Partial<StatusState> = {}): StatusState {
  return { ...initialState(), ...overrides };
}

describe("buildSnapshot", () => {
  it("projects defaults from initialState with null costCents", () => {
    const snap = buildSnapshot(makeState(), null);
    expect(snap).toEqual({
      model: null,
      session: { id: null, alias: null },
      contextWindow: { lastPromptTokens: 0, contextLength: null, pctUsed: null },
      sessionTotals: { promptTokens: 0, completionTokens: 0 },
      tokensPerSec: null,
      costCents: null,
    });
  });

  it("computes pctUsed when contextLength is positive", () => {
    const snap = buildSnapshot(
      makeState({ lastPromptTokens: 4096, contextLength: 8192 }),
      null,
    );
    expect(snap.contextWindow.pctUsed).toBe(0.5);
  });

  it("leaves pctUsed null when contextLength is null", () => {
    const snap = buildSnapshot(makeState({ lastPromptTokens: 1000 }), null);
    expect(snap.contextWindow.pctUsed).toBeNull();
  });

  it("leaves pctUsed null when contextLength is zero (defensive)", () => {
    const snap = buildSnapshot(
      makeState({ lastPromptTokens: 1000, contextLength: 0 }),
      null,
    );
    expect(snap.contextWindow.pctUsed).toBeNull();
  });

  it("passes costCents through verbatim", () => {
    const snap = buildSnapshot(makeState(), 1.23);
    expect(snap.costCents).toBe(1.23);
  });

  it("surfaces session id, alias, model, totals, and tok/s", () => {
    const snap = buildSnapshot(
      makeState({
        model: "gpt-4o-mini",
        sessionId: "abc",
        sessionAlias: "demo",
        promptTokens: 12303,
        completionTokens: 2103,
        tokensPerSec: 87.4,
      }),
      45.6,
    );
    expect(snap.model).toBe("gpt-4o-mini");
    expect(snap.session).toEqual({ id: "abc", alias: "demo" });
    expect(snap.sessionTotals).toEqual({ promptTokens: 12303, completionTokens: 2103 });
    expect(snap.tokensPerSec).toBe(87.4);
    expect(snap.costCents).toBe(45.6);
  });
});
