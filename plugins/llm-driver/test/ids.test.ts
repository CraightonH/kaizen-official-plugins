import { describe, it, expect } from "bun:test";
import { newTurnId, makeIdGen } from "../ids.ts";

describe("ids", () => {
  it("newTurnId returns a non-empty string with `turn_` prefix", () => {
    const id = newTurnId();
    expect(id.startsWith("turn_")).toBe(true);
    expect(id.length).toBeGreaterThan(5);
  });

  it("two newTurnId calls produce different ids", () => {
    expect(newTurnId()).not.toBe(newTurnId());
  });

  it("makeIdGen yields a deterministic sequence for tests", () => {
    const gen = makeIdGen(["a", "b", "c"]);
    expect(gen()).toBe("a");
    expect(gen()).toBe("b");
    expect(gen()).toBe("c");
  });

  it("makeIdGen throws when exhausted", () => {
    const gen = makeIdGen(["a"]);
    gen();
    expect(() => gen()).toThrow(/exhausted/);
  });
});
