import { describe, it, expect } from "bun:test";
import { wireStatusItem, buildWorkflowsBlock } from "../status.ts";
import type { WorkflowManifest } from "llm-contracts/public";

describe("status item", () => {
  it("updates status on workflow:start, clears on workflow:end", () => {
    const subs = new Map<string, Array<(p: any) => void>>();
    const on = (n: string, fn: any) => { (subs.get(n) ?? subs.set(n, []).get(n))!.push(fn); };
    const updates: any[] = [];
    const emit = (n: string, p: any) => updates.push({ n, p });
    wireStatusItem({ on, emit });

    (subs.get("workflow:start") ?? []).forEach((fn) => fn({ runId: "r1", name: "demo", phases: [{ title: "Verify" }] }));
    expect(updates.at(-1)).toEqual({ n: "status:item-update", p: { key: "workflow.active", value: expect.stringContaining("demo") } });

    (subs.get("workflow:phase") ?? []).forEach((fn) => fn({ runId: "r1", phase: "Verify" }));
    expect((updates.at(-1)!.p as any).value).toContain("Verify");

    (subs.get("workflow:end") ?? []).forEach((fn) => fn({ runId: "r1", ok: true }));
    expect(updates.at(-1)).toEqual({ n: "status:item-clear", p: { key: "workflow.active" } });
  });

  it("buildWorkflowsBlock returns '' on empty list", () => {
    expect(buildWorkflowsBlock([])).toBe("");
  });

  it("buildWorkflowsBlock renders bullets", () => {
    const ms: WorkflowManifest[] = [
      { meta: { name: "foo", description: "Desc foo" }, source: "", scope: "user" },
      { meta: { name: "runtime:hidden", description: "hidden" }, source: "", scope: "runtime" },
    ];
    const out = buildWorkflowsBlock(ms);
    expect(out).toContain("foo");
    expect(out).not.toContain("runtime:hidden");
  });
});
