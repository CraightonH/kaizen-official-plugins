import { describe, it, expect, mock } from "bun:test";
import { makeHandleResponse } from "../handle-response.ts";
import type { ToolsRegistryService, ToolSchema, LLMResponse } from "llm-events/public";
import { DEFAULT_CONFIG } from "../config.ts";

function mockRegistry(handlers: Record<string, (a: any) => unknown> = {}): ToolsRegistryService {
  return {
    register: () => () => {},
    list: () => [] as ToolSchema[],
    invoke: async (name, args) => {
      const h = handlers[name];
      if (!h) throw new Error(`unknown tool: ${name}`);
      return h(args);
    },
  };
}

const ac = () => new AbortController();
const noopEmit = mock(async () => {});

describe("handleResponse", () => {
  it("no code → returns []", async () => {
    const fakeRun = mock(async () => ({ ok: true, returnValue: undefined, stdout: "" }));
    const handle = makeHandleResponse(DEFAULT_CONFIG, fakeRun as any);
    const resp: LLMResponse = { content: "Just text.", finishReason: "stop" };
    const out = await handle({ response: resp, registry: mockRegistry(), signal: ac().signal, emit: noopEmit });
    expect(out).toEqual([]);
    expect(fakeRun).not.toHaveBeenCalled();
  });

  it("one block → emits codemode events and returns one user message", async () => {
    const events: string[] = [];
    const emit = mock(async (name: string) => { events.push(name); });
    const fakeRun = mock(async () => ({ ok: true, returnValue: 42, stdout: "hello\n" }));
    const handle = makeHandleResponse(DEFAULT_CONFIG, fakeRun as any);
    const resp: LLMResponse = { content: "```typescript\n1+1;\n```", finishReason: "stop" };
    const out = await handle({ response: resp, registry: mockRegistry(), signal: ac().signal, emit: emit as any });
    expect(out.length).toBe(1);
    expect(out[0].role).toBe("user");
    expect(out[0].content).toContain("[code execution result]");
    expect(out[0].content).toContain("returned: 42");
    expect(out[0].content).toContain("hello");
    expect(events).toContain("codemode:code-emitted");
    expect(events).toContain("codemode:before-execute");
    expect(events).toContain("codemode:result");
  });

  it("before-execute subscriber may mutate code", async () => {
    let observedCode = "";
    const emit = mock(async (name: string, payload: any) => {
      if (name === "codemode:before-execute") payload.code = `throw new Error("blocked")`;
    });
    const fakeRun = mock(async (code: string) => {
      observedCode = code;
      return { ok: false, errorName: "Error", errorMessage: "blocked", stdout: "" };
    });
    const handle = makeHandleResponse(DEFAULT_CONFIG, fakeRun as any);
    const resp: LLMResponse = { content: "```typescript\n1+1;\n```", finishReason: "stop" };
    const out = await handle({ response: resp, registry: mockRegistry(), signal: ac().signal, emit: emit as any });
    expect(observedCode).toBe(`throw new Error("blocked")`);
    expect(out[0].content).toContain("exit: error");
    expect(out[0].content).toContain("blocked");
  });

  it("error path emits codemode:error", async () => {
    const events: { name: string; payload: any }[] = [];
    const emit = mock(async (name: string, payload: unknown) => { events.push({ name, payload }); });
    const fakeRun = mock(async () => ({ ok: false, errorName: "TypeError", errorMessage: "boom", stdout: "" }));
    const handle = makeHandleResponse(DEFAULT_CONFIG, fakeRun as any);
    const resp: LLMResponse = { content: "```typescript\nbad();\n```", finishReason: "stop" };
    await handle({ response: resp, registry: mockRegistry(), signal: ac().signal, emit: emit as any });
    expect(events.some((e) => e.name === "codemode:error")).toBe(true);
  });

  it("respects maxBlocksPerResponse and reports ignored count in feedback", async () => {
    const fakeRun = mock(async () => ({ ok: true, returnValue: 1, stdout: "" }));
    const cfg = { ...DEFAULT_CONFIG, maxBlocksPerResponse: 2 };
    const handle = makeHandleResponse(cfg, fakeRun as any);
    const blocks = Array(5).fill(0).map((_,i) => "```typescript\n"+i+";\n```").join("\n");
    const out = await handle({ response: { content: blocks, finishReason: "stop" }, registry: mockRegistry(), signal: ac().signal, emit: noopEmit as any });
    expect(out[0].content).toContain("note: 3 additional code block(s) were ignored because the limit is 2");
  });

  it("AbortError from sandbox propagates as throw (turn cancellation)", async () => {
    const fakeRun = mock(async () => { const e: any = new Error("aborted"); e.name = "AbortError"; throw e; });
    const handle = makeHandleResponse(DEFAULT_CONFIG, fakeRun as any);
    const resp: LLMResponse = { content: "```typescript\n1;\n```", finishReason: "stop" };
    await expect(handle({ response: resp, registry: mockRegistry(), signal: ac().signal, emit: noopEmit as any })).rejects.toThrow();
  });
});
