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

test("falls back to JSON.stringify of args when no renderer registered", () => {
  const reg = makeToolRendererRegistry();
  const { lastFrame } = render(
    <ToolCallBlock entry={entry()} registry={reg} theme={theme as any} />
  );
  expect(lastFrame() ?? "").toContain('{"path":"/etc/hosts"}');
});
