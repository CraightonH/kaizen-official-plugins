export type ParsedChunk =
  | { kind: "content"; delta: string }
  | { kind: "reasoning"; delta: string }
  | { kind: "tool-fragment"; fragments: { index: number; id?: string; name?: string; argsDelta?: string }[] }
  | { kind: "finish"; reason: "stop" | "length" | "tool_calls" | "content_filter" | string }
  | { kind: "usage"; usage: { promptTokens: number; completionTokens: number } }
  | { kind: "empty" }
  | { kind: "malformed"; raw: string };

export function parseChunk(raw: string): ParsedChunk {
  let obj: any;
  try { obj = JSON.parse(raw); } catch { return { kind: "malformed", raw }; }
  if (!obj || !Array.isArray(obj.choices)) {
    if (obj && obj.usage && obj.choices && obj.choices.length === 0) {
      return { kind: "usage", usage: { promptTokens: Number(obj.usage.prompt_tokens ?? 0), completionTokens: Number(obj.usage.completion_tokens ?? 0) } };
    }
    return { kind: "malformed", raw };
  }
  if (obj.choices.length === 0) {
    if (obj.usage) return { kind: "usage", usage: { promptTokens: Number(obj.usage.prompt_tokens ?? 0), completionTokens: Number(obj.usage.completion_tokens ?? 0) } };
    return { kind: "empty" };
  }
  const choice = obj.choices[0];
  const delta = choice.delta ?? {};

  if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
    const fragments = delta.tool_calls.map((tc: any) => ({
      index: Number(tc.index ?? 0),
      id: typeof tc.id === "string" ? tc.id : undefined,
      name: tc.function?.name != null ? String(tc.function.name) : undefined,
      argsDelta: tc.function?.arguments != null ? String(tc.function.arguments) : undefined,
    }));
    return { kind: "tool-fragment", fragments };
  }

  // Reasoning/thinking deltas. Different OpenAI-compatible providers use
  // different field names: DeepSeek-R1 sends `reasoning_content`, others
  // send `reasoning`. Surface both as a single `reasoning` chunk kind.
  const reasoning =
    (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0
      ? delta.reasoning_content
      : undefined) ??
    (typeof delta.reasoning === "string" && delta.reasoning.length > 0
      ? delta.reasoning
      : undefined);
  if (reasoning) {
    return { kind: "reasoning", delta: reasoning };
  }

  if (typeof delta.content === "string" && delta.content.length > 0) {
    return { kind: "content", delta: delta.content };
  }

  if (choice.finish_reason) {
    return { kind: "finish", reason: String(choice.finish_reason) };
  }

  return { kind: "empty" };
}
