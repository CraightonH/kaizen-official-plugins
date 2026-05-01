// plugins/llm-local-tools/tools/read.ts
import { stat, open } from "node:fs/promises";
import type { ToolSchema } from "llm-events/public";
import {
  resolvePath,
  sniffBinary,
  formatLineNumbered,
  MAX_READ_BYTES,
  READ_CAP_BYTES,
  READ_CAP_LINES,
} from "../util.ts";

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

export async function handler(args: ReadArgs, _ctx: unknown): Promise<string> {
  const abs = resolvePath(args.path);
  let st;
  try {
    st = await stat(abs);
  } catch (err: any) {
    if (err?.code === "ENOENT") throw new Error(`ENOENT: no such file: ${abs}`);
    throw err;
  }
  if (!st.isFile()) throw new Error(`not a regular file: ${abs}`);
  if (st.size > MAX_READ_BYTES) throw new Error(`file too large to read (${st.size} bytes > ${MAX_READ_BYTES}): ${abs}`);

  const fh = await open(abs, "r");
  try {
    const head = Buffer.alloc(Math.min(8 * 1024, st.size));
    await fh.read(head, 0, head.length, 0);
    if (sniffBinary(head)) throw new Error(`refusing to read binary file (NUL byte detected): ${abs}`);

    const offset = Math.max(1, args.offset ?? 1);
    const limit = Math.max(1, args.limit ?? READ_CAP_LINES);
    const wantLines = Math.min(limit, READ_CAP_LINES);

    const buf = Buffer.alloc(st.size);
    await fh.read(buf, 0, st.size, 0);
    const all = buf.toString("utf8");
    const lines = all.split("\n");
    const totalLines = lines.length;
    const slice = lines.slice(offset - 1, offset - 1 + wantLines);

    let body = formatLineNumbered(slice.join("\n"), offset);
    let truncated = false;
    let truncReason = "";

    if (Buffer.byteLength(body, "utf8") > READ_CAP_BYTES) {
      truncated = true;
      const cut = Buffer.from(body, "utf8").subarray(0, READ_CAP_BYTES).toString("utf8");
      const moreBytes = Buffer.byteLength(body, "utf8") - READ_CAP_BYTES;
      body = cut;
      truncReason = `${moreBytes} more bytes`;
    }
    const linesShown = slice.length;
    const moreLines = Math.max(0, totalLines - (offset - 1) - linesShown);
    if (moreLines > 0 || linesShown >= READ_CAP_LINES) {
      truncated = true;
      truncReason = `file has ${moreLines} more lines${truncReason ? " / " + truncReason : ""}`;
    }
    if (truncated) body += `\n... [truncated: ${truncReason}]`;
    return body;
  } finally {
    await fh.close();
  }
}
