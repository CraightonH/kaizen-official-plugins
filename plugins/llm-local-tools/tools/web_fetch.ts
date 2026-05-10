// plugins/llm-local-tools/tools/web_fetch.ts
import type { ToolSchema } from "llm-events/public";
import { truncateBytes, WEB_FETCH_CAP_BYTES, WEB_FETCH_DEFAULT_TIMEOUT_MS } from "../util.ts";

export const schema: ToolSchema = {
  name: "web_fetch",
  description: "Fetch a URL over HTTP(S). Returns response body as text. Refuses non-http(s) schemes. Default 30s timeout, 512KB body cap. No JS rendering — for static pages, JSON APIs, raw HTML.",
  parameters: {
    type: "object",
    properties: {
      url:        { type: "string", description: "Absolute http(s) URL." },
      method:     { type: "string", enum: ["GET", "HEAD"], default: "GET" },
      headers:    { type: "object", description: "Additional request headers.", additionalProperties: { type: "string" } },
      timeout_ms: { type: "integer", minimum: 1000, maximum: 120000, description: "Milliseconds. Default 30000. Hard max 120000 (2 min)." },
      max_bytes:  { type: "integer", minimum: 1024, description: `Body cap in bytes. Default ${WEB_FETCH_CAP_BYTES}.` },
    },
    required: ["url"],
  },
  tags: ["local", "web"],
};

interface WebFetchArgs {
  url: string;
  method?: "GET" | "HEAD";
  headers?: Record<string, string>;
  timeout_ms?: number;
  max_bytes?: number;
}

interface WebFetchResult {
  url: string;
  final_url: string;
  status: number;
  content_type: string;
  body: string;
  bytes: number;
  truncated: boolean;
  redirected: boolean;
  duration_ms: number;
}

export async function handler(args: WebFetchArgs, ctx: any): Promise<WebFetchResult> {
  let parsed: URL;
  try {
    parsed = new URL(args.url);
  } catch {
    throw new Error(`web_fetch: invalid URL: ${args.url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`web_fetch: refusing non-http(s) scheme: ${parsed.protocol}`);
  }

  const method = args.method ?? "GET";
  const timeout = Math.min(120000, Math.max(1000, args.timeout_ms ?? WEB_FETCH_DEFAULT_TIMEOUT_MS));
  const maxBytes = Math.max(1024, args.max_bytes ?? WEB_FETCH_CAP_BYTES);

  const fetchImpl: typeof fetch = ctx?.fetch ?? globalThis.fetch;
  const start = Date.now();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), timeout);
  const onAbort = () => controller.abort(new Error("cancelled"));
  if (ctx?.signal) {
    if (ctx.signal.aborted) controller.abort();
    else ctx.signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    const resp = await fetchImpl(parsed.toString(), {
      method,
      headers: args.headers,
      redirect: "follow",
      signal: controller.signal,
    });

    const contentType = resp.headers.get("content-type") ?? "";
    let body = "";
    let bytes = 0;
    let truncated = false;

    if (method !== "HEAD") {
      const raw = await resp.text();
      bytes = Buffer.byteLength(raw, "utf8");
      if (bytes > maxBytes) {
        body = truncateBytes(raw, maxBytes, `... [truncated: ${bytes - maxBytes} bytes elided]`);
        truncated = true;
      } else {
        body = raw;
      }
    }

    return {
      url: args.url,
      final_url: resp.url || parsed.toString(),
      status: resp.status,
      content_type: contentType,
      body,
      bytes,
      truncated,
      redirected: resp.redirected,
      duration_ms: Date.now() - start,
    };
  } catch (err: any) {
    if (err?.name === "AbortError" || controller.signal.aborted) {
      const reason = controller.signal.reason instanceof Error ? controller.signal.reason.message : "aborted";
      throw new Error(`web_fetch: ${reason} (${parsed.toString()})`);
    }
    throw new Error(`web_fetch: ${err?.message ?? String(err)} (${parsed.toString()})`);
  } finally {
    clearTimeout(timer);
    if (ctx?.signal) ctx.signal.removeEventListener?.("abort", onAbort as any);
  }
}
