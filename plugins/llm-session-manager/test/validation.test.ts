import { describe, expect, test } from "bun:test";
import { isValidChildId, parseSessionId, validateFullSessionId } from "../validation";

describe("validation", () => {
  test("child ids accept short labels and reject traversal", () => {
    expect(isValidChildId("oneshot-abc123")).toBe(true);
    expect(isValidChildId("a.b_c-d")).toBe(true);
    expect(isValidChildId("")).toBe(false);
    expect(isValidChildId("a/b")).toBe(false);
    expect(isValidChildId("..")).toBe(false);
    expect(isValidChildId("a..b")).toBe(true);
    expect(isValidChildId("a\\b")).toBe(false);
  });

  test("parseSessionId returns top-level plus child path", () => {
    expect(parseSessionId("7f3e1234-89ab-cdef-0123-456789abcdef/reviewer/worker")).toEqual({
      topLevelId: "7f3e1234-89ab-cdef-0123-456789abcdef",
      childPath: ["reviewer", "worker"],
    });
  });

  test("validateFullSessionId accepts manager-shaped ids", () => {
    expect(() => validateFullSessionId("7f3e1234-89ab-cdef-0123-456789abcdef")).not.toThrow();
    expect(() => validateFullSessionId("7f3e1234-89ab-cdef-0123-456789abcdef/reviewer-A")).not.toThrow();
  });

  test("validateFullSessionId rejects malformed or unsafe ids", () => {
    expect(() => validateFullSessionId("not-a-uuid")).toThrow(/top-level/i);
    expect(() => validateFullSessionId("uuid//child")).toThrow(/empty/i);
    expect(() => validateFullSessionId("7f3e1234-89ab-cdef-0123-456789abcdef/..")).toThrow();
    expect(() => validateFullSessionId("7f3e1234-89ab-cdef-0123-456789abcdef/a\\b")).toThrow();
  });
});
