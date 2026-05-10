# Edit Tool Expansion — Design

**Status:** Approved (brainstorming complete; awaiting plan)
**Date:** 2026-05-10
**Plugin:** `llm-local-tools`
**Touches:** `plugins/llm-local-tools/tools/edit.ts`, schema/tests

## Problem

The current `edit` tool is strictly find-and-replace by exact string match. This is the right primitive for content-anchored mutation, but it can't express several common operations:

- Insert a line at a specific position.
- Append to EOF.
- Prepend to BOF.
- Replace a known line range.
- Delete lines.

Today the LLM either (a) reads the entire file, computes a new version locally, and uses `write` (heavy, lossy on large files), or (b) constructs a multi-line `old_string` to fake a line-range edit (works but awkward, and the empty-`old_string` failure surface is misleading — a recent run produced "old_string not found in /path/test.txt" when the real issue was that empty `old_string` is undefined behavior).

## Goals

1. Expose insertion as a first-class operation.
2. Keep the existing find-and-replace behavior unchanged for backwards-compatibility.
3. Match Claude Code's `str_replace_based_edit_tool` shape so the LLM uses the tool naturally — the model has been trained on this exact surface.
4. Improve the error message for empty `old_str`.

## Non-Goals

- Not folding `read`/`write`/`create` into the edit tool. Those have richer per-tool invariants (50MB cap, binary sniff, overwrite-vs-create split) that don't benefit from unification.
- Not adding distinct ops for `replace_lines` / `delete_lines` / `append` / `prepend`. These are all expressible via the two primitives below; adding them inflates the schema without buying expressive power. (Replacing lines via `str_replace` even has a built-in safety property: the model must know the exact current content of those lines.)
- Not supporting batched/multi-edit operations. The LLM sequences calls itself.
- Not adding `MultiEdit` or notebook-edit equivalents. Out of scope.

## Design

### Tool surface

The existing `edit` tool gains a `command` discriminator field with two values matching Claude Code's tool exactly: `str_replace` and `insert`.

```
edit
  command: "str_replace" | "insert"     # required, discriminator
  path: string                          # required, all commands

  # str_replace mode (existing behavior, renamed params):
  old_str?: string                      # required when command="str_replace"
  new_str?: string                      # required when command="str_replace"
  replace_all?: boolean                 # optional; defaults false

  # insert mode (new):
  insert_line?: integer                 # required when command="insert"; 0-based, 0 = top of file
  insert_text?: string                  # required when command="insert"
```

### Parameter naming

- `old_string` → `old_str` and `new_string` → `new_str` to match Claude Code. The LLM is heavily trained on these names; using them improves tool-choice accuracy and reduces parameter-name confusion.
- This is a breaking schema change for any peer plugin invoking `edit` directly with the old names. There are no such peers in this repo (verified during design); the change is contained to the tool's internal API.

### Semantics

**`str_replace`** — unchanged from today's behavior:
- Reads file at `path`.
- Counts occurrences of `old_str` in the file.
- 0 occurrences → throws `old_str not found in <abs path>`.
- \>1 occurrences without `replace_all: true` → throws `old_str matched N times in <abs path>; supply more context or set replace_all`.
- `old_str === new_str` → throws `no-op edit: old_str equals new_str`.
- **NEW:** empty `old_str` → throws `old_str must be non-empty; use command="insert" to add content, or `write` to overwrite the file`. (Replaces today's misleading "not found" error for empty input.)
- Otherwise: replaces 1 (or all) occurrences and writes the file.

**`insert`** — new behavior:
- Reads file at `path`. ENOENT → throws same way as `str_replace` does today.
- `insert_line` is 0-based. `0` means "before the first line" (i.e. prepend). `N` for `N > 0` means "after line N". `insert_line` equal to the file's line count means "at EOF" (i.e. append).
- `insert_line` greater than the file's line count → throws `insert_line N exceeds file length M lines`.
- `insert_text` is written verbatim — no auto-trimming, no auto-newline. If the model wants a trailing newline, the model includes one. If `insert_text` is empty → throws `insert_text must be non-empty`.
- The file's existing line endings are preserved as-is.

**Line-counting convention:** A file's "line count" is the number of `\n`-separated lines, where a trailing `\n` does not add an extra line. Concretely: `"a\nb\n".split("\n")` yields `["a", "b", ""]`, but the file has 2 lines. The handler computes line count as `content === "" ? 0 : content.split("\n").length - (content.endsWith("\n") ? 1 : 0)`.

### Error contract

All errors throw native `Error` (per the plugin invariant). Messages always include the resolved absolute path when the file was the issue. New error strings:

- `old_str must be non-empty; use command="insert" to add content, or `write` to overwrite the file`
- `insert_text must be non-empty`
- `insert_line N exceeds file length M lines`
- `insert_line must be a non-negative integer`

### Schema description (LLM-facing)

The tool's top-level description gets rewritten to teach the LLM the two modes and how to express derived operations:

> Edit a text file. Two commands:
> - `str_replace`: find `old_str` and replace with `new_str`. `old_str` MUST appear exactly once unless `replace_all` is true. Use this for replacing or deleting content (delete by setting `new_str` to ""). Use this to replace specific known lines by quoting them exactly in `old_str`.
> - `insert`: insert `insert_text` after line `insert_line` (0-based; 0 = top of file; line-count = EOF/append). Use this when you need to add content without modifying existing lines.

Each mode's params get their own descriptions on the schema.

## Module impact

### `plugins/llm-local-tools/tools/edit.ts`
Replaces the existing single-mode handler with a discriminator on `command`. Two helper functions: `handleStrReplace` and `handleInsert`. The schema becomes a `oneOf`-shaped object — the JSON Schema can't perfectly express conditional-required fields, so we declare both branches' fields optional at the schema level and validate at the handler. The handler validates `command` first, then dispatches.

### `plugins/llm-local-tools/test/tools/edit.test.ts`
Existing tests adapt to the new param names (`old_string` → `old_str`, etc.). New tests:
- `insert` at line 0 (prepend)
- `insert` at line N (middle)
- `insert` at EOF
- `insert` past EOF (rejected)
- `insert` with empty `insert_text` (rejected)
- `insert` on missing file (ENOENT)
- `str_replace` with empty `old_str` (rejected with new message)
- Param-name regression: passing `old_string` (the old name) is rejected.

### `plugins/llm-local-tools/index.ts` and `public.d.ts`
No surface changes — `edit` is still one entry in `ALL_TOOLS` and `TOOL_NAMES`.

### TUI renderer (`plugins/llm-tui/tool-renderers/defaults.tsx`)
The default `edit` renderer needs a small update: it currently reads `args.old_string` / `args.new_string` for the diff preview. Rename to `args.old_str` / `args.new_str`. Also handle the `insert` command: show a "+ inserted N lines at line M" preview. No changes to `ToolCallBlock` itself.

## Testing

Unit tests in `plugins/llm-local-tools/test/tools/edit.test.ts` (existing file, expanded). Each test creates an isolated `mkdtempSync` directory and tears it down — same pattern as the rest of the plugin's tests. No mocking; real filesystem.

Renderer tests in `plugins/llm-tui/tool-renderers/defaults.test.tsx` updated for the renamed params and a new test for the `insert` command's preview.

End-to-end: deploy locally per the plugin's CLAUDE.md (copy + `bun build`), then exercise both commands in a real session.

## Migration / rollout

This is a breaking change to the tool's parameter names (`old_string` → `old_str`). The blast radius:
- The tool's own tests (in-repo, easy update).
- The TUI renderer's default for `edit` (in-repo, easy update).
- Any LLM session mid-flight at upgrade time would have its prior tool-call history referencing `old_string`. That's tolerable — the LLM sees the new schema and adapts on the next call.

No deprecation period. The old names are renamed in one commit. Single-developer repo; not worth a deprecation alias.

## Risks

- **`insert_line: 0` semantics.** "0 = top of file" is CC's convention but it's a footgun (off-by-one vs. a 1-based world). Keeping CC's exact convention so the LLM doesn't have to context-switch is the lesser evil.
- **JSON Schema can't express conditional-required fields cleanly.** We rely on handler-side validation. This is consistent with how the rest of `llm-local-tools` validates inputs.
- **LLM might still try `old_str=""` to mean "prepend".** Mitigated by the explicit error message that names the right tool.
