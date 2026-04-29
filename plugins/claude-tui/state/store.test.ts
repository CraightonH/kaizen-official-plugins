import { describe, it, expect } from "bun:test";
import { TuiStore } from "./store.ts";

describe("TuiStore", () => {
  it("appendOutput adds an entry and notifies subscribers", () => {
    const s = new TuiStore();
    let count = 0;
    s.subscribe(() => { count++; });
    s.appendOutput("hello");
    expect(s.snapshot().log.length).toBe(1);
    expect(s.snapshot().log[0]!.text).toBe("hello");
    expect(count).toBe(1);
  });

  it("appendNotice records a dim-styled notice line", () => {
    const s = new TuiStore();
    s.appendNotice("setup ok");
    const last = s.snapshot().log.at(-1)!;
    expect(last.text).toBe("setup ok");
    expect(last.tone).toBe("notice");
  });

  it("setBusy toggles busy with optional message", () => {
    const s = new TuiStore();
    s.setBusy(true, "thinking…");
    expect(s.snapshot().busy).toEqual({ on: true, msg: "thinking…" });
    s.setBusy(false);
    expect(s.snapshot().busy.on).toBe(false);
  });

  it("upsertStatus and clearStatus manage the status map", () => {
    const s = new TuiStore();
    s.upsertStatus({ id: "git", text: "main" });
    s.upsertStatus({ id: "git", text: "feat/x" });
    expect(s.snapshot().status.get("git")?.text).toBe("feat/x");
    s.clearStatus("git");
    expect(s.snapshot().status.has("git")).toBe(false);
  });

  it("clearLog empties the log without touching status", () => {
    const s = new TuiStore();
    s.appendOutput("a");
    s.upsertStatus({ id: "git", text: "main" });
    s.clearLog();
    expect(s.snapshot().log.length).toBe(0);
    expect(s.snapshot().status.size).toBe(1);
  });

  it("awaitInput resolves on next submit and pushes to history", async () => {
    const s = new TuiStore();
    const p = s.awaitInput();
    s.submit("hello");
    expect(await p).toBe("hello");
    expect(s.snapshot().history).toEqual(["hello"]);
  });

  it("submit without pending awaitInput is a no-op for resolution but still records history", () => {
    const s = new TuiStore();
    s.submit("orphan");
    expect(s.snapshot().history).toEqual(["orphan"]);
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
