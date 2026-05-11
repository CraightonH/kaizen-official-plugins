# Edit Tool Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand the `edit` tool from strict find-and-replace to a CC-shaped two-command interface (`str_replace` + `insert`), matching `str_replace_based_edit_tool` so the LLM uses it naturally.

**Architecture:** One tool, `command` discriminator, two branches. `str_replace` keeps today's behavior (renamed params, better empty-input error). `insert` is new. Renderer in `llm-tui` follows the param renames and learns to preview the `insert` command.

**Tech Stack:** Bun (runtime + bundler + test), TypeScript, React + Ink (TUI). Plugin runtime is Kaizen.

**Spec:** `docs/superpowers/specs/2026-05-10-edit-tool-expansion-design.md`

---

## File Structure

**Modified:**
- `plugins/llm-local-tools/tools/edit.ts` — discriminator + insert + renamed params + empty-input error
- `plugins/llm-local-tools/test/tools/edit.test.ts` — renamed param usage + new tests
- `plugins/llm-tui/tool-renderers/defaults.tsx` — renamed param reads + insert preview
- `plugins/llm-tui/tool-renderers/defaults.test.tsx` — renamed param usage + insert test

**Deployed:**
- `~/.kaizen/marketplaces/official/plugins/llm-local-tools@0.1.0/dist/index.js`
- `~/.kaizen/marketplaces/official/plugins/llm-tui@0.1.0/dist/index.js`

No new files.

---

### Task 1: Rename `old_string`/`new_string` → `old_str`/`new_str` in `edit.ts` and tests (lockstep)

This is a pure rename — no behavior change. Done as a single atomic task because the schema, handler, internal type, error messages, and tests must all change together to compile and pass tests.

**Files:**
- Modify: `plugins/llm-local-tools/tools/edit.ts` (entire schema, handler, interface, error strings)
- Modify: `plugins/llm-local-tools/test/tools/edit.test.ts` (all call sites + the error-message regex)

- [ ] **Step 1: Update existing tests to use new param names**

Replace the contents of `plugins/llm-local-tools/test/tools/edit.test.ts` with:

```typescript
// plugins/llm-local-tools/test/tools/edit.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schema, handler } from "../../tools/edit.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "llt-edit-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const ctx = { signal: new AbortController().signal, callId: "c1", log: () => {} } as any;

describe("edit tool — str_replace", () => {
  it("schema metadata", () => {
    expect(schema.name).toBe("edit");
    expect(schema.tags).toEqual(["local", "fs"]);
  });

  it("replaces a unique match", async () => {
    const p = join(dir, "a.txt"); writeFileSync(p, "alpha BETA gamma");
    const out = await handler({ command: "str_replace", path: p, old_str: "BETA", new_str: "DELTA" }, ctx) as string;
    expect(readFileSync(p, "utf8")).toBe("alpha DELTA gamma");
    expect(out).toMatch(/replaced 1 occurrence/);
  });

  it("rejects zero matches", async () => {
    const p = join(dir, "a.txt"); writeFileSync(p, "alpha");
    await expect(handler({ command: "str_replace", path: p, old_str: "ZZ", new_str: "Y" }, ctx))
      .rejects.toThrow(/not found/i);
  });

  it("rejects multi-match without replace_all", async () => {
    const p = join(dir, "a.txt"); writeFileSync(p, "x x x");
    await expect(handler({ command: "str_replace", path: p, old_str: "x", new_str: "y" }, ctx))
      .rejects.toThrow(/matched 3 times/i);
  });

  it("replace_all replaces all", async () => {
    const p = join(dir, "a.txt"); writeFileSync(p, "x x x");
    const out = await handler({ command: "str_replace", path: p, old_str: "x", new_str: "y", replace_all: true }, ctx) as string;
    expect(readFileSync(p, "utf8")).toBe("y y y");
    expect(out).toMatch(/replaced 3 occurrence/);
  });

  it("rejects identical old/new", async () => {
    const p = join(dir, "a.txt"); writeFileSync(p, "alpha");
    await expect(handler({ command: "str_replace", path: p, old_str: "alpha", new_str: "alpha" }, ctx))
      .rejects.toThrow(/no-op/i);
  });

  it("whitespace-sensitive match", async () => {
    const p = join(dir, "a.txt"); writeFileSync(p, "  indented");
    await expect(handler({ command: "str_replace", path: p, old_str: "indented", new_str: "X" }, ctx))
      .resolves.toBeDefined();
    expect(readFileSync(p, "utf8")).toBe("  X");
  });

  it("missing file throws", async () => {
    await expect(handler({ command: "str_replace", path: join(dir, "missing"), old_str: "a", new_str: "b" }, ctx))
      .rejects.toThrow(/ENOENT/);
  });

  it("rejects empty old_str with a directive error", async () => {
    const p = join(dir, "a.txt"); writeFileSync(p, "alpha");
    await expect(handler({ command: "str_replace", path: p, old_str: "", new_str: "Y" }, ctx))
      .rejects.toThrow(/old_str must be non-empty/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail (handler doesn't accept the new shape yet)**

Run: `cd plugins/llm-local-tools && bun test test/tools/edit.test.ts`

Expected: failures (handler still takes `old_string`/`new_string`; the `command` field is unknown).

- [ ] **Step 3: Rewrite `edit.ts` handler and schema for the new shape**

Replace the contents of `plugins/llm-local-tools/tools/edit.ts` with:

```typescript
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
```

- [ ] **Step 4: Run str_replace tests to verify they pass**

Run: `cd plugins/llm-local-tools && bun test test/tools/edit.test.ts`

Expected: all 8 tests in the `str_replace` describe block pass.

- [ ] **Step 5: Run the full local-tools test suite to verify no regressions**

Run: `cd plugins/llm-local-tools && bun test`

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add plugins/llm-local-tools/tools/edit.ts plugins/llm-local-tools/test/tools/edit.test.ts
git commit -m "feat(local-tools): add str_replace/insert command discriminator to edit

Renames old_string/new_string to old_str/new_str to match Claude Code's
str_replace_based_edit_tool. Empty old_str now throws a directive error
pointing at insert/write instead of the misleading 'not found' message."
```

---

### Task 2: Add tests + verification for `insert` command

The handler in Task 1 already implements `insert`. This task adds the test coverage. Splitting it from Task 1 keeps the diff reviewable.

**Files:**
- Modify: `plugins/llm-local-tools/test/tools/edit.test.ts` (append new describe block)

- [ ] **Step 1: Append insert tests**

Append the following to the END of `plugins/llm-local-tools/test/tools/edit.test.ts` (after the existing `describe("edit tool — str_replace", ...)` block, before EOF):

```typescript
describe("edit tool — insert", () => {
  it("prepends when insert_line is 0", async () => {
    const p = join(dir, "a.txt"); writeFileSync(p, "alpha\nbeta\n");
    await handler({ command: "insert", path: p, insert_line: 0, insert_text: "ZERO\n" }, ctx);
    expect(readFileSync(p, "utf8")).toBe("ZERO\nalpha\nbeta\n");
  });

  it("appends when insert_line equals file's line count", async () => {
    const p = join(dir, "a.txt"); writeFileSync(p, "alpha\nbeta\n");
    await handler({ command: "insert", path: p, insert_line: 2, insert_text: "GAMMA\n" }, ctx);
    expect(readFileSync(p, "utf8")).toBe("alpha\nbeta\nGAMMA\n");
  });

  it("inserts after line N in the middle", async () => {
    const p = join(dir, "a.txt"); writeFileSync(p, "alpha\nbeta\ngamma\n");
    await handler({ command: "insert", path: p, insert_line: 1, insert_text: "MID\n" }, ctx);
    expect(readFileSync(p, "utf8")).toBe("alpha\nMID\nbeta\ngamma\n");
  });

  it("preserves trailing-newline absence when appending verbatim", async () => {
    const p = join(dir, "a.txt"); writeFileSync(p, "alpha\nbeta"); // no trailing \n; line count = 2
    await handler({ command: "insert", path: p, insert_line: 2, insert_text: "GAMMA" }, ctx);
    expect(readFileSync(p, "utf8")).toBe("alpha\nbetaGAMMA");
  });

  it("rejects insert_line past EOF", async () => {
    const p = join(dir, "a.txt"); writeFileSync(p, "alpha\nbeta\n"); // 2 lines
    await expect(handler({ command: "insert", path: p, insert_line: 3, insert_text: "X" }, ctx))
      .rejects.toThrow(/exceeds file length 2 lines/);
  });

  it("rejects negative insert_line", async () => {
    const p = join(dir, "a.txt"); writeFileSync(p, "x\n");
    await expect(handler({ command: "insert", path: p, insert_line: -1, insert_text: "X" }, ctx))
      .rejects.toThrow(/non-negative integer/);
  });

  it("rejects empty insert_text", async () => {
    const p = join(dir, "a.txt"); writeFileSync(p, "x\n");
    await expect(handler({ command: "insert", path: p, insert_line: 0, insert_text: "" }, ctx))
      .rejects.toThrow(/insert_text must be non-empty/);
  });

  it("missing file throws ENOENT", async () => {
    await expect(handler({ command: "insert", path: join(dir, "missing"), insert_line: 0, insert_text: "x" }, ctx))
      .rejects.toThrow(/ENOENT/);
  });

  it("inserts into an empty file when insert_line is 0", async () => {
    const p = join(dir, "a.txt"); writeFileSync(p, ""); // 0 lines
    await handler({ command: "insert", path: p, insert_line: 0, insert_text: "first\n" }, ctx);
    expect(readFileSync(p, "utf8")).toBe("first\n");
  });
});

describe("edit tool — dispatcher", () => {
  it("rejects unknown command", async () => {
    const p = join(dir, "a.txt"); writeFileSync(p, "x");
    await expect(handler({ command: "delete_lines", path: p } as any, ctx))
      .rejects.toThrow(/unknown command/);
  });

  it("rejects missing command", async () => {
    const p = join(dir, "a.txt"); writeFileSync(p, "x");
    await expect(handler({ path: p } as any, ctx))
      .rejects.toThrow(/unknown command/);
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cd plugins/llm-local-tools && bun test test/tools/edit.test.ts`

Expected: all str_replace tests + 9 new insert tests + 2 dispatcher tests pass.

- [ ] **Step 3: Run the full local-tools test suite once more**

Run: `cd plugins/llm-local-tools && bun test`

Expected: full suite passes.

- [ ] **Step 4: Commit**

```bash
git add plugins/llm-local-tools/test/tools/edit.test.ts
git commit -m "test(local-tools): cover edit insert command + dispatcher errors"
```

---

### Task 3: Update TUI renderer for renamed `str_replace` params

**Files:**
- Modify: `plugins/llm-tui/tool-renderers/defaults.tsx:59-93` (the `edit` renderer block)
- Modify: `plugins/llm-tui/tool-renderers/defaults.test.tsx` (existing tests using `old_string`/`new_string`)

- [ ] **Step 1: Update the renderer test to use new param names**

In `plugins/llm-tui/tool-renderers/defaults.test.tsx`, find the test `"edit renderer shows replaced-line headline and a +/- diff preview"` and replace the `args` object so it uses `command`/`old_str`/`new_str`. Also update the error-suppression test similarly.

```typescript
// First test — replace the entry args:
        args: { command: "str_replace", path: "/tmp/foo.ts", old_str: "alpha\nbeta", new_str: "ALPHA\nbeta\nGAMMA" },

// Last test ("error status suppresses verbose body") — replace its args:
        args: { command: "str_replace", path: "/tmp/x", old_str: "a", new_str: "b" },
```

The error-message string assertions (`"old_string not found"`) remain valid as a *display* assertion of what the error message looks like — the renderer just shows whatever string the tool throws; it doesn't generate it. Update the assertion to match the new tool error:

```typescript
// In the error-status test:
        errorMessage: "old_str must be non-empty",
// ...
  expect(out).toContain("old_str must be non-empty");
```

- [ ] **Step 2: Run the renderer tests to confirm they fail**

Run: `cd plugins/llm-tui && bun test tool-renderers/defaults.test.tsx`

Expected: failures — the renderer still reads `args.old_string` / `args.new_string` so the diff is empty.

- [ ] **Step 3: Update the renderer to read the new param names**

In `plugins/llm-tui/tool-renderers/defaults.tsx`, find the `edit` renderer (currently lines ~59-93). Replace its body so it:
1. Reads `args.old_str` and `args.new_str` instead of `old_string`/`new_string`.
2. Treats the renderer as `str_replace`-only for now (the next task adds insert support).

```typescript
    // edit: show a unified-ish diff. str_replace command only; insert handled below.
    {
      toolName: "edit",
      collapsedSummary: (args) => {
        const a = (args ?? {}) as Record<string, unknown>;
        const path = typeof a.path === "string" ? a.path : "";
        const cmd = typeof a.command === "string" ? a.command : "";
        const base = path ? basename(path) : "";
        return cmd && base ? `${cmd} ${base}` : (base || cmd);
      },
      expandedView: (args, _result, status) => {
        if (status === "error") return null;
        const a = (args ?? {}) as Record<string, unknown>;
        if (a.command !== "str_replace") return null;
        const oldStr = typeof a.old_str === "string" ? a.old_str : "";
        const newStr = typeof a.new_str === "string" ? a.new_str : "";
        const oldLines = oldStr === "" ? [] : oldStr.split("\n");
        const newLines = newStr === "" ? [] : newStr.split("\n");
        const headline = `Replaced ${oldLines.length} → ${newLines.length} line${newLines.length === 1 ? "" : "s"}`;
        const oldPrev = previewLines(oldStr, PREVIEW_LINES);
        const newPrev = previewLines(newStr, PREVIEW_LINES);
        return (
          <>
            <Text color={theme.outputColor}>{headline}</Text>
            {renderLines(oldPrev.lines, theme, oldPrev.hidden, () => ({
              glyph: "- ",
              color: theme.noticeColor,
            }))}
            {renderLines(newPrev.lines, theme, newPrev.hidden, () => ({
              glyph: "+ ",
              color: theme.promptColor,
            }))}
          </>
        );
      },
    },
```

- [ ] **Step 4: Run the renderer tests to confirm they pass**

Run: `cd plugins/llm-tui && bun test tool-renderers/defaults.test.tsx`

Expected: pass.

- [ ] **Step 5: Run the full llm-tui test suite to verify no regressions**

Run: `cd plugins/llm-tui && bun test`

Expected: all 149 tests pass (no count change yet).

- [ ] **Step 6: Commit**

```bash
git add plugins/llm-tui/tool-renderers/defaults.tsx plugins/llm-tui/tool-renderers/defaults.test.tsx
git commit -m "feat(llm-tui): edit renderer reads new old_str/new_str params"
```

---

### Task 4: Add `insert`-command preview to the TUI renderer

**Files:**
- Modify: `plugins/llm-tui/tool-renderers/defaults.tsx` (the `edit` renderer's `expandedView`)
- Modify: `plugins/llm-tui/tool-renderers/defaults.test.tsx` (new test)

- [ ] **Step 1: Add a failing test for the insert preview**

Append to `plugins/llm-tui/tool-renderers/defaults.test.tsx`:

```typescript
test("edit renderer with insert command shows inserted-line headline and content preview", () => {
  const reg = withDefaults();
  const { lastFrame } = render(
    <ToolCallBlock
      registry={reg}
      theme={theme as any}
      entry={entry({
        name: "edit",
        args: { command: "insert", path: "/tmp/foo.ts", insert_line: 5, insert_text: "new line A\nnew line B\n" },
        result: "edited /tmp/foo.ts: inserted 2 line(s) at line 5",
      })}
    />
  );
  const out = lastFrame() ?? "";
  expect(out).toContain("Inserted 2 line");
  expect(out).toContain("at line 5");
  expect(out).toContain("new line A");
  expect(out).toContain("new line B");
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `cd plugins/llm-tui && bun test tool-renderers/defaults.test.tsx`

Expected: failure — the renderer returns `null` for non-`str_replace` commands.

- [ ] **Step 3: Extend the renderer to handle `insert`**

In `plugins/llm-tui/tool-renderers/defaults.tsx`, replace the `expandedView` body inside the `edit` renderer with a branched version:

```typescript
      expandedView: (args, _result, status) => {
        if (status === "error") return null;
        const a = (args ?? {}) as Record<string, unknown>;

        if (a.command === "str_replace") {
          const oldStr = typeof a.old_str === "string" ? a.old_str : "";
          const newStr = typeof a.new_str === "string" ? a.new_str : "";
          const oldLines = oldStr === "" ? [] : oldStr.split("\n");
          const newLines = newStr === "" ? [] : newStr.split("\n");
          const headline = `Replaced ${oldLines.length} → ${newLines.length} line${newLines.length === 1 ? "" : "s"}`;
          const oldPrev = previewLines(oldStr, PREVIEW_LINES);
          const newPrev = previewLines(newStr, PREVIEW_LINES);
          return (
            <>
              <Text color={theme.outputColor}>{headline}</Text>
              {renderLines(oldPrev.lines, theme, oldPrev.hidden, () => ({
                glyph: "- ",
                color: theme.noticeColor,
              }))}
              {renderLines(newPrev.lines, theme, newPrev.hidden, () => ({
                glyph: "+ ",
                color: theme.promptColor,
              }))}
            </>
          );
        }

        if (a.command === "insert") {
          const text = typeof a.insert_text === "string" ? a.insert_text : "";
          const line = typeof a.insert_line === "number" ? a.insert_line : 0;
          const total = text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
          const prev = previewLines(text, PREVIEW_LINES);
          return (
            <>
              <Text color={theme.outputColor}>{`Inserted ${total} line${total === 1 ? "" : "s"} at line ${line}`}</Text>
              {renderLines(prev.lines, theme, prev.hidden, () => ({
                glyph: "+ ",
                color: theme.promptColor,
              }))}
            </>
          );
        }

        return null;
      },
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `cd plugins/llm-tui && bun test tool-renderers/defaults.test.tsx`

Expected: pass.

- [ ] **Step 5: Run the full llm-tui suite**

Run: `cd plugins/llm-tui && bun test`

Expected: 150 tests pass (one new).

- [ ] **Step 6: Commit**

```bash
git add plugins/llm-tui/tool-renderers/defaults.tsx plugins/llm-tui/tool-renderers/defaults.test.tsx
git commit -m "feat(llm-tui): preview content for edit insert command"
```

---

### Task 5: Re-bundle and deploy both plugins to the local Kaizen install

The Kaizen runtime prefers `dist/index.js` over source. Source-only changes won't be picked up until both plugins are re-bundled and copied into the install dirs. Per the deploy memory: bundle in the source dir (where node_modules resolves correctly), then copy `dist/index.js` to the install dir.

**Files:**
- Build artifact: `plugins/llm-local-tools/dist/index.js`
- Build artifact: `plugins/llm-tui/dist/index.js`
- Deploy target: `~/.kaizen/marketplaces/official/plugins/llm-local-tools@0.1.0/dist/index.js`
- Deploy target: `~/.kaizen/marketplaces/official/plugins/llm-tui@0.1.0/dist/index.js`

- [ ] **Step 1: Build llm-local-tools bundle**

Run:
```bash
cd plugins/llm-local-tools && mkdir -p dist && bun build --target=bun --outfile=dist/index.js index.ts
```

Expected: "Bundled N modules in Xms" — non-zero output size, no errors.

- [ ] **Step 2: Build llm-tui bundle**

Run:
```bash
cd plugins/llm-tui && mkdir -p dist && bun build --target=bun --outfile=dist/index.js index.tsx
```

Expected: "Bundled N modules in Xms" — non-zero output size, no errors.

- [ ] **Step 3: Deploy both bundles**

Run:
```bash
cp plugins/llm-local-tools/dist/index.js ~/.kaizen/marketplaces/official/plugins/llm-local-tools@0.1.0/dist/index.js
cp plugins/llm-tui/dist/index.js ~/.kaizen/marketplaces/official/plugins/llm-tui@0.1.0/dist/index.js
ls -la ~/.kaizen/marketplaces/official/plugins/llm-local-tools@0.1.0/dist/index.js ~/.kaizen/marketplaces/official/plugins/llm-tui@0.1.0/dist/index.js
```

Expected: both files exist with current timestamps.

- [ ] **Step 4: Smoke-test in a real Kaizen session (manual)**

Start a Kaizen session, prompt the LLM to:
1. Replace text in a file (exercises `str_replace`).
2. Insert a new line into a file (exercises `insert`).

Verify in the TUI:
- The one-liner shows `edit(str_replace foo.ts)` or `edit(insert foo.ts)`.
- The verbose body shows the diff (str_replace) or insertion preview (insert).
- Both calls succeed and the file changes match the expected output.

If anything looks off, return to the relevant task and fix.

---

## Self-Review Notes

- **Spec coverage:** Each spec section is covered: tool surface (Task 1), str_replace semantics + empty-input error (Tasks 1, 2), insert semantics (Tasks 1, 2), schema description (Task 1 step 3), error contract (Task 1 step 3 + tests in Task 2), TUI renderer parameter rename (Task 3), TUI renderer insert preview (Task 4), deployment (Task 5). Migration risks are addressed by the contained-blast-radius search done during design (no peers in repo use `old_string`/`new_string`).
- **Type consistency:** `command` discriminator value strings (`"str_replace"`, `"insert"`) are reused identically across handler, schema, tests, and renderer. Param names (`old_str`, `new_str`, `insert_line`, `insert_text`) are spelled the same throughout.
- **Placeholder scan:** No TBDs, no "add appropriate error handling," no unspecified-test-code steps. Every code-changing step shows the code. Every test step has a runnable command and an expected result.
