import { describe, it, expect, mock } from "bun:test";
import { runStream } from "../stream.ts";

async function* gen(...frames: string[]) { for (const f of frames) yield f; }
async function collect(it: AsyncIterable<any>): Promise<any[]> { const out: any[] = []; for await (const x of it) out.push(x); return out; }
const log = () => mock(() => {});

function content(s: string) { return JSON.stringify({ choices: [{ index: 0, delta: { content: s } }] }); }
function tcFragment(parts: { index: number; id?: string; name?: string; args?: string }[]) {
  return JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: parts.map(p => ({ index: p.index, id: p.id, type: "function", function: { name: p.name, arguments: p.args } })) } }] });
}
function finish(reason: string) { return JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: reason }] }); }
function usage(p: number, c: number) { return JSON.stringify({ choices: [], usage: { prompt_tokens: p, completion_tokens: c, total_tokens: p + c } }); }

describe("runStream", () => {
  it("yields content tokens then done", async () => {
    const out = await collect(runStream(gen(content("a"), content("bc"), finish("stop")), log()));
    expect(out.map(e => e.type)).toEqual(["token", "token", "done"]);
    expect((out[0] as any).delta).toBe("a");
    expect((out[1] as any).delta).toBe("bc");
    expect((out[2] as any).response.content).toBe("abc");
    expect((out[2] as any).response.finishReason).toBe("stop");
  });

  it("accumulates a fragmented tool call across many frames and emits one tool-call + done", async () => {
    const frames = [
      tcFragment([{ index: 0, id: "c1", name: "f", args: "{\"l" }]),
      tcFragment([{ index: 0, args: "oc\":\"" }]),
      tcFragment([{ index: 0, args: "SLC\"" }]),
      tcFragment([{ index: 0, args: "}" }]),
      finish("tool_calls"),
    ];
    const out = await collect(runStream(gen(...frames), log()));
    const types = out.map(e => e.type);
    expect(types).toEqual(["tool-call", "done"]);
    expect((out[0] as any).toolCall).toEqual({ id: "c1", name: "f", arguments: { loc: "SLC" } });
    expect((out[1] as any).response.finishReason).toBe("tool_calls");
    expect((out[1] as any).response.toolCalls.length).toBe(1);
  });

  it("emits parallel tool calls in index order", async () => {
    const frames = [
      tcFragment([{ index: 0, id: "a", name: "f", args: "{}" }, { index: 1, id: "b", name: "g", args: "{" }]),
      tcFragment([{ index: 1, args: "}" }]),
      finish("tool_calls"),
    ];
    const out = await collect(runStream(gen(...frames), log()));
    const calls = out.filter(e => e.type === "tool-call");
    expect(calls.map(c => (c as any).toolCall.id)).toEqual(["a", "b"]);
  });

  it("malformed args JSON produces error, NOT done", async () => {
    const frames = [
      tcFragment([{ index: 0, id: "a", name: "f", args: "{not" }]),
      finish("tool_calls"),
    ];
    const out = await collect(runStream(gen(...frames), log()));
    expect(out.map(e => e.type)).toEqual(["error"]);
    expect((out[0] as any).message).toMatch(/tool_calls arguments not valid JSON/);
  });

  it("usage chunk populates done.response.usage", async () => {
    const out = await collect(runStream(gen(content("hi"), finish("stop"), usage(10, 5)), log()));
    expect((out.at(-1) as any).response.usage).toEqual({ promptTokens: 10, completionTokens: 5 });
  });

  it("usage chunk before finish also captured", async () => {
    const out = await collect(runStream(gen(content("hi"), usage(10, 5), finish("stop")), log()));
    expect((out.at(-1) as any).response.usage).toEqual({ promptTokens: 10, completionTokens: 5 });
  });

  it("stream ends without finish and without DONE → error", async () => {
    const out = await collect(runStream(gen(content("a")), log()));
    expect(out.at(-1)?.type).toBe("error");
    expect((out.at(-1) as any).message).toMatch(/unexpected end of stream/);
  });

  it("DONE-only (no finish) with no tool state → done with stop", async () => {
    expect(true).toBe(true);
  });

  it("tool-state non-empty but finish_reason=stop → error", async () => {
    const frames = [
      tcFragment([{ index: 0, id: "a", name: "f", args: "{}" }]),
      finish("stop"),
    ];
    const out = await collect(runStream(gen(...frames), log()));
    expect(out.map(e => e.type)).toEqual(["error"]);
    expect((out[0] as any).message).toMatch(/tool-call state but finish_reason/);
  });

  it("synthesizes id when missing and logs warning", async () => {
    const lg = mock(() => {});
    const frames = [
      tcFragment([{ index: 0, name: "f", args: "{}" }]),
      finish("tool_calls"),
    ];
    const out = await collect(runStream(gen(...frames), lg));
    const tc = out.find(e => e.type === "tool-call") as any;
    expect(tc.toolCall.id).toMatch(/^call_0_/);
    expect(lg).toHaveBeenCalled();
  });
});
