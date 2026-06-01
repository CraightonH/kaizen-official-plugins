import { describe, it, expect } from "bun:test";
import { makePhaseCallback, makeLogCallback } from "../primitives/phase.ts";
import { eventBus } from "./_helpers.ts";

describe("phase() / log()", () => {
  it("phase emits workflow:phase with runId", () => {
    const bus = eventBus();
    const cb = makePhaseCallback({ runId: "r1", emit: (e, p) => bus.emit(e, p) });
    cb({ phase: "Verify" });
    expect(bus.emitted).toEqual([{ name: "workflow:phase", payload: { runId: "r1", phase: "Verify" } }]);
  });
  it("log emits workflow:log with runId", () => {
    const bus = eventBus();
    const cb = makeLogCallback({ runId: "r1", emit: (e, p) => bus.emit(e, p) });
    cb({ message: "found 3 bugs" });
    expect(bus.emitted).toEqual([{ name: "workflow:log", payload: { runId: "r1", message: "found 3 bugs" } }]);
  });
});
