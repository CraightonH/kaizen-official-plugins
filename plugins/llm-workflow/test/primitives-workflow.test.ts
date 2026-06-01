import { describe, it, expect } from "bun:test";
import { makeWorkflowCallback } from "../primitives/workflow.ts";
import { WorkflowNestingError } from "../errors.ts";

describe("workflow() host-side", () => {
  it("delegates to runChildWorkflow when depth = 0", async () => {
    let called: { nameOrRef: any; args: any } | null = null;
    const cb = makeWorkflowCallback({
      depth: 0,
      runChildWorkflow: async (nameOrRef, args) => { called = { nameOrRef, args }; return "child-result"; },
    });
    const r = await cb({ nameOrRef: "foo", args: { x: 1 } });
    expect(r).toBe("child-result");
    expect(called).toEqual({ nameOrRef: "foo", args: { x: 1 } });
  });

  it("throws WorkflowNestingError at depth = 1", async () => {
    const cb = makeWorkflowCallback({
      depth: 1,
      runChildWorkflow: async () => "should not run",
    });
    await expect(cb({ nameOrRef: "foo", args: undefined }))
      .rejects.toBeInstanceOf(WorkflowNestingError);
  });
});
