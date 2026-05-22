import React from "react";
import { describe, it, expect } from "bun:test";
import { render } from "ink-testing-library";
import { HistoryView } from "./HistoryView.tsx";
import { TuiStore } from "../state/store.ts";
import { BUILT_IN_THEME } from "../theme/schema.ts";

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

function seed() {
  const s = new TuiStore({ theme: BUILT_IN_THEME });
  s.appendUser("first question");
  s.appendReasoning("alpha-thought-1\nalpha-thought-2"); s.finalizeReasoning();
  s.appendOutput("first answer");
  s.appendUser("second question");
  s.appendReasoning("beta-thought"); s.finalizeReasoning();
  s.appendOutput("second answer");
  s.enterHistoryMode();
  return s;
}

describe("HistoryView", () => {
  it("renders header listing block count and key hints", async () => {
    const s = seed();
    const { lastFrame } = render(<HistoryView store={s} theme={BUILT_IN_THEME} />);
    await tick();
    const frame = lastFrame();
    expect(frame).toContain("History");
    expect(frame).toContain("2 entr");
    expect(frame).toContain("j/k focus");
  });

  it("does NOT re-render the chat transcript (static handles that above)", async () => {
    const s = seed();
    const { lastFrame } = render(<HistoryView store={s} theme={BUILT_IN_THEME} />);
    await tick();
    const frame = lastFrame()!;
    expect(frame).not.toContain("first question");
    expect(frame).not.toContain("first answer");
    expect(frame).not.toContain("second question");
  });

  it("collapsed thoughts hide body; Enter expands focused block only", async () => {
    const s = seed();
    const { stdin, lastFrame } = render(<HistoryView store={s} theme={BUILT_IN_THEME} />);
    await tick();
    expect(lastFrame()).not.toContain("alpha-thought-1");
    expect(lastFrame()).not.toContain("beta-thought");
    stdin.write("\r"); await tick();
    expect(lastFrame()).toContain("alpha-thought-1");
    expect(lastFrame()).not.toContain("beta-thought");
  });

  it("j/k moves focus and wraps", async () => {
    const s = seed();
    const { stdin } = render(<HistoryView store={s} theme={BUILT_IN_THEME} />);
    await tick();
    expect(s.snapshot().historyView.focusIdx).toBe(0);
    stdin.write("j"); await tick();
    expect(s.snapshot().historyView.focusIdx).toBe(1);
    stdin.write("j"); await tick();
    expect(s.snapshot().historyView.focusIdx).toBe(0);
    stdin.write("k"); await tick();
    expect(s.snapshot().historyView.focusIdx).toBe(1);
  });

  it("e expands all; c collapses all", async () => {
    const s = seed();
    const { stdin, lastFrame } = render(<HistoryView store={s} theme={BUILT_IN_THEME} />);
    await tick();
    stdin.write("e"); await tick();
    expect(lastFrame()).toContain("alpha-thought-1");
    expect(lastFrame()).toContain("beta-thought");
    stdin.write("c"); await tick();
    expect(lastFrame()).not.toContain("alpha-thought-1");
    expect(lastFrame()).not.toContain("beta-thought");
  });

  it("q exits to chat mode", async () => {
    const s = seed();
    const { stdin } = render(<HistoryView store={s} theme={BUILT_IN_THEME} />);
    await tick();
    stdin.write("q"); await tick();
    expect(s.snapshot().viewMode).toBe("chat");
  });

  it("Esc exits to chat mode", async () => {
    const s = seed();
    const { stdin } = render(<HistoryView store={s} theme={BUILT_IN_THEME} />);
    await tick();
    stdin.write("\x1b"); await tick();
    expect(s.snapshot().viewMode).toBe("chat");
  });

  it("renders 'no thought blocks' notice when none exist", async () => {
    const s = new TuiStore({ theme: BUILT_IN_THEME });
    s.appendUser("hi"); s.appendOutput("hello");
    s.enterHistoryMode();
    const { lastFrame } = render(<HistoryView store={s} theme={BUILT_IN_THEME} />);
    await tick();
    expect(lastFrame()).toContain("no entries yet");
  });

  it("renders a tool_call entry with wrench glyph in history", () => {
    const s = new TuiStore({ theme: BUILT_IN_THEME });
    s.appendToolCallToTranscript("c1", "read_file", { path: "/etc/hosts" }, "done", "ok");
    s.enterHistoryMode();
    const { lastFrame } = render(<HistoryView store={s} theme={BUILT_IN_THEME} />);
    expect(lastFrame() ?? "").toContain("read_file");
    expect(lastFrame() ?? "").toContain("🔧");
  });

  it("renders expanded thoughts through markdown when theme.thoughtsMarkdown is true (no dim on body)", async () => {
    const s = new TuiStore({ theme: BUILT_IN_THEME });
    s.appendReasoning("**bold thought**");
    s.finalizeReasoning();
    s.enterHistoryMode();
    s.historySetAllExpanded(true);
    const theme = { ...BUILT_IN_THEME, thoughtsMarkdown: true };
    const { lastFrame } = render(<HistoryView store={s} theme={theme} />);
    const frame = lastFrame() ?? "";
    expect(frame.includes("**bold thought**")).toBe(false);
    expect(frame.includes("bold thought")).toBe(true);
  });

  it("renders expanded thoughts as plain per-line dim text when theme.thoughtsMarkdown is false", async () => {
    const s = new TuiStore({ theme: BUILT_IN_THEME });
    s.appendReasoning("**not rendered**");
    s.finalizeReasoning();
    s.enterHistoryMode();
    s.historySetAllExpanded(true);
    const theme = { ...BUILT_IN_THEME, thoughtsMarkdown: false };
    const { lastFrame } = render(<HistoryView store={s} theme={theme} />);
    expect((lastFrame() ?? "").includes("**not rendered**")).toBe(true);
  });

  it("memoizes rendered markdown per entry id (renderMarkdown not re-run on collapse/expand)", async () => {
    const s = new TuiStore({ theme: BUILT_IN_THEME });
    s.appendReasoning("**stable**");
    s.finalizeReasoning();
    s.enterHistoryMode();
    s.historySetAllExpanded(true);
    const theme = { ...BUILT_IN_THEME, thoughtsMarkdown: true };
    const { lastFrame, rerender } = render(<HistoryView store={s} theme={theme} />);
    const first = lastFrame() ?? "";
    s.historySetAllExpanded(false);
    rerender(<HistoryView store={s} theme={theme} />);
    s.historySetAllExpanded(true);
    rerender(<HistoryView store={s} theme={theme} />);
    expect(lastFrame()).toBe(first);
  });
});
