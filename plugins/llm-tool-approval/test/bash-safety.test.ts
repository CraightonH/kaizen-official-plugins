import { describe, it, expect } from "bun:test";
import { bashSafety } from "../bash-safety.ts";

describe("bashSafety", () => {
  it("returns null for a clean simple command", () => {
    expect(bashSafety("ls -la")).toBeNull();
    expect(bashSafety("git status")).toBeNull();
    expect(bashSafety("echo foo")).toBeNull();
    expect(bashSafety("python -m thing --flag=v")).toBeNull();
  });

  it("flags non-string command", () => {
    expect(bashSafety(undefined)).toBe("non-string command");
    expect(bashSafety(null)).toBe("non-string command");
    expect(bashSafety(42)).toBe("non-string command");
    expect(bashSafety("")).toBe("non-string command");
  });

  it("flags multiline commands first", () => {
    expect(bashSafety("ls\nrm -rf /")).toBe("multiline command");
    expect(bashSafety("ls\r\necho x")).toBe("multiline command");
  });

  it("flags backtick substitution", () => {
    expect(bashSafety("echo `whoami`")).toBe(
      "backtick command substitution — unable to inspect",
    );
  });

  it("flags $(...) substitution", () => {
    expect(bashSafety("echo $(whoami)")).toBe(
      "command substitution $(…) — unable to inspect",
    );
  });

  it("flags conditional chaining && and ||", () => {
    expect(bashSafety("ls && echo ok")).toBe("conditional chaining (&& / ||)");
    expect(bashSafety("ls || echo nope")).toBe("conditional chaining (&& / ||)");
  });

  it("flags command separator ;", () => {
    expect(bashSafety("ls; echo done")).toBe("command separator ;");
  });

  it("flags a plain pipe but not ||", () => {
    expect(bashSafety("ls | grep foo")).toBe("pipe |");
  });

  it("flags trailing & (background)", () => {
    expect(bashSafety("sleep 5 &")).toBe("background execution &");
    expect(bashSafety("sleep 5 & ")).toBe("background execution &");
  });

  it("does not flag & that is part of && (already covered by chaining reason)", () => {
    expect(bashSafety("ls && echo ok")).toBe("conditional chaining (&& / ||)");
  });

  it("flags quoted metacharacters too (over-flagging is the safer default)", () => {
    expect(bashSafety("bash -c 'ls; rm'")).toBe("command separator ;");
  });

  it("first match wins in declared order — newline beats backtick", () => {
    expect(bashSafety("ls\n`x`")).toBe("multiline command");
  });
});
