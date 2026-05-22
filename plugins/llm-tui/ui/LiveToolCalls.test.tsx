import React from "react";
import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { LiveToolCalls } from "./LiveToolCalls.tsx";
import { TuiStore } from "../state/store.ts";
import { makeToolRendererRegistry } from "../tool-renderers/registry.ts";

const theme = {
  promptColor: "cyan",
  outputColor: "white",
  noticeColor: "gray",
  busyColor: "yellow",
  statusBarColor: "blue",
  thoughtsMarkdown: true,
} as const;

test("renders nothing when no live tool calls exist", () => {
  const store = new TuiStore({ theme: theme as any });
  const reg = makeToolRendererRegistry();
  const { lastFrame } = render(
    <LiveToolCalls store={store} registry={reg} theme={theme as any} />
  );
  expect((lastFrame() ?? "").trim()).toBe("");
});

test("renders one running entry per live tool call", () => {
  const store = new TuiStore({ theme: theme as any });
  const reg = makeToolRendererRegistry();
  store.appendLiveToolCall("c1", "read_file", { path: "/etc/hosts" });
  store.appendLiveToolCall("c2", "execute_typescript", { code: "1+1" });
  const { lastFrame } = render(
    <LiveToolCalls store={store} registry={reg} theme={theme as any} />
  );
  const out = lastFrame() ?? "";
  expect(out).toContain("read_file");
  expect(out).toContain("execute_typescript");
});

test("repaints when stdoutDelta arrives (smoke check the subscribe wiring)", async () => {
  const store = new TuiStore({ theme: theme as any });
  const reg = makeToolRendererRegistry();
  store.appendLiveToolCall("c1", "execute_typescript", { code: "console.log(1)" });
  const { lastFrame, rerender } = render(
    <LiveToolCalls store={store} registry={reg} theme={theme as any} />
  );
  store.updateLiveToolCall("c1", { stdoutDelta: "hello\n" });
  // useSyncExternalStore drives this — give Ink a tick to flush.
  await new Promise((r) => setTimeout(r, 10));
  rerender(<LiveToolCalls store={store} registry={reg} theme={theme as any} />);
  expect(lastFrame() ?? "").toContain("hello");
});
