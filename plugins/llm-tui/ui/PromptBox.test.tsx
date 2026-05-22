import { describe, it, expect } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { PromptBox } from "./PromptBox.tsx";
import { TuiStore } from "../state/store.ts";
import { DEFAULT_THEME } from "../theme/loader.ts";

const theme = DEFAULT_THEME;

describe("<PromptBox>", () => {
  it("renders nothing when prompt is null", () => {
    const store = new TuiStore({ theme: DEFAULT_THEME });
    const { lastFrame } = render(<PromptBox store={store} theme={theme} />);
    expect(lastFrame()?.trim() ?? "").toBe("");
  });

  it("renders options mode with selected indicator", () => {
    const store = new TuiStore({ theme: DEFAULT_THEME });
    store.openOptionsPrompt(
      {
        title: "Approve tool call?",
        body: "fs:read_file",
        options: [
          { id: "once", label: "Approve Once" },
          { id: "deny", label: "Deny", expandsTo: { kind: "text" } },
        ],
        defaultId: "once",
      },
      () => {},
    );
    const { lastFrame } = render(<PromptBox store={store} theme={theme} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Approve tool call?");
    expect(frame).toContain("fs:read_file");
    expect(frame).toContain("Approve Once");
    expect(frame).toContain("Deny");
    expect(frame).toMatch(/[▸>].*Approve Once/);
  });

  it("renders Tab-hint on options with expandsTo", () => {
    const store = new TuiStore({ theme: DEFAULT_THEME });
    store.openOptionsPrompt(
      {
        title: "T",
        body: "B",
        options: [{ id: "deny", label: "Deny", expandsTo: { kind: "text" } }],
      },
      () => {},
    );
    const { lastFrame } = render(<PromptBox store={store} theme={theme} />);
    expect(lastFrame()).toContain("Tab");
  });

  it("renders expanded mode with text input row", () => {
    const store = new TuiStore({ theme: DEFAULT_THEME });
    store.openOptionsPrompt(
      {
        title: "T",
        body: "B",
        options: [{ id: "deny", label: "Deny", expandsTo: { kind: "text", placeholder: "Reason" } }],
      },
      () => {},
    );
    store.tabExpand();
    store.setExpandedText("looks dangerous");
    const { lastFrame } = render(<PromptBox store={store} theme={theme} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("looks dangerous");
    expect(frame).toMatch(/Enter.*Esc/);
  });

  it("renders standalone text mode", () => {
    const store = new TuiStore({ theme: DEFAULT_THEME });
    store.openTextPrompt({ title: "Reason?", body: "Why deny?", placeholder: "type here" }, () => {});
    const { lastFrame } = render(<PromptBox store={store} theme={theme} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Reason?");
    expect(frame).toContain("Why deny?");
  });

  it("handles CJK width in body without breaking layout", () => {
    const store = new TuiStore({ theme: DEFAULT_THEME });
    store.openOptionsPrompt(
      {
        title: "ツール呼び出しを承認しますか?",
        body: "fs:読み取り",
        options: [{ id: "ok", label: "承認" }],
      },
      () => {},
    );
    const { lastFrame } = render(<PromptBox store={store} theme={theme} />);
    expect(lastFrame()).toContain("承認");
  });
});
