// plugins/llm-local-tools/tools/edit.ts
import { readFile, writeFile, stat } from "node:fs/promises";
import type { ToolSchema } from "llm-events/public";
import { resolvePath } from "../util.ts";

export const schema: ToolSchema = {
  name: "edit",
  description:
    "Edit a text file. Two commands:\n" +
    "- `str_replace`: find `old_str` in the file and replace with `new_str`. `old_str` MUST appear exactly once unless `replace_all: true`. Use this to modify, replace by content (e.g. quote the exact lines you want to replace), or delete content (set `new_str` to \"\").\n" +
    "- `insert`: insert `insert_text` after line `insert_line` (0-based; `0` = top of file; the file's line count = EOF/append). Use this to add content without modifying existing lines.",
  parameters: {
    type: "object",
    properties: {
      command:     { type: "string", enum: ["str_replace", "insert"], description: "Which edit operation to perform." },
      path:        { type: "string", description: "File path. Required for all commands." },

      // str_replace mode
      old_str:     { type: "string", description: "str_replace: text to find. Must match exactly, including whitespace." },
      new_str:     { type: "string", description: "str_replace: replacement text. Must differ from old_str. Use \"\" to delete." },
      replace_all: { type: "boolean", default: false, description: "str_replace: when true, replace every occurrence of old_str." },

      // insert mode
      insert_line: { type: "integer", minimum: 0, description: "insert: 0-based line number to insert AFTER. 0 prepends to the file; the file's line count appends to EOF." },
      insert_text: { type: "string", description: "insert: text to insert verbatim. Trailing newlines are preserved as written." },
    },
    required: ["command", "path"],
  },
  tags: ["local", "fs"],
};

interface StrReplaceArgs {
  command: "str_replace";
  path: string;
  old_str: string;
  new_str: string;
  replace_all?: boolean;
}

interface InsertArgs {
  command: "insert";
  path: string;
  insert_line: number;
  insert_text: string;
}

type EditArgs = StrReplaceArgs | InsertArgs;

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0; let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) { count++; idx += needle.length; }
  return count;
}

async function readFileOrThrow(abs: string): Promise<string> {
  try {
    await stat(abs);
  } catch (err: any) {
    if (err?.code === "ENOENT") throw new Error(`ENOENT: no such file: ${abs}`);
    throw err;
  }
  return readFile(abs, "utf8");
}

/**
 * Count file lines using the convention "trailing newline does not add a line".
 * "" → 0; "a" → 1; "a\n" → 1; "a\nb" → 2; "a\nb\n" → 2.
 */
function countLines(content: string): number {
  if (content === "") return 0;
  const parts = content.split("\n");
  return content.endsWith("\n") ? parts.length - 1 : parts.length;
}

async function handleStrReplace(args: StrReplaceArgs): Promise<string> {
  if (typeof args.old_str !== "string") throw new Error("old_str must be a string");
  if (typeof args.new_str !== "string") throw new Error("new_str must be a string");
  if (args.old_str === "") {
    throw new Error('old_str must be non-empty; use command="insert" to add content, or `write` to overwrite the file');
  }
  if (args.old_str === args.new_str) throw new Error("no-op edit: old_str equals new_str");

  const abs = resolvePath(args.path);
  const original = await readFileOrThrow(abs);
  const count = countOccurrences(original, args.old_str);
  if (count === 0) throw new Error(`old_str not found in ${abs}`);
  const replaceAll = args.replace_all === true;
  if (!replaceAll && count > 1) {
    throw new Error(`old_str matched ${count} times in ${abs}; supply more context or set replace_all`);
  }
  const updated = replaceAll
    ? original.split(args.old_str).join(args.new_str)
    : original.replace(args.old_str, args.new_str);
  const replaced = replaceAll ? count : 1;
  await writeFile(abs, updated, "utf8");
  return `edited ${abs}: replaced ${replaced} occurrence(s)`;
}

async function handleInsert(args: InsertArgs): Promise<string> {
  if (typeof args.insert_line !== "number" || !Number.isInteger(args.insert_line) || args.insert_line < 0) {
    throw new Error("insert_line must be a non-negative integer");
  }
  if (typeof args.insert_text !== "string") throw new Error("insert_text must be a string");
  if (args.insert_text === "") throw new Error("insert_text must be non-empty");

  const abs = resolvePath(args.path);
  const original = await readFileOrThrow(abs);
  const total = countLines(original);
  if (args.insert_line > total) {
    throw new Error(`insert_line ${args.insert_line} exceeds file length ${total} lines`);
  }

  // Convention: insert AFTER line `insert_line`. 0 means before the first line (prepend).
  // We split the file into "before" and "after" the cut point preserving any trailing newline
  // exactly as-is, then concatenate with insert_text verbatim.
  let updated: string;
  if (args.insert_line === 0) {
    updated = args.insert_text + original;
  } else if (args.insert_line === total) {
    // Append at EOF. If the file lacks a trailing newline, the inserted text is concatenated
    // directly (no auto-newline) — matches the spec's "verbatim" requirement.
    updated = original + args.insert_text;
  } else {
    // Insert AFTER line N (1 <= N < total). Find the Nth `\n` and split there.
    let idx = -1;
    let seen = 0;
    while (seen < args.insert_line) {
      idx = original.indexOf("\n", idx + 1);
      if (idx === -1) break;
      seen++;
    }
    // `idx` points at the Nth newline; insert immediately after it.
    const cut = idx + 1;
    updated = original.slice(0, cut) + args.insert_text + original.slice(cut);
  }
  await writeFile(abs, updated, "utf8");
  return `edited ${abs}: inserted ${args.insert_text.split("\n").length - (args.insert_text.endsWith("\n") ? 1 : 0) || 1} line(s) at line ${args.insert_line}`;
}

export async function handler(args: EditArgs, _ctx: unknown): Promise<string> {
  if (typeof (args as any)?.path !== "string") throw new Error("path must be a string");
  const cmd = (args as any)?.command;
  if (cmd === "str_replace") return handleStrReplace(args as StrReplaceArgs);
  if (cmd === "insert") return handleInsert(args as InsertArgs);
  throw new Error(`unknown command: ${JSON.stringify(cmd)}; expected "str_replace" or "insert"`);
}
