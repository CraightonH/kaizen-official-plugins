import { describe, it, expect } from "bun:test";
import { validateAxiomId, validateAxiomEntry, AxiomValidationError } from "../schema.ts";

describe("validateAxiomId", () => {
  it("accepts simple lowercase ids", () => {
    expect(() => validateAxiomId("foo")).not.toThrow();
    expect(() => validateAxiomId("world-class-offline")).not.toThrow();
    expect(() => validateAxiomId("a_b_c")).not.toThrow();
    expect(() => validateAxiomId("x1y2z3")).not.toThrow();
  });
  it("rejects empty string", () => {
    expect(() => validateAxiomId("")).toThrow(AxiomValidationError);
  });
  it("rejects strings > 64 chars", () => {
    expect(() => validateAxiomId("a".repeat(65))).toThrow(AxiomValidationError);
  });
  it("rejects uppercase, spaces, dots, slashes", () => {
    expect(() => validateAxiomId("Foo")).toThrow(AxiomValidationError);
    expect(() => validateAxiomId("with space")).toThrow(AxiomValidationError);
    expect(() => validateAxiomId("a.b")).toThrow(AxiomValidationError);
    expect(() => validateAxiomId("a/b")).toThrow(AxiomValidationError);
  });
});

describe("validateAxiomEntry", () => {
  const ok = {
    id: "good",
    statement: "Calendars must work offline.",
    premises: ["users travel", "networks fail"],
    reasoning: "Without offline support a calendar is unusable during travel.",
    scope: "UX baseline",
  };
  it("accepts a well-formed entry", () => {
    expect(() => validateAxiomEntry(ok)).not.toThrow();
  });
  it("rejects empty statement", () => {
    expect(() => validateAxiomEntry({ ...ok, statement: "" })).toThrow(AxiomValidationError);
  });
  it("rejects statement > 280 chars", () => {
    expect(() => validateAxiomEntry({ ...ok, statement: "a".repeat(281) })).toThrow(AxiomValidationError);
  });
  it("rejects empty premises array", () => {
    expect(() => validateAxiomEntry({ ...ok, premises: [] })).toThrow(AxiomValidationError);
  });
  it("rejects > 10 premises", () => {
    expect(() => validateAxiomEntry({ ...ok, premises: Array(11).fill("x") })).toThrow(AxiomValidationError);
  });
  it("rejects a premise > 500 chars", () => {
    expect(() => validateAxiomEntry({ ...ok, premises: ["x", "y".repeat(501)] })).toThrow(AxiomValidationError);
  });
  it("rejects reasoning > 2000 chars", () => {
    expect(() => validateAxiomEntry({ ...ok, reasoning: "x".repeat(2001) })).toThrow(AxiomValidationError);
  });
  it("rejects scope > 200 chars", () => {
    expect(() => validateAxiomEntry({ ...ok, scope: "x".repeat(201) })).toThrow(AxiomValidationError);
  });
  it("rejects empty reasoning and empty scope", () => {
    expect(() => validateAxiomEntry({ ...ok, reasoning: "" })).toThrow(AxiomValidationError);
    expect(() => validateAxiomEntry({ ...ok, scope: "" })).toThrow(AxiomValidationError);
  });
  it("forwards id validation failures", () => {
    expect(() => validateAxiomEntry({ ...ok, id: "BAD ID" })).toThrow(AxiomValidationError);
  });
});
