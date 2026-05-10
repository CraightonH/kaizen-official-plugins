import React from "react";
import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { ToolCallBlock } from "./ToolCallBlock.tsx";
import type { ToolCallEntry } from "../state/store.ts";
import { makeToolRendererRegistry } from "../tool-renderers/registry.ts";

const theme = {
  promptColor: "cyan",
  outputColor: "white",
  noticeColor: "gray",
  busyColor: "yellow",
  statusBarColor: "blue",
} as const;

const entry = (patch: Partial<ToolCallEntry> = {}): ToolCallEntry => ({
  id: 1,
  kind: "tool_call",
  callId: "call-1",
  name: "read_file",
  args: { path: "/etc/hosts" },
  status: "running",
  stdout: "",
  ...patch,
});

test("renders running status with spinner glyph and tool name", () => {
  const reg = makeToolRendererRegistry();
  const { lastFrame } = render(
    <ToolCallBlock entry={entry()} registry={reg} theme={theme as any} />
  );
  const out = lastFrame() ?? "";
  expect(out).toContain("read_file");
  expect(out).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏…]|running/);
});

test("renders done status with check glyph", () => {
  const reg = makeToolRendererRegistry();
  const { lastFrame } = render(
    <ToolCallBlock entry={entry({ status: "done", result: "ok" })} registry={reg} theme={theme as any} />
  );
  expect(lastFrame() ?? "").toContain("✓");
});

test("renders error status with cross glyph and error message", () => {
  const reg = makeToolRendererRegistry();
  const { lastFrame } = render(
    <ToolCallBlock entry={entry({ status: "error", errorMessage: "boom" })} registry={reg} theme={theme as any} />
  );
  const out = lastFrame() ?? "";
  expect(out).toContain("✗");
  expect(out).toContain("boom");
});

test("uses custom collapsedSummary from a registered renderer", () => {
  const reg = makeToolRendererRegistry();
  reg.service.register({
    toolName: "read_file",
    collapsedSummary: (args) => `path=${(args as any).path}`,
    expandedView: () => null as any,
  });
  const { lastFrame } = render(
    <ToolCallBlock entry={entry()} registry={reg} theme={theme as any} />
  );
  expect(lastFrame() ?? "").toContain("path=/etc/hosts");
});

test("default summary surfaces the primary arg value (path) without JSON braces", () => {
  const reg = makeToolRendererRegistry();
  const { lastFrame } = render(
    <ToolCallBlock entry={entry()} registry={reg} theme={theme as any} />
  );
  const out = lastFrame() ?? "";
  expect(out).toContain("read_file(/etc/hosts)");
  expect(out).not.toContain('{"path":');
});

test("default summary picks `command` over other keys for Bash-style tools", () => {
  const reg = makeToolRendererRegistry();
  const { lastFrame } = render(
    <ToolCallBlock entry={entry({ name: "Bash", args: { command: "ls -la /tmp", description: "list tmp" } })} registry={reg} theme={theme as any} />
  );
  expect(lastFrame() ?? "").toContain("Bash(ls -la /tmp)");
});

test("default summary truncates very long values with an ellipsis", () => {
  const reg = makeToolRendererRegistry();
  const long = "a".repeat(200);
  const { lastFrame } = render(
    <ToolCallBlock entry={entry({ args: { command: long } })} registry={reg} theme={theme as any} />
  );
  expect(lastFrame() ?? "").toContain("…");
});

test("default summary collapses whitespace in multi-line commands", () => {
  const reg = makeToolRendererRegistry();
  const { lastFrame } = render(
    <ToolCallBlock entry={entry({ name: "Bash", args: { command: "cd foo &&\n  bar\n  baz" } })} registry={reg} theme={theme as any} />
  );
  expect(lastFrame() ?? "").toContain("Bash(cd foo && bar baz)");
});

test("default summary falls back to key=value pairs when no primary key matches", () => {
  const reg = makeToolRendererRegistry();
  const { lastFrame } = render(
    <ToolCallBlock entry={entry({ name: "weird", args: { foo: "1", bar: 2 } })} registry={reg} theme={theme as any} />
  );
  const out = lastFrame() ?? "";
  expect(out).toContain("foo=1");
  expect(out).toContain("bar=2");
});
