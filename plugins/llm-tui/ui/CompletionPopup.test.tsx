import React from "react";
import { describe, it, expect } from "bun:test";
import { render } from "ink-testing-library";
import { CompletionPopup } from "./CompletionPopup.tsx";
import type { PopupState } from "../state/store.ts";

function popup(items: PopupState["items"], selectedIndex = 0, query = ""): PopupState {
  return { trigger: "/", query, items, selectedIndex, triggerPos: 0 };
}

describe("CompletionPopup", () => {
  it("renders 'no matches' when items is empty", () => {
    const { lastFrame } = render(
      <CompletionPopup popup={popup([])} noticeColor="yellow" />,
    );
    expect(lastFrame()).toContain("no matches");
  });

  it("renders multiple items and marks selected", () => {
    const { lastFrame } = render(
      <CompletionPopup
        popup={popup([
          { label: "/help", detail: "show help", insertText: "/help " },
          { label: "/exit", insertText: "/exit " },
        ], 1)}
        noticeColor="yellow"
      />,
    );
    const f = lastFrame() ?? "";
    expect(f).toContain("/help");
    expect(f).toContain("show help");
    expect(f).toContain("/exit");
    expect(f).toContain("›"); // selected marker on second row
  });

  it("renders multi-byte (CJK) labels", () => {
    const { lastFrame } = render(
      <CompletionPopup
        popup={popup([{ label: "/帮助", insertText: "/帮助" }])}
        noticeColor="yellow"
      />,
    );
    expect(lastFrame()).toContain("/帮助");
  });

  it("caps visible items at 8 and shows '… N more'", () => {
    const items = Array.from({ length: 10 }, (_, i) => ({
      label: `/cmd${i}`, insertText: `/cmd${i}`,
    }));
    const { lastFrame } = render(
      <CompletionPopup popup={popup(items)} noticeColor="yellow" />,
    );
    const f = lastFrame() ?? "";
    expect(f).toContain("/cmd0");
    expect(f).toContain("/cmd7");
    expect(f).not.toContain("/cmd8");
    expect(f).toContain("2 more");
  });
});
