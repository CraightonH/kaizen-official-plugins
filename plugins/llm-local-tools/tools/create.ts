// plugins/llm-local-tools/tools/create.ts
import { writeFile } from "node:fs/promises";
import type { ToolSchema } from "llm-events/public";
import { resolvePath, ensureParentExists } from "../util.ts";

export const schema: ToolSchema = {
  name: "create",
  description: "Create a new file. Fails if the file already exists; use `write` to overwrite.",
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

interface CreateArgs { path: string; content: string; }

export async function handler(args: CreateArgs, _ctx: unknown): Promise<string> {
  const abs = resolvePath(args.path);
  await ensureParentExists(abs);
  try {
    await writeFile(abs, args.content, { encoding: "utf8", flag: "wx" });
  } catch (err: any) {
    if (err?.code === "EEXIST") throw new Error(`create target already exists (use write to overwrite): ${abs}`);
    throw err;
  }
  const bytes = Buffer.byteLength(args.content, "utf8");
  return `wrote ${bytes} bytes to ${abs}`;
}
