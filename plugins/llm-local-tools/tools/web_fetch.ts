// plugins/llm-local-tools/tools/web_fetch.ts
import { writeFile } from "node:fs/promises";
import type { ToolSchema } from "llm-events/public";
import {
  ensureParentExists,
  isBinaryContentType,
  resolvePath,
  truncateBytes,
  WEB_FETCH_CAP_BYTES,
  WEB_FETCH_DEFAULT_TIMEOUT_MS,
  WEB_FETCH_DOWNLOAD_CAP_BYTES,
} from "../util.ts";

export const schema: ToolSchema = {
  name: "web_fetch",
  description: "Fetch a URL over HTTP(S). Default behavior: return body as text (512 KB cap). For binary content (image/*, audio/*, video/*, application/pdf, application/octet-stream, archives, etc.) the body is NOT returned to context — you must pass `save_to` to download it to disk. Passing `save_to` for text also writes the body to disk and omits it from the result. No JS rendering.",
  parameters: {
    type: "object",
    properties: {
      url:        { type: "string", description: "Absolute http(s) URL." },
      method:     { type: "string", enum: ["GET", "HEAD"], default: "GET" },
      headers:    { type: "object", description: "Additional request headers.", additionalProperties: { type: "string" } },
      timeout_ms: { type: "integer", minimum: 1000, maximum: 120000, description: "Milliseconds. Default 30000. Hard max 120000 (2 min)." },
      max_bytes:  { type: "integer", minimum: 1024, description: `In-context body cap. Default ${WEB_FETCH_CAP_BYTES}. Ignored when save_to is set.` },
      save_to:    { type: "string", description: "Absolute path (or relative to cwd) to write the response body to. Required for binary content. When set, body is NOT returned to context." },
      cwd:        { type: "string", description: "Working directory for resolving save_to. Defaults to process cwd." },
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
  save_to?: string;
  cwd?: string;
}

interface WebFetchResult {
  url: string;
  final_url: string;
  status: number;
  content_type: string;
  is_binary: boolean;
  body: string;
  bytes: number;
  truncated: boolean;
  redirected: boolean;
  saved_path: string | null;
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
  const contextCap = Math.max(1024, args.max_bytes ?? WEB_FETCH_CAP_BYTES);

  let savePath: string | null = null;
  if (args.save_to != null) {
    if (typeof args.save_to !== "string" || args.save_to.length === 0) {
      throw new Error("web_fetch: save_to must be a non-empty string");
    }
    savePath = resolvePath(args.save_to, args.cwd);
    await ensureParentExists(savePath);
  }

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
    const isBinary = isBinaryContentType(contentType);

    // HEAD: no body work to do.
    if (method === "HEAD") {
      return {
        url: args.url,
        final_url: resp.url || parsed.toString(),
        status: resp.status,
        content_type: contentType,
        is_binary: isBinary,
        body: "",
        bytes: 0,
        truncated: false,
        redirected: resp.redirected,
        saved_path: null,
        duration_ms: Date.now() - start,
      };
    }

    // Binary without save_to: refuse early — don't pollute context with garbage.
    if (isBinary && savePath == null) {
      throw new Error(
        `web_fetch: response is binary (content-type: ${contentType}); pass save_to=<path> to download to disk. ` +
        `URL: ${parsed.toString()}`
      );
    }

    const ab = await resp.arrayBuffer();
    const buf = Buffer.from(ab);
    const bytes = buf.length;

    // Downloaded path: write to disk, return metadata only.
    if (savePath != null) {
      if (bytes > WEB_FETCH_DOWNLOAD_CAP_BYTES) {
        throw new Error(
          `web_fetch: response too large to save (${bytes} bytes > ${WEB_FETCH_DOWNLOAD_CAP_BYTES}): ${parsed.toString()}`
        );
      }
      await writeFile(savePath, buf);
      return {
        url: args.url,
        final_url: resp.url || parsed.toString(),
        status: resp.status,
        content_type: contentType,
        is_binary: isBinary,
        body: "",
        bytes,
        truncated: false,
        redirected: resp.redirected,
        saved_path: savePath,
        duration_ms: Date.now() - start,
      };
    }

    // Text in-context path.
    const raw = buf.toString("utf8");
    let body = raw;
    let truncated = false;
    if (bytes > contextCap) {
      body = truncateBytes(raw, contextCap, `... [truncated: ${bytes - contextCap} bytes elided]`);
      truncated = true;
    }
    return {
      url: args.url,
      final_url: resp.url || parsed.toString(),
      status: resp.status,
      content_type: contentType,
      is_binary: false,
      body,
      bytes,
      truncated,
      redirected: resp.redirected,
      saved_path: null,
      duration_ms: Date.now() - start,
    };
  } catch (err: any) {
    if (err?.name === "AbortError" || controller.signal.aborted) {
      const reason = controller.signal.reason instanceof Error ? controller.signal.reason.message : "aborted";
      throw new Error(`web_fetch: ${reason} (${parsed.toString()})`);
    }
    if (err?.message?.startsWith?.("web_fetch:")) throw err;
    throw new Error(`web_fetch: ${err?.message ?? String(err)} (${parsed.toString()})`);
  } finally {
    clearTimeout(timer);
    if (ctx?.signal) ctx.signal.removeEventListener?.("abort", onAbort as any);
  }
}
