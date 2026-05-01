// plugins/llm-local-tools/tools/write.ts
import { writeFile, stat } from "node:fs/promises";
import type { ToolSchema } from "llm-events/public";
import { resolvePath, ensureParentExists } from "../util.ts";

export const schema: ToolSchema = {
  name: "write",
  description: "Overwrite an existing file with new contents. Fails if the file does not exist; use `create` for new files.",
  parameters: {
    type: "object",
    properties: {
      path:    { type: "string" },
      content: { type: "string" },
    },
    required: ["path", "content"],
  },
  tags: ["local", "fs"],
};

interface WriteArgs { path: string; content: string; }

export async function handler(args: WriteArgs, _ctx: unknown): Promise<string> {
  const abs = resolvePath(args.path);
  await ensureParentExists(abs);
  let st;
  try {
    st = await stat(abs);
  } catch (err: any) {
    if (err?.code === "ENOENT") throw new Error(`write target does not exist (use create for new files): ${abs}`);
    throw err;
  }
  if (!st.isFile()) throw new Error(`write target is not a regular file: ${abs}`);
  const bytes = Buffer.byteLength(args.content, "utf8");
  await writeFile(abs, args.content, { encoding: "utf8" });
  return `wrote ${bytes} bytes to ${abs}`;
}
