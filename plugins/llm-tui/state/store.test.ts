import { describe, it, expect } from "bun:test";
import { TuiStore, type CompletionItem, type ToolCallEntry } from "./store.ts";

describe("TuiStore", () => {
  it("appendOutput adds an output line and notifies subscribers", () => {
    const s = new TuiStore();
    let count = 0;
    s.subscribe(() => { count++; });
    s.appendOutput("hello");
    const entry = s.snapshot().transcript[0]!;
    expect(s.snapshot().transcript.length).toBe(1);
    expect(entry.kind).toBe("output");
    if (entry.kind !== "output") throw new Error("expected output line");
    expect(entry.text).toBe("hello");
    expect(count).toBe(1);
  });

  it("appendUser records a user line without handoffFrom by default", () => {
    const s = new TuiStore();
    s.appendUser("hi");
    const last = s.snapshot().transcript.at(-1)! as any;
    expect(last.kind).toBe("user");
    expect(last.text).toBe("hi");
    expect(last.handoffFrom).toBeUndefined();
  });

  it("appendUser with handoffFrom records the marker on the entry", () => {
    const s = new TuiStore();
    s.appendUser("hi", { handoffFrom: "abc" });
    const last = s.snapshot().transcript.at(-1)! as any;
    expect(last.kind).toBe("user");
    expect(last.text).toBe("hi");
    expect(last.handoffFrom).toBe("abc");
  });

  it("appendNotice records a notice line", () => {
    const s = new TuiStore();
    s.appendNotice("setup ok");
    const last = s.snapshot().transcript.at(-1)!;
    expect(last.kind).toBe("notice");
    if (last.kind !== "notice") throw new Error("expected notice line");
    expect(last.text).toBe("setup ok");
  });

  it("setBusy toggles busy with optional message", () => {
    const s = new TuiStore();
    s.setBusy(true, "thinking");
    expect(s.snapshot().busy).toEqual({ active: true, message: "thinking" });
    s.setBusy(false);
    expect(s.snapshot().busy.active).toBe(false);
  });

  it("setBusyTiming records start time and zeroes the token delta", () => {
    const s = new TuiStore();
    const now = Date.now();
    s.setBusy(true, "thinking");
    s.setBusyTiming(now);
    expect(s.snapshot().busy).toEqual({ active: true, message: "thinking", startedAt: now, deltaTokens: 0 });
  });

  it("updateBusyTokens sets the absolute count", () => {
    const s = new TuiStore();
    s.setBusy(true, "thinking");
    s.setBusyTiming(Date.now());
    s.updateBusyTokens(856);
    expect(s.snapshot().busy.deltaTokens).toBe(856);
  });

  it("incrementBusyTokens accumulates streamed tokens", () => {
    const s = new TuiStore();
    s.setBusy(true, "thinking");
    s.setBusyTiming(Date.now());
    s.incrementBusyTokens();
    s.incrementBusyTokens();
    s.incrementBusyTokens(3);
    expect(s.snapshot().busy.deltaTokens).toBe(5);
  });

  it("clearBusyTiming resets everything", () => {
    const s = new TuiStore();
    s.setBusy(true, "thinking");
    s.setBusyTiming(Date.now());
    s.updateBusyTokens(856);
    s.clearBusyTiming();
    expect(s.snapshot().busy).toEqual({ active: false });
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

    it("enterHistoryMode focuses across thoughts and tool_calls in transcript order", () => {
      const store = new TuiStore();
      store.appendUser("hi");
      store.appendReasoning("thinking…");
      store.finalizeReasoning();
      store.appendToolCallToTranscript("c1", "read_file", { path: "/x" }, "done", "ok");
      store.enterHistoryMode();
      const snap = store.snapshot();
      expect(snap.viewMode).toBe("history");
      expect(snap.historyView.focusIdx).toBe(0); // thoughts first (transcript order)
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

    it("appendAgentActivity pushes onto the rolling buffer for a live tool call", () => {
      const store = new TuiStore();
      store.appendLiveToolCall("c1", "dispatch_agent", { agent_name: "a" });
      store.appendAgentActivity("c1", "first line");
      store.appendAgentActivity("c1", "second line");
      const e = store.snapshot().liveToolCalls.get("c1")!;
      expect(e.agentActivity).toEqual(["first line", "second line"]);
    });

    it("appendAgentActivity caps the buffer at AGENT_ACTIVITY_CAP, dropping oldest entries", async () => {
      const { AGENT_ACTIVITY_CAP } = await import("./store.ts");
      const store = new TuiStore();
      store.appendLiveToolCall("c1", "dispatch_agent", {});
      for (let i = 0; i < AGENT_ACTIVITY_CAP + 3; i++) store.appendAgentActivity("c1", `line ${i}`);
      const e = store.snapshot().liveToolCalls.get("c1")!;
      expect(e.agentActivity).toHaveLength(AGENT_ACTIVITY_CAP);
      expect(e.agentActivity![0]).toBe(`line 3`);
      expect(e.agentActivity![AGENT_ACTIVITY_CAP - 1]).toBe(`line ${AGENT_ACTIVITY_CAP + 2}`);
    });

    it("appendAgentActivity is a no-op for unknown callId", () => {
      const store = new TuiStore();
      expect(() => store.appendAgentActivity("missing", "line")).not.toThrow();
      expect(store.snapshot().liveToolCalls.size).toBe(0);
    });

    it("finalizeLiveToolCall preserves agentActivity on the transcript entry", () => {
      const store = new TuiStore();
      store.appendLiveToolCall("c1", "dispatch_agent", {});
      store.appendAgentActivity("c1", "did something");
      store.finalizeLiveToolCall("c1", "done");
      const e = store.snapshot().transcript[0] as ToolCallEntry;
      expect(e.agentActivity).toEqual(["did something"]);
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

  it("appendOutput defaults to no markdown flag on the entry", () => {
    const s = new TuiStore();
    s.appendOutput("hello");
    const e = s.snapshot().transcript[0]! as any;
    expect(e.markdown).toBeUndefined();
  });

  it("appendOutput records markdown: false when explicitly opted out", () => {
    const s = new TuiStore();
    s.appendOutput("raw", { markdown: false });
    const e = s.snapshot().transcript[0]! as any;
    expect(e.markdown).toBe(false);
  });

  it("appendNotice records markdown: true when opted in", () => {
    const s = new TuiStore();
    s.appendNotice("# heading", { markdown: true });
    const e = s.snapshot().transcript[0]! as any;
    expect(e.kind).toBe("notice");
    expect(e.markdown).toBe(true);
  });

  it("appendNotice without opts leaves markdown undefined", () => {
    const s = new TuiStore();
    s.appendNotice("plain");
    const e = s.snapshot().transcript[0]! as any;
    expect(e.markdown).toBeUndefined();
  });

  it("appendUser records markdown: true when opted in (handoffFrom unaffected)", () => {
    const s = new TuiStore();
    s.appendUser("**hi**", { markdown: true, handoffFrom: "abc" });
    const e = s.snapshot().transcript[0]! as any;
    expect(e.kind).toBe("user");
    expect(e.markdown).toBe(true);
    expect(e.handoffFrom).toBe("abc");
  });

  it("two consecutive writes with different flags produce two distinct entries", () => {
    const s = new TuiStore();
    s.appendNotice("plain");
    s.appendNotice("# md", { markdown: true });
    const t = s.snapshot().transcript as any[];
    expect(t).toHaveLength(2);
    expect(t[0].markdown).toBeUndefined();
    expect(t[1].markdown).toBe(true);
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

describe("TuiStore — prompt slice (open)", () => {
  it("starts with prompt = null", () => {
    const s = new TuiStore();
    expect(s.snapshot().prompt).toBeNull();
  });

  it("openOptionsPrompt sets the slice with defaults", () => {
    const s = new TuiStore();
    let resolved: any = null;
    s.openOptionsPrompt(
      {
        title: "T",
        body: "B",
        options: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
      },
      (r) => { resolved = r; },
    );
    const slice = s.snapshot().prompt;
    expect(slice).not.toBeNull();
    expect(slice!.kind).toBe("options");
    if (slice!.kind === "options") {
      expect(slice!.selectedIndex).toBe(0);
      expect(slice!.expanded).toBeNull();
      expect(slice!.request.options.length).toBe(2);
    }
    expect(resolved).toBeNull(); // open does not resolve
  });

  it("openOptionsPrompt honors defaultId", () => {
    const s = new TuiStore();
    s.openOptionsPrompt(
      { title: "T", body: "B", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], defaultId: "b" },
      () => {},
    );
    const slice = s.snapshot().prompt;
    expect(slice!.kind === "options" && slice!.selectedIndex).toBe(1);
  });

  it("openTextPrompt sets kind=text with defaultValue", () => {
    const s = new TuiStore();
    s.openTextPrompt({ title: "T", defaultValue: "hello" }, () => {});
    const slice = s.snapshot().prompt;
    expect(slice!.kind).toBe("text");
    if (slice!.kind === "text") {
      expect(slice!.text).toBe("hello");
    }
  });

  it("openTextPrompt defaults text to empty string", () => {
    const s = new TuiStore();
    s.openTextPrompt({ title: "T" }, () => {});
    const slice = s.snapshot().prompt;
    expect(slice!.kind === "text" && slice!.text).toBe("");
  });

  it("snapshot identity changes when prompt opens", () => {
    const s = new TuiStore();
    const a = s.snapshot();
    s.openOptionsPrompt({ title: "T", body: "B", options: [{ id: "a", label: "A" }] }, () => {});
    const b = s.snapshot();
    expect(b).not.toBe(a);
  });
});

describe("TuiStore — prompt slice (navigation)", () => {
  const openTwo = (s: TuiStore) => {
    s.openOptionsPrompt(
      {
        title: "T",
        body: "B",
        options: [
          { id: "a", label: "A" },
          { id: "b", label: "B", expandsTo: { kind: "text", placeholder: "p" } },
        ],
      },
      () => {},
    );
  };

  it("moveSelection clamps to [0, length-1]", () => {
    const s = new TuiStore();
    openTwo(s);
    s.moveSelection(-1);
    expect(s.snapshot().prompt!.kind === "options" && s.snapshot().prompt!.selectedIndex).toBe(0);
    s.moveSelection(1);
    expect(s.snapshot().prompt!.kind === "options" && s.snapshot().prompt!.selectedIndex).toBe(1);
    s.moveSelection(1);
    expect(s.snapshot().prompt!.kind === "options" && s.snapshot().prompt!.selectedIndex).toBe(1);
  });

  it("moveSelection is a no-op when prompt is text or null", () => {
    const s = new TuiStore();
    s.moveSelection(1);
    expect(s.snapshot().prompt).toBeNull();
    s.openTextPrompt({ title: "T" }, () => {});
    s.moveSelection(1);
    expect(s.snapshot().prompt!.kind).toBe("text");
  });

  it("tabExpand only expands when selected option has expandsTo", () => {
    const s = new TuiStore();
    openTwo(s);
    s.tabExpand();
    expect(s.snapshot().prompt!.kind === "options" && s.snapshot().prompt!.expanded).toBeNull();
    s.moveSelection(1);
    s.tabExpand();
    const slice = s.snapshot().prompt;
    expect(slice!.kind === "options" && slice!.expanded).toEqual({ id: "b", text: "" });
  });

  it("tabExpand uses defaultValue when expandsTo provides one", () => {
    const s = new TuiStore();
    s.openOptionsPrompt(
      {
        title: "T",
        body: "B",
        options: [{ id: "x", label: "X", expandsTo: { kind: "text", defaultValue: "seed" } }],
      },
      () => {},
    );
    s.tabExpand();
    const slice = s.snapshot().prompt;
    expect(slice!.kind === "options" && slice!.expanded).toEqual({ id: "x", text: "seed" });
  });

  it("collapseExpansion clears expanded (discarding text)", () => {
    const s = new TuiStore();
    openTwo(s);
    s.moveSelection(1);
    s.tabExpand();
    s.setExpandedText("typed");
    s.collapseExpansion();
    const slice = s.snapshot().prompt;
    expect(slice!.kind === "options" && slice!.expanded).toBeNull();
  });

  it("setExpandedText replaces the expanded text", () => {
    const s = new TuiStore();
    openTwo(s);
    s.moveSelection(1);
    s.tabExpand();
    s.setExpandedText("new");
    const slice = s.snapshot().prompt;
    expect(slice!.kind === "options" && slice!.expanded?.text).toBe("new");
  });

  it("setExpandedText is a no-op when not expanded", () => {
    const s = new TuiStore();
    openTwo(s);
    s.setExpandedText("ignored");
    const slice = s.snapshot().prompt;
    expect(slice!.kind === "options" && slice!.expanded).toBeNull();
  });

  it("setStandaloneText replaces text in text mode", () => {
    const s = new TuiStore();
    s.openTextPrompt({ title: "T" }, () => {});
    s.setStandaloneText("hello");
    expect(s.snapshot().prompt!.kind === "text" && s.snapshot().prompt!.text).toBe("hello");
  });
});

describe("TuiStore — prompt slice (submit/escape)", () => {
  it("submitPrompt resolves with result and clears the slice", () => {
    const s = new TuiStore();
    let resolved: any = null;
    s.openOptionsPrompt(
      { title: "Approve?", body: "B", options: [{ id: "ok", label: "OK" }] },
      (r) => { resolved = r; },
    );
    s.submitPrompt({ id: "ok" });
    expect(resolved).toEqual({ id: "ok" });
    expect(s.snapshot().prompt).toBeNull();
  });

  it("submitPrompt for options appends a notice transcript entry", () => {
    const s = new TuiStore();
    s.openOptionsPrompt(
      { title: "Approve?", body: "B", options: [{ id: "ok", label: "OK" }] },
      () => {},
    );
    s.submitPrompt({ id: "ok" });
    const entries = s.snapshot().transcript.filter((e) => e.kind === "notice");
    const last = entries.at(-1)!;
    expect((last as any).text).toBe("? Approve? → OK");
  });

  it("submitPrompt for options with text appends '<label>: <text>'", () => {
    const s = new TuiStore();
    s.openOptionsPrompt(
      {
        title: "Approve?",
        body: "B",
        options: [{ id: "deny", label: "Deny", expandsTo: { kind: "text" } }],
      },
      () => {},
    );
    s.submitPrompt({ id: "deny", text: "looks dangerous" });
    const entries = s.snapshot().transcript.filter((e) => e.kind === "notice");
    const last = entries.at(-1)!;
    expect((last as any).text).toBe("? Approve? → Deny: looks dangerous");
  });

  it("submitPrompt for text appends '<text>' or '(skipped)'", () => {
    const s1 = new TuiStore();
    s1.openTextPrompt({ title: "Reason?" }, () => {});
    s1.submitPrompt("because");
    const t1 = s1.snapshot().transcript.filter((e) => e.kind === "notice").at(-1)!;
    expect((t1 as any).text).toBe("? Reason? → because");

    const s2 = new TuiStore();
    s2.openTextPrompt({ title: "Reason?" }, () => {});
    s2.submitPrompt("");
    const t2 = s2.snapshot().transcript.filter((e) => e.kind === "notice").at(-1)!;
    expect((t2 as any).text).toBe("? Reason? → (skipped)");
  });

  it("submitPrompt is a no-op when no prompt is active", () => {
    const s = new TuiStore();
    const before = s.snapshot();
    s.submitPrompt({ id: "x" } as any);
    expect(s.snapshot()).toBe(before);
  });

  it("escapePrompt resolves options with cancelId (or last option) and clears", () => {
    const s = new TuiStore();
    let resolved: any = null;
    s.openOptionsPrompt(
      { title: "T", body: "B", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] },
      (r) => { resolved = r; },
    );
    s.escapePrompt();
    expect(resolved).toEqual({ id: "b" });
    expect(s.snapshot().prompt).toBeNull();
  });

  it("escapePrompt honors explicit cancelId on options request", () => {
    const s = new TuiStore();
    let resolved: any = null;
    s.openOptionsPrompt(
      { title: "T", body: "B", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], cancelId: "a" },
      (r) => { resolved = r; },
    );
    s.escapePrompt();
    expect(resolved).toEqual({ id: "a" });
  });

  it("escapePrompt resolves text with empty string", () => {
    const s = new TuiStore();
    let resolved: string | null = null;
    s.openTextPrompt({ title: "T", defaultValue: "x" }, (t) => { resolved = t; });
    s.escapePrompt();
    expect(resolved).toBe("");
    expect(s.snapshot().prompt).toBeNull();
  });
});

describe("TuiStore.latestOutputText", () => {
  it("returns null on empty transcript", () => {
    const s = new TuiStore();
    expect(s.latestOutputText()).toBeNull();
  });

  it("returns null when transcript has only non-output kinds", () => {
    const s = new TuiStore();
    s.appendNotice("hello");
    s.appendUser("hi");
    expect(s.latestOutputText()).toBeNull();
  });

  it("returns the text of the only output entry", () => {
    const s = new TuiStore();
    s.appendNotice("ignored");
    s.appendOutput("the answer");
    expect(s.latestOutputText()).toBe("the answer");
  });

  it("returns the most recent output across mixed kinds", () => {
    const s = new TuiStore();
    s.appendOutput("first");
    s.appendNotice("note");
    s.appendUser("question");
    s.appendOutput("second");
    s.appendNotice("done");
    expect(s.latestOutputText()).toBe("second");
  });
});
