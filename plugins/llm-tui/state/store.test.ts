import { describe, it, expect } from "bun:test";
import { TuiStore, type CompletionItem } from "./store.ts";

describe("TuiStore", () => {
  it("appendOutput adds an output line and notifies subscribers", () => {
    const s = new TuiStore();
    let count = 0;
    s.subscribe(() => { count++; });
    s.appendOutput("hello");
    expect(s.snapshot().transcript.length).toBe(1);
    expect(s.snapshot().transcript[0]!.text).toBe("hello");
    expect(s.snapshot().transcript[0]!.kind).toBe("output");
    expect(count).toBe(1);
  });

  it("appendNotice records a notice line", () => {
    const s = new TuiStore();
    s.appendNotice("setup ok");
    const last = s.snapshot().transcript.at(-1)!;
    expect(last.text).toBe("setup ok");
    expect(last.kind).toBe("notice");
  });

  it("setBusy toggles busy with optional message", () => {
    const s = new TuiStore();
    s.setBusy(true, "thinking");
    expect(s.snapshot().busy).toEqual({ active: true, message: "thinking" });
    s.setBusy(false);
    expect(s.snapshot().busy.active).toBe(false);
  });

  it("upsertStatus and clearStatus manage the status map", () => {
    const s = new TuiStore();
    s.upsertStatus("git", "main");
    s.upsertStatus("git", "feat/x");
    expect(s.snapshot().status.git).toBe("feat/x");
    s.clearStatus("git");
    expect(s.snapshot().status.git).toBeUndefined();
  });

  it("setInput records value and cursor", () => {
    const s = new TuiStore();
    s.setInput("abc", 2);
    expect(s.snapshot().input).toEqual({ value: "abc", cursor: 2 });
  });

  it("openPopup, setPopupItems, movePopup, closePopup", () => {
    const s = new TuiStore();
    s.openPopup("/", "");
    expect(s.snapshot().popup?.trigger).toBe("/");
    expect(s.snapshot().popup?.selectedIndex).toBe(0);

    const items: CompletionItem[] = [
      { label: "/help", insertText: "/help " },
      { label: "/exit", insertText: "/exit " },
    ];
    s.setPopupItems(items);
    expect(s.snapshot().popup?.items.length).toBe(2);

    s.movePopup(1);
    expect(s.snapshot().popup?.selectedIndex).toBe(1);
    s.movePopup(1); // wraps
    expect(s.snapshot().popup?.selectedIndex).toBe(0);
    s.movePopup(-1); // wraps to end
    expect(s.snapshot().popup?.selectedIndex).toBe(1);

    s.closePopup();
    expect(s.snapshot().popup).toBeNull();
  });

  it("setPopupQuery updates query and resets selection to 0", () => {
    const s = new TuiStore();
    s.openPopup("/", "");
    s.setPopupItems([{ label: "/a", insertText: "/a" }, { label: "/b", insertText: "/b" }]);
    s.movePopup(1);
    s.setPopupQuery("a");
    expect(s.snapshot().popup?.query).toBe("a");
    expect(s.snapshot().popup?.selectedIndex).toBe(0);
  });

  it("awaitInput resolves on submit and queues if not awaited", async () => {
    const s = new TuiStore();
    const p = s.awaitInput();
    s.submit("hello");
    expect(await p).toBe("hello");

    // Queue path: submit before next awaitInput; the next awaitInput drains.
    s.submit("queued");
    expect(await s.awaitInput()).toBe("queued");
  });

  it("submit appends to history", () => {
    const s = new TuiStore();
    s.submit("first");
    s.submit("second");
    expect(s.snapshot().history).toEqual(["first", "second"]);
  });

  it("unsubscribe stops further notifications", () => {
    const s = new TuiStore();
    let count = 0;
    const off = s.subscribe(() => { count++; });
    s.appendOutput("a");
    off();
    s.appendOutput("b");
    expect(count).toBe(1);
  });
});
