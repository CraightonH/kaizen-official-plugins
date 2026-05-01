import { describe, it, expect } from "bun:test";
import { prepareRequest } from "../prepare-request.ts";
import simple from "./fixtures/tools-simple.json" with { type: "json" };
import type { ToolSchema } from "llm-events/public";

describe("prepareRequest", () => {
  it("does NOT populate tools (native is for that)", async () => {
    const r = await prepareRequest({ availableTools: simple as ToolSchema[] });
    expect(r.tools).toBeUndefined();
  });

  it("emits a systemPromptAppend with preamble + .d.ts + example", async () => {
    const r = await prepareRequest({ availableTools: simple as ToolSchema[] });
    expect(r.systemPromptAppend).toContain("sandboxed TypeScript runtime");
    expect(r.systemPromptAppend).toContain("declare const kaizen");
    expect(r.systemPromptAppend).toMatch(/```typescript/);
    expect(r.systemPromptAppend).toContain("[code execution result]");
  });

  it("empty tools still produces a (degenerate) prompt with no methods", async () => {
    const r = await prepareRequest({ availableTools: [] });
    expect(r.systemPromptAppend).toContain("declare const kaizen");
  });

  it("deterministic across calls", async () => {
    const a = await prepareRequest({ availableTools: simple as ToolSchema[] });
    const b = await prepareRequest({ availableTools: simple as ToolSchema[] });
    expect(a.systemPromptAppend).toBe(b.systemPromptAppend);
  });
});
