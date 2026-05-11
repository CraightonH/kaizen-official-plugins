// plugins/llm-local-tools/tools/edit.ts
import { readFile, writeFile, stat } from "node:fs/promises";
import type { ToolSchema } from "llm-events/public";
import { resolvePath } from "../util.ts";

export const schema: ToolSchema = {
  name: "edit",
  description:
    "Edit a text file. Two commands — pick by intent:\n" +
    "- ADDING new content (prepend, append, insert between lines)? Use `insert`. Don't use `str_replace` to fake a prepend/append by stuffing the original line into `old_str` — `insert` is the right primitive.\n" +
    "- MODIFYING or DELETING existing content? Use `str_replace`.\n" +
    "\n" +
    "Command details:\n" +
    "- `str_replace`: find `old_str` (required, non-empty, whitespace-sensitive) in the file and replace with `new_str` (required; set to \"\" to delete the matched text). `old_str` MUST appear exactly once unless `replace_all: true`. To replace specific known lines, quote them exactly in `old_str`.\n" +
    "- `insert`: insert `insert_text` (required) AT line `insert_line` (required, 1-based; the inserted text becomes the new line `insert_line`, existing lines shift down). For a file with N lines, `insert_line: 1` prepends, `insert_line: N+1` appends. Line numbers match the 1-based numbering shown by `read`.",
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
      insert_line: { type: "integer", minimum: 1, description: "insert: 1-based line number where the inserted text will live. Valid range for an N-line file is 1..N+1. `1` prepends; `N+1` appends to EOF." },
      insert_text: { type: "string", description: "insert: text to insert verbatim. Trailing newlines are preserved as written." },
    },
    required: ["command", "path"],
    oneOf: [
      {
        properties: { command: { const: "str_replace" } },
        required: ["command", "path", "old_str", "new_str"],
      },
      {
        properties: { command: { const: "insert" } },
        required: ["command", "path", "insert_line", "insert_text"],
      },
    ],
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
  if (args.old_str === undefined) {
    throw new Error('old_str is required when command="str_replace"; supply the exact text to find (must appear in the file, whitespace-sensitive). To add content without modifying existing lines, use command="insert" instead.');
  }
  if (typeof args.old_str !== "string") throw new Error("old_str must be a string");
  if (args.new_str === undefined) {
    throw new Error('new_str is required when command="str_replace"; supply the replacement text (use "" to delete the matched text)');
  }
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
  if (args.insert_line === undefined) {
    throw new Error('insert_line is required when command="insert"; supply a 1-based line number (1..N+1 where N is the file\'s line count; 1 prepends, N+1 appends)');
  }
  if (typeof args.insert_text !== "string") throw new Error("insert_text must be a string");
  if (args.insert_text === "") throw new Error("insert_text must be non-empty");

  const abs = resolvePath(args.path);
  const original = await readFileOrThrow(abs);
  const total = countLines(original);
  const maxLine = total + 1;

  // 1-based AT semantics. `insert_line: N` means "the inserted text becomes the new line N".
  // Valid range is 1..total+1; 1 prepends, total+1 appends.
  if (typeof args.insert_line !== "number" || !Number.isInteger(args.insert_line) || args.insert_line < 1) {
    throw new Error(`insert_line must be an integer in 1..${maxLine} for a ${total}-line file (got ${JSON.stringify(args.insert_line)}); 1 prepends, ${maxLine} appends`);
  }
  if (args.insert_line > maxLine) {
    throw new Error(`insert_line ${args.insert_line} out of range for ${total}-line file (valid: 1..${maxLine}); 1 prepends, ${maxLine} appends to EOF`);
  }

  // Split the file into "before" and "after" the cut point, preserving any trailing newline
  // exactly as-is, then concatenate with insert_text verbatim. Internally we walk `insert_line - 1`
  // newlines forward from the start (0-based "AFTER" index).
  const afterIndex = args.insert_line - 1; // newlines to skip past
  let updated: string;
  if (afterIndex === 0) {
    updated = args.insert_text + original;
  } else if (afterIndex === total) {
    // Append at EOF. If the file lacks a trailing newline, the inserted text is concatenated
    // directly (no auto-newline) — matches the "verbatim" requirement.
    updated = original + args.insert_text;
  } else {
    let idx = -1;
    let seen = 0;
    while (seen < afterIndex) {
      idx = original.indexOf("\n", idx + 1);
      if (idx === -1) break;
      seen++;
    }
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
