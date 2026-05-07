import React from "react";
import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { codemodeRenderer } from "../tui-renderer.tsx";

test("collapsedSummary reports line count", () => {
  expect(codemodeRenderer.collapsedSummary({ code: "a\nb\nc" })).toContain("3 lines");
});

test("collapsedSummary handles single line", () => {
  expect(codemodeRenderer.collapsedSummary({ code: "1+1" })).toContain("1 line");
});

test("expandedView shows code, stdout pane, and result", () => {
  const node = codemodeRenderer.expandedView(
    { code: "console.log('hi'); 42" },
    "exit: ok\nreturned: 42\nstdout:\nhi\n",
    "done",
    "hi\n",
  );
  const { lastFrame } = render(<>{node}</>);
  const out = lastFrame() ?? "";
  expect(out).toContain("console.log");
  expect(out).toContain("hi");
  expect(out).toContain("42");
});
