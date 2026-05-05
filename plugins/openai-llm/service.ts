import type { LLMCompleteService, LLMRequest, LLMStreamEvent, ModelInfo } from "llm-events/public";
import { buildHeaders, buildChatBody } from "./http.ts";
import { readSseFrames } from "./sse.ts";
import { runStream } from "./stream.ts";
import { classifyError, computeBackoff, parseRetryAfter, sleep, type AttemptOutcome } from "./retry.ts";
import type { OpenAILLMConfig } from "./config.ts";

export interface ServiceDeps {
  fetch: typeof fetch;
  version: string;
}

interface CtxLike { log: (msg: string) => void; }

export function makeService(cfg: OpenAILLMConfig, ctx: CtxLike, deps?: Partial<ServiceDeps>): LLMCompleteService {
  const fetchImpl = deps?.fetch ?? fetch;
  const version = deps?.version ?? "0.0.0";

  return {
    async *complete(req: LLMRequest, opts: { signal: AbortSignal }): AsyncIterable<LLMStreamEvent> {
      let body: string;
      try { body = JSON.stringify(buildChatBody(req, cfg)); }
      catch (e) { yield { type: "error", message: (e as Error).message }; return; }

      const headers = buildHeaders(cfg, version);
      const url = `${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`;

      for (let attempt = 1; attempt <= cfg.retry.maxAttempts; attempt++) {
        if (opts.signal.aborted) { yield { type: "error", message: "aborted" }; return; }

        const result = yield* runAttempt({ url, headers, body, fetchImpl, signal: opts.signal, log: ctx.log });
        if (result.kind === "ok") return;

        const cls = classifyError(result as AttemptOutcome);
        if (!cls.retryable || result.tokenYielded) {
          yield toEvent(result);
          return;
        }
        if (attempt >= cfg.retry.maxAttempts) {
          yield toEvent(result);
          return;
        }
        let delay = computeBackoff(attempt, cfg.retry);
        if (cls.retryAfterMs !== undefined) delay = Math.min(cls.retryAfterMs, cfg.retry.maxDelayMs);
        try { await sleep(delay, opts.signal); }
        catch { yield { type: "error", message: "aborted" }; return; }
      }
    },

    async listModels(): Promise<ModelInfo[]> {
      const headers = buildHeaders(cfg, version);
      headers["Accept"] = "application/json";
      const url = `${cfg.baseUrl.replace(/\/$/, "")}/models`;
      let lastErr: AttemptOutcome | null = null;
      for (let attempt = 1; attempt <= cfg.retry.maxAttempts; attempt++) {
        try {
          const res = await fetchImpl(url, { method: "GET", headers });
          if (res.status === 404) { ctx.log(`openai-llm: GET /models returned 404; treating as empty list`); return []; }
          if (!res.ok) {
            lastErr = { kind: "http", status: res.status, body: await res.text().catch(() => "") };
            const cls = classifyError(lastErr);
            if (!cls.retryable || attempt >= cfg.retry.maxAttempts) throw new Error(`HTTP ${res.status}`);
            await sleep(computeBackoff(attempt, cfg.retry), new AbortController().signal);
            continue;
          }
          const obj = await res.json() as any;
          const data: any[] = obj?.data ?? [];

          // LM Studio strips context-length fields from /v1/models but exposes
          // them on its native /api/v0/models endpoint. Probe that as a
          // best-effort enrichment and merge by id; failures are silent
          // because most providers don't have it.
          const enrichments = await tryFetchLMStudioModels(cfg, headers, fetchImpl);

          return data.map((d) => {
            const ext = enrichments.get(String(d.id)) ?? {};
            const loaded = (d.loaded_context_length ?? ext.loaded_context_length) != null
              ? Number(d.loaded_context_length ?? ext.loaded_context_length)
              : undefined;
            const max = (d.max_context_length ?? ext.max_context_length) != null
              ? Number(d.max_context_length ?? ext.max_context_length)
              : undefined;
            const generic = d.context_length != null ? Number(d.context_length) : undefined;
            return {
              id: String(d.id),
              contextLength: generic ?? loaded ?? max,
              loadedContextLength: loaded,
              maxContextLength: max,
              description: d.owned_by != null ? String(d.owned_by) : undefined,
            };
          });
        } catch (e) {
          lastErr = { kind: "network", cause: e };
          if (attempt >= cfg.retry.maxAttempts) throw e;
          await sleep(computeBackoff(attempt, cfg.retry), new AbortController().signal);
        }
      }
      throw new Error("unreachable");
    },
  };
}

/**
 * Best-effort GET against LM Studio's native REST API to recover the runtime
 * context-window annotations (`loaded_context_length`, `max_context_length`)
 * that LM Studio omits from /v1/models. Resolves to an empty map for any
 * non-LM-Studio backend; never throws.
 */
async function tryFetchLMStudioModels(
  cfg: OpenAILLMConfig,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<Map<string, { loaded_context_length?: number; max_context_length?: number }>> {
  const out = new Map<string, { loaded_context_length?: number; max_context_length?: number }>();
  // Derive the LM Studio REST base by stripping the trailing /v(0..N) path.
  const stripped = cfg.baseUrl.replace(/\/$/, "").replace(/\/v\d+$/, "");
  const url = `${stripped}/api/v0/models`;
  try {
    const res = await fetchImpl(url, { method: "GET", headers });
    if (!res.ok) return out;
    const obj = await res.json() as any;
    const data: any[] = obj?.data ?? [];
    for (const d of data) {
      if (typeof d?.id !== "string") continue;
      out.set(d.id, {
        loaded_context_length: typeof d.loaded_context_length === "number" ? d.loaded_context_length : undefined,
        max_context_length: typeof d.max_context_length === "number" ? d.max_context_length : undefined,
      });
    }
  } catch {
    /* swallow — non-LM-Studio backends don't expose this endpoint */
  }
  return out;
}

type AttemptResult =
  | { kind: "ok" }
  | (AttemptOutcome & { tokenYielded: boolean });

async function* runAttempt(p: {
  url: string; headers: Record<string, string>; body: string; fetchImpl: typeof fetch; signal: AbortSignal; log: (s: string) => void;
}): AsyncGenerator<LLMStreamEvent, AttemptResult, void> {
  let res: Response;
  try {
    res = await p.fetchImpl(p.url, { method: "POST", headers: p.headers, body: p.body, signal: p.signal });
  } catch (e: any) {
    if (p.signal.aborted) return { kind: "aborted", tokenYielded: false };
    return { kind: "network", cause: e, tokenYielded: false };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const retryAfter = res.status === 429 || res.status === 503
      ? parseRetryAfter(res.headers.get("retry-after"))
      : undefined;
    return { kind: "http", status: res.status, body: text.slice(0, 512), retryAfterMs: retryAfter, tokenYielded: false } as any;
  }
  if (!res.body) return { kind: "network", cause: new Error("no body"), tokenYielded: false };

  let tokenYielded = false;
  try {
    const frames = readSseFrames(res.body, p.signal);
    for await (const event of runStream(frames, p.log)) {
      if (event.type === "token" || event.type === "tool-call") tokenYielded = true;
      yield event;
      if (event.type === "done") return { kind: "ok" };
      if (event.type === "error") {
        if (event.message === "aborted") return { kind: "aborted", tokenYielded };
        if (event.message.startsWith("malformed")) return { kind: "malformed", tokenYielded };
        return { kind: "malformed", cause: (event as any).cause, tokenYielded };
      }
    }
    if (p.signal.aborted) return { kind: "aborted", tokenYielded };
    return { kind: "network", cause: new Error("stream ended without done"), tokenYielded };
  } catch (e: any) {
    if (p.signal.aborted) return { kind: "aborted", tokenYielded };
    return { kind: "network", cause: e, tokenYielded };
  }
}

function toEvent(o: AttemptResult): LLMStreamEvent {
  if (o.kind === "ok") return { type: "done", response: { content: "", finishReason: "stop" } };
  if (o.kind === "aborted") return { type: "error", message: "aborted" };
  if (o.kind === "http") return { type: "error", message: `HTTP ${o.status}: ${o.body ?? ""}`, cause: { status: o.status, body: o.body } };
  if (o.kind === "network") return { type: "error", message: `network error: ${(o.cause as Error)?.message ?? "unknown"}`, cause: o.cause };
  if (o.kind === "connect-timeout") return { type: "error", message: "connect timeout" };
  if (o.kind === "request-timeout") return { type: "error", message: "request timeout" };
  if (o.kind === "malformed") return { type: "error", message: "malformed SSE data", cause: (o as any).cause };
  if (o.kind === "tool-args-invalid") return { type: "error", message: "tool_calls arguments not valid JSON", cause: { raw: o.raw } };
  return { type: "error", message: "unknown error" };
}
