import React from "react";
import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { ToolCallBlock } from "../ui/ToolCallBlock.tsx";
import { makeToolRendererRegistry } from "./registry.ts";
import { defaultRenderers } from "./defaults.tsx";
import type { ToolCallEntry } from "../state/store.ts";

const theme = {
  promptColor: "cyan",
  outputColor: "white",
  noticeColor: "gray",
  busyColor: "yellow",
  statusBarColor: "blue",
} as const;

function withDefaults() {
  const reg = makeToolRendererRegistry();
  for (const r of defaultRenderers(theme as any)) reg.service.register(r);
  return reg;
}

const entry = (patch: Partial<ToolCallEntry>): ToolCallEntry => ({
  id: 1,
  kind: "tool_call",
  callId: "c",
  name: "edit",
  args: {},
  status: "done",
  stdout: "",
  ...patch,
});

test("edit renderer shows replaced-line headline and a +/- diff preview", () => {
  const reg = withDefaults();
  const { lastFrame } = render(
    <ToolCallBlock
      registry={reg}
      theme={theme as any}
      entry={entry({
        name: "edit",
        args: { command: "str_replace", path: "/tmp/foo.ts", old_str: "alpha\nbeta", new_str: "ALPHA\nbeta\nGAMMA" },
        result: "edited /tmp/foo.ts: replaced 1 occurrence(s)",
      })}
    />
  );
  const out = lastFrame() ?? "";
  expect(out).toContain("Replaced 2 → 3 lines");
  expect(out).toContain("- alpha");
  expect(out).toContain("+ ALPHA");
  expect(out).toContain("+ GAMMA");
});

test("write renderer shows line count and content preview", () => {
  const reg = withDefaults();
  const { lastFrame } = render(
    <ToolCallBlock
      registry={reg}
      theme={theme as any}
      entry={entry({
        name: "write",
        args: { path: "/tmp/x.txt", content: "one\ntwo\nthree" },
        result: "wrote /tmp/x.txt",
      })}
    />
  );
  const out = lastFrame() ?? "";
  expect(out).toContain("Wrote 3 lines");
  expect(out).toContain("two");
});

test("bash renderer shows stdout preview", () => {
  const reg = withDefaults();
  const { lastFrame } = render(
    <ToolCallBlock
      registry={reg}
      theme={theme as any}
      entry={entry({
        name: "bash",
        args: { command: "echo hi" },
        stdout: "hi\n",
        result: "hi\n",
      })}
    />
  );
  expect(lastFrame() ?? "").toContain("hi");
});

test("bash renderer truncates with hidden-line summary past PREVIEW_LINES", () => {
  const reg = withDefaults();
  const big = Array.from({ length: 25 }, (_, i) => `line-${i}`).join("\n");
  const { lastFrame } = render(
    <ToolCallBlock
      registry={reg}
      theme={theme as any}
      entry={entry({
        name: "bash",
        args: { command: "seq" },
        stdout: big,
      })}
    />
  );
  const out = lastFrame() ?? "";
  expect(out).toContain("line-0");
  expect(out).toContain("+15 more");
});

test("error status suppresses verbose body for write/edit (avoids misleading content)", () => {
  const reg = withDefaults();
  const { lastFrame } = render(
    <ToolCallBlock
      registry={reg}
      theme={theme as any}
      entry={entry({
        name: "edit",
        status: "error",
        errorMessage: "old_str must be non-empty",
        args: { command: "str_replace", path: "/tmp/x", old_str: "a", new_str: "b" },
      })}
    />
  );
  const out = lastFrame() ?? "";
  expect(out).toContain("✗");
  expect(out).toContain("old_str must be non-empty");
  expect(out).not.toContain("Replaced");
});
