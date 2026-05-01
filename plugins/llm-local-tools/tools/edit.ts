// plugins/llm-local-tools/tools/edit.ts
import { readFile, writeFile, stat } from "node:fs/promises";
import type { ToolSchema } from "llm-events/public";
import { resolvePath } from "../util.ts";

export const schema: ToolSchema = {
  name: "edit",
  description: "Replace exact text in a file. `old_string` MUST appear exactly once unless `replace_all` is true. Preserve indentation and surrounding context exactly when picking `old_string`.",
  parameters: {
    type: "object",
    properties: {
      path:        { type: "string" },
      old_string:  { type: "string", description: "Text to find. Must match exactly, including whitespace." },
      new_string:  { type: "string", description: "Replacement text. Must differ from old_string." },
      replace_all: { type: "boolean", default: false },
    },
    required: ["path", "old_string", "new_string"],
  },
  tags: ["local", "fs"],
};

interface EditArgs { path: string; old_string: string; new_string: string; replace_all?: boolean; }

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0; let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) { count++; idx += needle.length; }
  return count;
}

export async function handler(args: EditArgs, _ctx: unknown): Promise<string> {
  if (args.old_string === args.new_string) throw new Error("no-op edit: old_string equals new_string");
  const abs = resolvePath(args.path);
  try {
    await stat(abs);
  } catch (err: any) {
    if (err?.code === "ENOENT") throw new Error(`ENOENT: no such file: ${abs}`);
    throw err;
  }
  const original = await readFile(abs, "utf8");
  const count = countOccurrences(original, args.old_string);
  if (count === 0) throw new Error(`old_string not found in ${abs}`);
  const replaceAll = args.replace_all === true;
  if (!replaceAll && count > 1) throw new Error(`old_string matched ${count} times in ${abs}; supply more context or set replace_all`);
  const updated = replaceAll
    ? original.split(args.old_string).join(args.new_string)
    : original.replace(args.old_string, args.new_string);
  const replaced = replaceAll ? count : 1;
  await writeFile(abs, updated, "utf8");
  return `edited ${abs}: replaced ${replaced} occurrence(s)`;
}
