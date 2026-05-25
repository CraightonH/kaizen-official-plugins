// plugins/llm-local-tools/tools/read.ts
import { stat, open } from "node:fs/promises";
import type { ToolSchema } from "llm-contracts/public";
import { resolvePath, sniffBinary, formatLineNumbered } from "../util.ts";
import { DEFAULT_CONFIG } from "../config.ts";
import type { LlmLocalToolsConfig } from "../public.d.ts";

export const schema: ToolSchema = {
  name: "read",
  description: "Read a file from the local filesystem. Returns contents prefixed with line numbers (1-indexed). Use `offset` and `limit` to page through large files.",
  parameters: {
    type: "object",
    properties: {
      path:   { type: "string", description: "Absolute path, or relative to the process cwd." },
      offset: { type: "integer", minimum: 1, description: "1-indexed line to start at. Defaults to 1." },
      limit:  { type: "integer", minimum: 1, description: "Max lines to return. Defaults to 2000." },
    },
    required: ["path"],
  },
  tags: ["local", "fs"],
};

interface ReadArgs { path: string; offset?: number; limit?: number; }

export function makeHandler(config: LlmLocalToolsConfig) {
  return async function handler(args: ReadArgs, _ctx: unknown): Promise<string> {
    const abs = resolvePath(args.path);
    let st;
    try {
      st = await stat(abs);
    } catch (err: any) {
      if (err?.code === "ENOENT") throw new Error(`ENOENT: no such file: ${abs}`);
      throw err;
    }
    if (!st.isFile()) throw new Error(`not a regular file: ${abs}`);
    if (st.size > config.readMaxBytes) throw new Error(`file too large to read (${st.size} bytes > ${config.readMaxBytes}): ${abs}`);

    const fh = await open(abs, "r");
    try {
      const head = Buffer.alloc(Math.min(8 * 1024, st.size));
      await fh.read(head, 0, head.length, 0);
      if (sniffBinary(head)) throw new Error(`refusing to read binary file (NUL byte detected): ${abs}`);

      const offset = Math.max(1, args.offset ?? 1);
      const limit = Math.max(1, args.limit ?? config.readCapLines);
      const wantLines = Math.min(limit, config.readCapLines);

      const buf = Buffer.alloc(st.size);
      await fh.read(buf, 0, st.size, 0);
      const all = buf.toString("utf8");
      const lines = all.split("\n");
      const totalLines = lines.length;
      const slice = lines.slice(offset - 1, offset - 1 + wantLines);

      let body = formatLineNumbered(slice.join("\n"), offset);
      let truncated = false;
      let truncReason = "";

      if (Buffer.byteLength(body, "utf8") > config.readCapBytes) {
        truncated = true;
        const cut = Buffer.from(body, "utf8").subarray(0, config.readCapBytes).toString("utf8");
        const moreBytes = Buffer.byteLength(body, "utf8") - config.readCapBytes;
        body = cut;
        truncReason = `${moreBytes} more bytes`;
      }
      const linesShown = slice.length;
      const moreLines = Math.max(0, totalLines - (offset - 1) - linesShown);
      if (moreLines > 0 || linesShown >= config.readCapLines) {
        truncated = true;
        truncReason = `file has ${moreLines} more lines${truncReason ? " / " + truncReason : ""}`;
      }
      if (truncated) body += `\n... [truncated: ${truncReason}]`;
      return body;
    } finally {
      await fh.close();
    }
  };
}

// Default handler closure-bound to DEFAULT_CONFIG so per-tool tests that
// `import { handler } from "../../tools/read.ts"` continue to work.
export const handler = makeHandler(DEFAULT_CONFIG);
