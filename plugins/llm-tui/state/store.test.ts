import { describe, it, expect } from "bun:test";
import { TuiStore, type CompletionItem, type ToolCallEntry } from "./store.ts";

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

  describe("history view mode", () => {
    function withTwoThoughts() {
      const s = new TuiStore();
      s.appendUser("q1");
      s.appendReasoning("first thought\nmore"); s.finalizeReasoning();
      s.appendOutput("a1");
      s.appendUser("q2");
      s.appendReasoning("second thought"); s.finalizeReasoning();
      s.appendOutput("a2");
      return s;
    }

    it("starts in chat mode with no expanded blocks", () => {
      const s = new TuiStore();
      expect(s.snapshot().viewMode).toBe("chat");
      expect(s.snapshot().historyView.focusIdx).toBe(-1);
      expect(s.snapshot().historyView.expanded.size).toBe(0);
    });

    it("enterHistoryMode focuses the first thought block", () => {
      const s = withTwoThoughts();
      s.enterHistoryMode();
      expect(s.snapshot().viewMode).toBe("history");
      expect(s.snapshot().historyView.focusIdx).toBe(0);
    });

    it("enterHistoryMode with no thoughts has no focus", () => {
      const s = new TuiStore();
      s.appendUser("q"); s.appendOutput("a");
      s.enterHistoryMode();
      expect(s.snapshot().historyView.focusIdx).toBe(-1);
    });

    it("historyMoveFocus wraps", () => {
      const s = withTwoThoughts();
      s.enterHistoryMode();
      s.historyMoveFocus(1);
      expect(s.snapshot().historyView.focusIdx).toBe(1);
      s.historyMoveFocus(1);
      expect(s.snapshot().historyView.focusIdx).toBe(0); // wrap
      s.historyMoveFocus(-1);
      expect(s.snapshot().historyView.focusIdx).toBe(1); // wrap backward
    });

    it("historyToggleFocused toggles only the focused block", () => {
      const s = withTwoThoughts();
      s.enterHistoryMode();
      const blocks = s.snapshot().transcript.filter((e) => e.kind === "thoughts");
      const [b0, b1] = [blocks[0]!.id, blocks[1]!.id];
      s.historyToggleFocused();
      expect(s.snapshot().historyView.expanded.has(b0)).toBe(true);
      expect(s.snapshot().historyView.expanded.has(b1)).toBe(false);
      s.historyMoveFocus(1);
      s.historyToggleFocused();
      expect(s.snapshot().historyView.expanded.has(b1)).toBe(true);
      s.historyToggleFocused();
      expect(s.snapshot().historyView.expanded.has(b1)).toBe(false);
    });

    it("historySetAllExpanded(true|false) flips every block", () => {
      const s = withTwoThoughts();
      s.enterHistoryMode();
      s.historySetAllExpanded(true);
      expect(s.snapshot().historyView.expanded.size).toBe(2);
      s.historySetAllExpanded(false);
      expect(s.snapshot().historyView.expanded.size).toBe(0);
    });

    it("history mutations are no-ops in chat mode", () => {
      const s = withTwoThoughts();
      s.historyMoveFocus(1);
      s.historyToggleFocused();
      s.historySetAllExpanded(true);
      expect(s.snapshot().viewMode).toBe("chat");
      expect(s.snapshot().historyView.expanded.size).toBe(0);
    });

    it("exitHistoryMode returns to chat", () => {
      const s = withTwoThoughts();
      s.enterHistoryMode();
      s.exitHistoryMode();
      expect(s.snapshot().viewMode).toBe("chat");
    });
  });

  describe("live tool calls", () => {
    it("appendLiveToolCall adds to liveToolCalls, not transcript", () => {
      const store = new TuiStore();
      store.appendLiveToolCall("call-1", "read_file", { path: "/etc/hosts" });
      const snap = store.snapshot();
      expect(snap.transcript).toHaveLength(0);
      expect(snap.liveToolCalls.size).toBe(1);
      const e = snap.liveToolCalls.get("call-1")!;
      expect(e.name).toBe("read_file");
      expect(e.status).toBe("running");
      expect(e.args).toEqual({ path: "/etc/hosts" });
    });

    it("updateLiveToolCall accumulates stdout deltas in liveToolCalls", () => {
      const store = new TuiStore();
      store.appendLiveToolCall("c1", "execute_typescript", { code: "x" });
      store.updateLiveToolCall("c1", { stdoutDelta: "a" });
      store.updateLiveToolCall("c1", { stdoutDelta: "b" });
      const e = store.snapshot().liveToolCalls.get("c1")!;
      expect(e.stdout).toBe("ab");
    });

    it("updateLiveToolCall on unknown id is a no-op", () => {
      const store = new TuiStore();
      expect(() => store.updateLiveToolCall("missing", { stdoutDelta: "x" })).not.toThrow();
      expect(store.snapshot().liveToolCalls.size).toBe(0);
    });

    it("finalizeLiveToolCall moves entry from liveToolCalls into transcript", () => {
      const store = new TuiStore();
      store.appendLiveToolCall("c1", "read_file", { path: "/x" });
      store.updateLiveToolCall("c1", { result: "data" });
      store.finalizeLiveToolCall("c1", "done");
      const snap = store.snapshot();
      expect(snap.liveToolCalls.size).toBe(0);
      expect(snap.transcript).toHaveLength(1);
      const e = snap.transcript[0] as ToolCallEntry;
      expect(e.kind).toBe("tool_call");
      expect(e.status).toBe("done");
      expect(e.result).toBe("data");
    });

    it("finalizeLiveToolCall on unknown id is a no-op", () => {
      const store = new TuiStore();
      expect(() => store.finalizeLiveToolCall("missing", "done")).not.toThrow();
      expect(store.snapshot().transcript).toHaveLength(0);
    });

    it("hasLiveToolCall reflects liveToolCalls membership", () => {
      const store = new TuiStore();
      expect(store.hasLiveToolCall("c1")).toBe(false);
      store.appendLiveToolCall("c1", "x", {});
      expect(store.hasLiveToolCall("c1")).toBe(true);
      store.finalizeLiveToolCall("c1", "done");
      expect(store.hasLiveToolCall("c1")).toBe(false);
    });

    it("appendToolCallToTranscript appends a finalized entry directly (no live phase)", () => {
      const store = new TuiStore();
      store.appendToolCallToTranscript("c1", "read_file", { path: "/x" }, "error", undefined, "unknown tool");
      const snap = store.snapshot();
      expect(snap.liveToolCalls.size).toBe(0);
      expect(snap.transcript).toHaveLength(1);
      const e = snap.transcript[0] as ToolCallEntry;
      expect(e.status).toBe("error");
      expect(e.errorMessage).toBe("unknown tool");
    });

    it("clearLiveToolCalls drops in-flight entries (used on turn:end rollback)", () => {
      const store = new TuiStore();
      store.appendLiveToolCall("c1", "read_file", {});
      store.clearLiveToolCalls();
      expect(store.snapshot().liveToolCalls.size).toBe(0);
    });

    it("snapshot identity changes on every mutation", () => {
      const store = new TuiStore();
      const s1 = store.snapshot();
      store.appendLiveToolCall("c1", "x", {});
      const s2 = store.snapshot();
      expect(s2).not.toBe(s1);
      expect(s2.liveToolCalls).not.toBe(s1.liveToolCalls);
    });
  });

  describe("paste registry", () => {
    it("registerPaste returns id+placeholder, with line count baked in", () => {
      const s = new TuiStore();
      const r1 = s.registerPaste("one line");
      expect(r1.id).toBe(1);
      expect(r1.placeholder).toBe("[Pasted text #1 +1 line]");
      const r2 = s.registerPaste("a\nb\nc");
      expect(r2.id).toBe(2);
      expect(r2.placeholder).toBe("[Pasted text #2 +3 lines]");
    });

    it("resolvePastes substitutes content for placeholders", () => {
      const s = new TuiStore();
      const r = s.registerPaste("HELLO\nWORLD");
      const line = `before ${r.placeholder} after`;
      expect(s.resolvePastes(line)).toBe("before HELLO\nWORLD after");
    });

    it("resolvePastes leaves unknown placeholders alone", () => {
      const s = new TuiStore();
      const line = "[Pasted text #999 +1 line]";
      expect(s.resolvePastes(line)).toBe(line);
    });

    it("clearPastes drops content but does not reset ids", () => {
      const s = new TuiStore();
      s.registerPaste("a"); s.registerPaste("b");
      s.clearPastes();
      const r = s.registerPaste("c");
      expect(r.id).toBe(3); // continues from prior seq
      // Old ids are gone:
      expect(s.resolvePastes("[Pasted text #1 +1 line]")).toBe("[Pasted text #1 +1 line]");
    });
  });
});
