import { describe, it, expect, mock } from "bun:test";
import { CANCEL_TOOL } from "llm-events";
import type { ToolBeforeExecutePayload } from "llm-contracts/public";
import { makeSubscriber, type SubscriberDeps } from "../subscriber.ts";

function makeDeps(over: Partial<SubscriberDeps> = {}): SubscriberDeps {
  return {
    isPaused: () => false,
    rules: () => ({ allow: [], deny: [] }),
    summarize: (name: string, args: unknown) => `${name}\n${JSON.stringify(args)}`,
    prompt: {
      requestOption: async () => ({ id: "approve-once" as const }),
      requestText: async () => "",
    },
    persistAllow: () => {},
    writeNotice: () => {},
    log: () => {},
    ...over,
  };
}

const mkPayload = (over: Partial<ToolBeforeExecutePayload> = {}): ToolBeforeExecutePayload => ({
  name: "fs:read_file",
  args: { path: "/tmp/x" },
  callId: "c1",
  ...over,
});

describe("subscriber — pre-emption / paused / matching", () => {
  it("returns immediately when payload is already cancelled", async () => {
    const promptSpy = mock(async () => ({ id: "approve-once" as const }));
    const sub = makeSubscriber(makeDeps({ prompt: { requestOption: promptSpy, requestText: async () => "" } }));
    const p = mkPayload({ args: CANCEL_TOOL });
    await sub(p);
    expect(promptSpy).not.toHaveBeenCalled();
    expect(p.args).toBe(CANCEL_TOOL);
  });

  it("paused → no-op (does not prompt, does not mutate args)", async () => {
    const promptSpy = mock(async () => ({ id: "approve-once" as const }));
    const sub = makeSubscriber(
      makeDeps({ isPaused: () => true, prompt: { requestOption: promptSpy, requestText: async () => "" } }),
    );
    const p = mkPayload();
    await sub(p);
    expect(promptSpy).not.toHaveBeenCalled();
    expect(p.args).toEqual({ path: "/tmp/x" });
  });

  it("deny rule short-circuits → CANCEL_TOOL with config reason", async () => {
    const noticeSpy = mock(() => {});
    const sub = makeSubscriber(makeDeps({
      rules: () => ({ allow: [], deny: ["fs:read_file"] }),
      writeNotice: noticeSpy,
    }));
    const p = mkPayload();
    await sub(p);
    expect(p.args).toBe(CANCEL_TOOL);
    expect(p.cancelReason).toBe("Denied by allow/deny config rule.");
    expect(noticeSpy).toHaveBeenCalled();
  });

  it("allow rule short-circuits → no prompt, no mutation", async () => {
    const promptSpy = mock(async () => ({ id: "approve-once" as const }));
    const sub = makeSubscriber(makeDeps({
      rules: () => ({ allow: ["fs:*"], deny: [] }),
      prompt: { requestOption: promptSpy, requestText: async () => "" },
    }));
    const p = mkPayload();
    await sub(p);
    expect(promptSpy).not.toHaveBeenCalled();
    expect(p.args).toEqual({ path: "/tmp/x" });
  });

  it("deny wins over allow within the same source", async () => {
    const sub = makeSubscriber(makeDeps({
      rules: () => ({ allow: ["fs:*"], deny: ["fs:read_file"] }),
    }));
    const p = mkPayload();
    await sub(p);
    expect(p.args).toBe(CANCEL_TOOL);
  });
});

describe("subscriber — prompt outcomes", () => {
  it("approve-once → no-op", async () => {
    const persistSpy = mock(() => {});
    const sub = makeSubscriber(makeDeps({
      prompt: { requestOption: async () => ({ id: "approve-once" }), requestText: async () => "" },
      persistAllow: persistSpy,
    }));
    const p = mkPayload();
    await sub(p);
    expect(p.args).toEqual({ path: "/tmp/x" });
    expect(persistSpy).not.toHaveBeenCalled();
  });

  it("approve-always → persists exact name to allow", async () => {
    const persisted: string[] = [];
    const sub = makeSubscriber(makeDeps({
      prompt: { requestOption: async () => ({ id: "approve-always" }), requestText: async () => "" },
      persistAllow: (entry) => { persisted.push(entry); },
    }));
    const p = mkPayload();
    await sub(p);
    expect(persisted).toEqual(["fs:read_file"]);
    expect(p.args).toEqual({ path: "/tmp/x" });
  });

  it("approve-domain-always → persists domain glob", async () => {
    const persisted: string[] = [];
    const sub = makeSubscriber(makeDeps({
      prompt: { requestOption: async () => ({ id: "approve-domain-always" }), requestText: async () => "" },
      persistAllow: (entry) => { persisted.push(entry); },
    }));
    const p = mkPayload({ name: "mcp:github:list_issues" });
    await sub(p);
    expect(persisted).toEqual(["mcp:github:*"]);
  });

  it("approve-domain-always falls through to no-op when name has no domain", async () => {
    const persisted: string[] = [];
    const logs: string[] = [];
    const sub = makeSubscriber(makeDeps({
      prompt: { requestOption: async () => ({ id: "approve-domain-always" }), requestText: async () => "" },
      persistAllow: (entry) => { persisted.push(entry); },
      log: (msg) => { logs.push(msg); },
    }));
    const p = mkPayload({ name: "execute_typescript", args: { code: "x" } });
    await sub(p);
    expect(persisted).toEqual([]);
    expect(p.args).toEqual({ code: "x" });
    expect(logs.some((l) => l.includes("approve-domain-always"))).toBe(true);
  });

  it("deny without reason → CANCEL_TOOL with default reason", async () => {
    const sub = makeSubscriber(makeDeps({
      prompt: { requestOption: async () => ({ id: "deny" }), requestText: async () => "" },
    }));
    const p = mkPayload();
    await sub(p);
    expect(p.args).toBe(CANCEL_TOOL);
    expect(p.cancelReason).toBe("User denied this tool call.");
  });

  it("deny with reason → CANCEL_TOOL with user reason", async () => {
    const sub = makeSubscriber(makeDeps({
      prompt: { requestOption: async () => ({ id: "deny", text: "feels dangerous" }), requestText: async () => "" },
    }));
    const p = mkPayload();
    await sub(p);
    expect(p.args).toBe(CANCEL_TOOL);
    expect(p.cancelReason).toBe("feels dangerous");
  });

  it("approve-always with persistence failure → notice + approve-once outcome", async () => {
    const notices: string[] = [];
    const sub = makeSubscriber(makeDeps({
      prompt: { requestOption: async () => ({ id: "approve-always" }), requestText: async () => "" },
      persistAllow: () => { throw new Error("disk full"); },
      writeNotice: (msg) => { notices.push(msg); },
    }));
    const p = mkPayload();
    await sub(p);
    expect(p.args).toEqual({ path: "/tmp/x" });
    expect(notices.some((m) => m.includes("Failed to persist") && m.includes("disk full"))).toBe(true);
  });
});

describe("subscriber — prompt construction", () => {
  it("hides Approve Domain Always when name has no colon", async () => {
    let captured: any = null;
    const sub = makeSubscriber(makeDeps({
      prompt: {
        requestOption: async (req) => { captured = req; return { id: "approve-once" }; },
        requestText: async () => "",
      },
    }));
    await sub(mkPayload({ name: "execute_typescript" }));
    const optionIds = captured.options.map((o: any) => o.id);
    expect(optionIds).not.toContain("approve-domain-always");
    expect(optionIds).toEqual(expect.arrayContaining(["approve-once", "approve-always", "deny"]));
  });

  it("includes Approve Domain Always when name has a domain", async () => {
    let captured: any = null;
    const sub = makeSubscriber(makeDeps({
      prompt: {
        requestOption: async (req) => { captured = req; return { id: "approve-once" }; },
        requestText: async () => "",
      },
    }));
    await sub(mkPayload({ name: "mcp:github:list_issues" }));
    const optionIds = captured.options.map((o: any) => o.id);
    expect(optionIds).toContain("approve-domain-always");
    const dom = captured.options.find((o: any) => o.id === "approve-domain-always");
    expect(dom.label).toContain("mcp:github:*");
  });

  it("body is the summarize() output", async () => {
    let captured: any = null;
    const sub = makeSubscriber(makeDeps({
      summarize: () => "SUMMARY",
      prompt: {
        requestOption: async (req) => { captured = req; return { id: "approve-once" }; },
        requestText: async () => "",
      },
    }));
    await sub(mkPayload());
    expect(captured.body).toBe("SUMMARY");
  });

  it("Deny option has expandsTo for inline reason", async () => {
    let captured: any = null;
    const sub = makeSubscriber(makeDeps({
      prompt: {
        requestOption: async (req) => { captured = req; return { id: "approve-once" }; },
        requestText: async () => "",
      },
    }));
    await sub(mkPayload());
    const deny = captured.options.find((o: any) => o.id === "deny");
    expect(deny.expandsTo).toEqual({ kind: "text", placeholder: "Reason (optional)" });
  });
});

describe("subscriber — bash safety override", () => {
  it("force-prompts when bash command has shell metacharacters even if name-allow rule would approve", async () => {
    let captured: any = null;
    const promptSpy = mock(async (req: any) => { captured = req; return { id: "approve-once" }; });
    const sub = makeSubscriber(makeDeps({
      rules: () => ({ allow: ["bash"], deny: [] }),
      prompt: { requestOption: promptSpy, requestText: async () => "" },
    }));
    const p = mkPayload({ name: "bash", args: { command: "ls; rm -rf /" } });
    await sub(p);
    expect(promptSpy).toHaveBeenCalled();
    expect(captured.body).toContain("⚠ bash safety: command separator ;");
    const ids = captured.options.map((o: any) => o.id);
    expect(ids).toEqual(["approve-once", "deny"]);
  });

  it("force-prompts when bash command has shell metacharacters even if pattern-allow rule would approve", async () => {
    let captured: any = null;
    const sub = makeSubscriber(makeDeps({
      rules: () => ({ allow: ["bash(ls *)"], deny: [] }),
      prompt: {
        requestOption: async (req) => { captured = req; return { id: "approve-once" }; },
        requestText: async () => "",
      },
    }));
    await sub(mkPayload({ name: "bash", args: { command: "ls; rm -rf /" } }));
    expect(captured.body).toContain("⚠ bash safety:");
  });

  it("does NOT override deny — denied bash calls stay denied without prompt", async () => {
    const promptSpy = mock(async () => ({ id: "approve-once" as const }));
    const sub = makeSubscriber(makeDeps({
      rules: () => ({ allow: [], deny: ["bash"] }),
      prompt: { requestOption: promptSpy, requestText: async () => "" },
    }));
    const p = mkPayload({ name: "bash", args: { command: "ls; rm" } });
    await sub(p);
    expect(promptSpy).not.toHaveBeenCalled();
    expect(p.args).toBe(CANCEL_TOOL);
  });

  it("does NOT override allow for clean bash commands", async () => {
    const promptSpy = mock(async () => ({ id: "approve-once" as const }));
    const sub = makeSubscriber(makeDeps({
      rules: () => ({ allow: ["bash(ls *)"], deny: [] }),
      prompt: { requestOption: promptSpy, requestText: async () => "" },
    }));
    const p = mkPayload({ name: "bash", args: { command: "ls -la" } });
    await sub(p);
    expect(promptSpy).not.toHaveBeenCalled();
    expect(p.args).toEqual({ command: "ls -la" });
  });

  it("safety override hides Approve Always and Approve Domain Always", async () => {
    let captured: any = null;
    const sub = makeSubscriber(makeDeps({
      rules: () => ({ allow: [], deny: [] }),
      prompt: {
        requestOption: async (req) => { captured = req; return { id: "approve-once" }; },
        requestText: async () => "",
      },
    }));
    await sub(mkPayload({ name: "bash", args: { command: "echo `whoami`" } }));
    const ids = captured.options.map((o: any) => o.id);
    expect(ids).not.toContain("approve-always");
    expect(ids).not.toContain("approve-domain-always");
    expect(ids).not.toContain("approve-pattern-always");
    expect(ids).toEqual(["approve-once", "deny"]);
  });
});
