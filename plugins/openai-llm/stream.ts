import type { LLMStreamEvent, ToolCall, LLMResponse } from "llm-events/public";
import { parseChunk } from "./parser.ts";

interface ToolState { id?: string; name: string; argsJson: string; }

export async function* runStream(
  frames: AsyncIterable<string>,
  log: (msg: string) => void,
): AsyncIterable<LLMStreamEvent> {
  const tools = new Map<number, ToolState>();
  let content = "";
  let finishReason: LLMResponse["finishReason"] | null = null;
  let usage: LLMResponse["usage"] | undefined;

  const iter = (frames as AsyncIterable<string>)[Symbol.asyncIterator]();
  outer: for (;;) {
    const next = await iter.next();
    if (next.done) break;
    const raw = next.value;
    const c = parseChunk(raw);
    if (c.kind === "malformed") {
      yield { type: "error", message: "malformed SSE data", cause: { raw: c.raw } };
      return;
    }
    if (c.kind === "empty") continue;
    if (c.kind === "content") {
      content += c.delta;
      yield { type: "token", delta: c.delta };
      continue;
    }
    if (c.kind === "tool-fragment") {
      for (const f of c.fragments) {
        const s = tools.get(f.index) ?? { name: "", argsJson: "" };
        if (f.id && !s.id) s.id = f.id;
        if (f.name) s.name += f.name;
        if (f.argsDelta) s.argsJson += f.argsDelta;
        tools.set(f.index, s);
      }
      continue;
    }
    if (c.kind === "usage") { usage = c.usage; continue; }
    if (c.kind === "finish") {
      finishReason = (mapFinish(c.reason));
      break outer;
    }
  }

  // Drain remaining frames for trailing usage / [DONE].
  for (;;) {
    const next = await iter.next();
    if (next.done) break;
    const c = parseChunk(next.value);
    if (c.kind === "usage") { usage = c.usage; }
  }

  if (finishReason === null) {
    yield { type: "error", message: "unexpected end of stream" };
    return;
  }

  if (finishReason === "tool_calls") {
    const toolCalls: ToolCall[] = [];
    const indices = [...tools.keys()].sort((a, b) => a - b);
    for (const idx of indices) {
      const s = tools.get(idx)!;
      let args: unknown;
      try { args = JSON.parse(s.argsJson); }
      catch (cause) {
        yield { type: "error", message: "tool_calls arguments not valid JSON", cause: { raw: s.argsJson, idx } };
        return;
      }
      let id = s.id;
      if (!id) {
        id = `call_${idx}_${Math.random().toString(36).slice(2, 10)}`;
        log(`openai-llm: synthesized tool_call id ${id} (server omitted it)`);
      }
      const tc: ToolCall = { id, name: s.name, arguments: args };
      toolCalls.push(tc);
      yield { type: "tool-call", toolCall: tc };
    }
    yield { type: "done", response: { content, toolCalls: toolCalls.length ? toolCalls : undefined, finishReason: "tool_calls", usage } };
    return;
  }

  if (tools.size > 0) {
    yield { type: "error", message: `tool-call state but finish_reason=${finishReason}` };
    return;
  }

  yield { type: "done", response: { content, finishReason, usage } };
}

function mapFinish(r: string): LLMResponse["finishReason"] {
  switch (r) {
    case "stop":
    case "length":
    case "tool_calls":
    case "content_filter":
      return r;
    default:
      return "error";
  }
}
