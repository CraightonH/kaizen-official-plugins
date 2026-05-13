import { test, expect } from "bun:test";
import { formatToolResult } from "../serialize.ts";

test("ok result has no [code execution result] prefix", () => {
  const out = formatToolResult(
    { ok: true, returnValue: 42, stdout: "" },
    { maxStdoutBytes: 1024, maxReturnBytes: 1024 },
  );
  expect(out).not.toContain("[code execution result]");
  expect(out).toContain("exit: ok");
  expect(out).toContain("returned: 42");
});

test("err result encodes exit/error/stdout cleanly", () => {
  const out = formatToolResult(
    { ok: false, errorName: "TypeError", errorMessage: "boom", stdout: "before\n" },
    { maxStdoutBytes: 1024, maxReturnBytes: 1024 },
  );
  expect(out).not.toContain("[code execution result]");
  expect(out).toContain("exit: error");
  expect(out).toContain("error: TypeError: boom");
  expect(out).toContain("stdout:");
  expect(out).toContain("before");
});

test("stdout truncation respects maxStdoutBytes", () => {
  const big = "x".repeat(10_000);
  const out = formatToolResult(
    { ok: true, returnValue: null, stdout: big },
    { maxStdoutBytes: 64, maxReturnBytes: 1024 },
  );
  expect(out).toContain("[truncated");
});
