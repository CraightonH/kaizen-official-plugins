import type { OpenAILLMConfig } from "./config.ts";

export type AttemptOutcome =
  | { kind: "ok" }
  | { kind: "network"; cause?: unknown }
  | { kind: "connect-timeout" }
  | { kind: "request-timeout" }
  | { kind: "http"; status: number; body?: string; retryAfterMs?: number }
  | { kind: "malformed"; cause?: unknown }
  | { kind: "aborted" }
  | { kind: "tool-args-invalid"; raw: string };

export function classifyError(o: AttemptOutcome): { retryable: boolean; retryAfterMs?: number } {
  switch (o.kind) {
    case "network":
    case "connect-timeout":
      return { retryable: true };
    case "http":
      if (o.status === 429) return { retryable: true, retryAfterMs: o.retryAfterMs };
      if (o.status >= 500) return { retryable: true };
      return { retryable: false };
    default:
      return { retryable: false };
  }
}

export function computeBackoff(attempt: number, cfg: OpenAILLMConfig["retry"]): number {
  const base = Math.min(cfg.initialDelayMs * Math.pow(2, attempt - 1), cfg.maxDelayMs);
  return cfg.jitter === "full" ? Math.random() * base : base;
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("aborted"));
    const t = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(new Error("aborted")); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function parseRetryAfter(header: string | null, nowMs = Date.now()): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dt = Date.parse(header);
  if (!Number.isNaN(dt)) return Math.max(0, dt - nowMs);
  return undefined;
}
