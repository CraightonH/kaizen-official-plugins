export type ParsedEvent =
  | { kind: "init"; model: string; sessionId: string }
  | { kind: "text-delta"; text: string }
  | { kind: "result"; sessionId: string; durationMs: number; tokensIn: number; tokensOut: number; cacheReadTokens?: number; cacheCreationTokens?: number }
  | { kind: "retry"; attempt: number; maxRetries: number; retryDelayMs: number; error: string }
  | { kind: "unknown" }
  | { kind: "malformed"; raw: string };

export function parseStreamJsonLine(line: string): ParsedEvent | null {
  if (!line.trim()) return null;
  let obj: any;
  try { obj = JSON.parse(line); } catch { return { kind: "malformed", raw: line }; }
  if (obj?.type === "system" && obj.subtype === "init") {
    return { kind: "init", model: String(obj.model ?? ""), sessionId: String(obj.session_id ?? "") };
  }
  if (obj?.type === "stream_event" && obj.event?.delta?.type === "text_delta") {
    return { kind: "text-delta", text: String(obj.event.delta.text ?? "") };
  }
  if (obj?.type === "result") {
    const u = obj.usage ?? {};
    return {
      kind: "result",
      sessionId: String(obj.session_id ?? ""),
      durationMs: Number(obj.duration_ms ?? 0),
      tokensIn: Number(u.input_tokens ?? 0),
      tokensOut: Number(u.output_tokens ?? 0),
      cacheReadTokens: u.cache_read_input_tokens != null ? Number(u.cache_read_input_tokens) : undefined,
      cacheCreationTokens: u.cache_creation_input_tokens != null ? Number(u.cache_creation_input_tokens) : undefined,
    };
  }
  if (obj?.type === "system" && obj.subtype === "api_retry") {
    return {
      kind: "retry",
      attempt: Number(obj.attempt ?? 0),
      maxRetries: Number(obj.max_retries ?? 0),
      retryDelayMs: Number(obj.retry_delay_ms ?? 0),
      error: String(obj.error ?? "unknown"),
    };
  }
  return { kind: "unknown" };
}
