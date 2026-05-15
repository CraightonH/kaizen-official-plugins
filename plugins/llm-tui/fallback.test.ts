import { describe, it, expect } from "bun:test";
import { createFallbackChannel, createFallbackPrompt } from "./fallback.ts";
import type { UiPromptService } from "llm-contracts/public";

describe("createFallbackChannel", () => {
  it("writeNotice without opts writes raw text to stderr", () => {
    const writes: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (s: string) => { writes.push(s); return true; };
    try {
      const ch = createFallbackChannel();
      ch.writeNotice("**plain**");
      expect(writes.join("")).toBe("**plain**\n");
    } finally {
      (process.stderr as any).write = origWrite;
    }
  });

  it("writeNotice with markdown:true writes ANSI to stderr (not raw asterisks)", () => {
    const writes: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (s: string) => { writes.push(s); return true; };
    try {
      const ch = createFallbackChannel();
      ch.writeNotice("**md**", { markdown: true });
      const out = writes.join("");
      // renderMarkdown strips the ** markers and adds ANSI bold instead
      expect(out.includes("**md**")).toBe(false);
      expect(out.includes("md")).toBe(true);
    } finally {
      (process.stderr as any).write = origWrite;
    }
  });

  it("writeOutput without opts writes raw text to stdout (markdown defaults true for output)", () => {
    const writes: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    (process.stdout as any).write = (s: string) => { writes.push(s); return true; };
    try {
      const ch = createFallbackChannel();
      ch.writeOutput("plain text");
      // When markdown defaults on, plain prose passes through unchanged
      // (no markdown syntax to transform).
      const out = writes.join("");
      expect(out.includes("plain text")).toBe(true);
    } finally {
      (process.stdout as any).write = origWrite;
    }
  });

  it("writeOutput with markdown:false writes raw chunk to stdout", () => {
    const writes: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    (process.stdout as any).write = (s: string) => { writes.push(s); return true; };
    try {
      const ch = createFallbackChannel();
      ch.writeOutput("**raw**", { markdown: false });
      expect(writes.join("")).toBe("**raw**");
    } finally {
      (process.stdout as any).write = origWrite;
    }
  });

  it("no-op methods do not throw", () => {
    const ch = createFallbackChannel();
    expect(() => ch.setBusy(true, "x")).not.toThrow();
    expect(() => ch.setBusyTiming(Date.now())).not.toThrow();
    expect(() => ch.updateBusyTokens(5)).not.toThrow();
    expect(() => ch.incrementBusyTokens(1)).not.toThrow();
    expect(() => ch.appendReasoning("delta")).not.toThrow();
    expect(() => ch.finalizeReasoning()).not.toThrow();
    expect(() => ch.clearLiveThinking()).not.toThrow();
    expect(() => ch.setInputDraft("text")).not.toThrow();
  });
});

describe("fallback ui:prompt", () => {
  it("requestOption resolves to cancelId if set", async () => {
    const svc: UiPromptService = createFallbackPrompt();
    const out = await svc.requestOption({
      title: "T",
      body: "B",
      options: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
      cancelId: "a",
    });
    expect(out).toEqual({ id: "a" });
  });

  it("requestOption falls back to last option when cancelId absent", async () => {
    const svc = createFallbackPrompt();
    const out = await svc.requestOption({
      title: "T",
      body: "B",
      options: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
    });
    expect(out).toEqual({ id: "b" });
  });

  it("requestText resolves to empty string", async () => {
    const svc = createFallbackPrompt();
    await expect(svc.requestText({ title: "T" })).resolves.toBe("");
  });
});
