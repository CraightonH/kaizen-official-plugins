# Edit Tool Fixes — Design

**Date:** 2026-05-10
**Status:** Approved
**Plugin:** `llm-local-tools`, `llm-tui`
**Relates to:** `docs/superpowers/archive/specs/2026-05-10-edit-tool-expansion-design.md` (closes risks 1 + 2 from that spec)

## Problem

Live testing of the `edit` tool's `insert` command surfaced two failure modes from real LLM calls:

1. Model called `insert` without `insert_line` → handler-side error `insert_line must be a non-negative integer`. The JSON Schema lists `insert_line` as optional at the top level, so the API accepted the call as well-formed and the failure only manifested at runtime.
2. Model called `insert` with `insert_line: 3` on a 2-line file, intending to append → handler-side error `insert_line 3 exceeds file length 2 lines`. The original 0-based-AFTER convention does not match how `read` numbers lines (1-based AT), and the error message does not surface the valid range or convention.

Both are design holes that the original spec logged as accepted risks:
- "JSON Schema can't perfectly express conditional-required fields, so we declare both branches' fields optional and validate at the handler" — wrong; `oneOf` expresses it.
- "`insert_line: 0` semantics is a footgun (off-by-one vs. a 1-based world). Keeping CC's exact convention so the LLM doesn't have to context-switch is the lesser evil" — but the resulting convention disagrees with `read`, our other line-numbering tool. Inconsistency within the same toolset is the bigger evil.

## Fixes

### 1. `oneOf` schema discrimination

The schema gains a `oneOf` at the top of `parameters` so the API can enforce command-conditional required fields before the handler runs:

```ts
parameters: {
  type: "object",
  properties: { /* unchanged */ },
  required: ["command", "path"],
  oneOf: [
    { properties: { command: { const: "str_replace" } },
      required: ["command", "path", "old_str", "new_str"] },
    { properties: { command: { const: "insert" } },
      required: ["command", "path", "insert_line", "insert_text"] },
  ],
}
```

LLM API tool validators that honor `oneOf` (Anthropic, OpenAI, most others) reject malformed calls before they reach the handler. The handler keeps its runtime checks as a defensive backstop — schema validation is best-effort.

### 2. Switch `insert_line` to 1-based AT semantics

`insert_line: N` now means "the inserted text becomes line N after the operation."

| Operation | 2-line file (`alpha\nbeta`) | Empty file |
|---|---|---|
| Prepend | `insert_line: 1` | `insert_line: 1` |
| After existing line | `insert_line: 2` (between alpha and beta) | n/a |
| Append (EOF) | `insert_line: 3` | `insert_line: 1` |
| Past EOF (rejected) | `insert_line: 4` | `insert_line: 2` |

Valid range: `1 .. file_line_count + 1`. The error case from live testing (`insert_line: 3` on a 2-line file) now succeeds — that's the alignment with model intuition.

Rationale for AT vs AFTER: with AT, the value is "the resulting line number," matching how `read` displays line numbers and matching the mental model an LLM uses when it says "add a line at line N."

### 3. Self-teaching error messages

Errors now include the valid range and a reminder of the convention so a failing call gives the model what it needs to fix the call:

- `insert_line is required when command="insert"; supply a 1-based line number (1..N+1 where N is the file's line count; 1 prepends, N+1 appends)`
- `insert_line must be an integer in 1..M+1 for a ${M}-line file (got ${value}); 1 prepends, ${M+1} appends`
- `insert_line ${N} out of range for ${M}-line file (valid: 1..${M+1}); 1 prepends, ${M+1} appends to EOF`

The `str_replace` errors keep their current shape — they already self-teach (mention `replace_all`, mention `insert`, mention `write`).

### 4. Schema description rewrite

The top-level tool description and `insert_line` field description are updated to lead with the 1-based convention. Examples are included in the description because that is what the LLM reads first:

> Edit a text file. Two commands:
> - `str_replace`: find `old_str` and replace with `new_str`. `old_str` MUST appear exactly once unless `replace_all` is true.
> - `insert`: insert `insert_text` at line `insert_line` (1-based; the inserted text becomes the new line `insert_line`, shifting existing lines down). For a file with N lines, `insert_line: 1` prepends, `insert_line: N+1` appends.

## Migration

This is a breaking semantic change to `insert_line`. Blast radius:
- Handler logic (`plugins/llm-local-tools/tools/edit.ts`).
- Tests (`plugins/llm-local-tools/test/tools/edit.test.ts`).
- TUI renderer (`plugins/llm-tui/tool-renderers/defaults.tsx`) — the `Inserted N lines at line M` headline now uses the same number the LLM passed.
- LLM sessions in flight: the next call will see the new schema/description and adapt. Prior tool-call transcripts that referenced `insert_line: 0` are tolerated (the conversion off-by-one is the LLM's problem to re-derive from the new description).

Single-developer repo; no deprecation alias.

## Non-goals

- Renaming `insert_line` to `at_line`. Would force a full doc/test rewrite for marginal naming-precision gain. The description carries the AT semantics clearly enough.
- Adding more `command` values (`replace_lines`, `delete_lines`, `append`, `prepend`). Same reasoning as the original spec — expressible via the two primitives.

## Files changed

- `plugins/llm-local-tools/tools/edit.ts` — schema (oneOf + new description), `handleInsert` (1-based math + new errors).
- `plugins/llm-local-tools/test/tools/edit.test.ts` — every `insert_line` value shifts by +1; new tests for the schema discrimination cases (validated at handler level since tests bypass the schema validator) and the new error messages.
- `plugins/llm-tui/tool-renderers/defaults.tsx` — the `edit` renderer's `Inserted N lines at line M` headline (no math change; pass-through).
- `plugins/llm-tui/tool-renderers/defaults.test.tsx` — the existing `insert` test's `insert_line` value shifts by +1; assertion text updated.

## Tests

`plugins/llm-local-tools/test/tools/edit.test.ts` updates:

- `prepends when insert_line is 1` (was `is 0`).
- `appends when insert_line equals file's line count + 1` (was `equals file's line count`).
- `inserts at line N in the middle` (now matches the resulting line number).
- `preserves trailing-newline absence when appending verbatim` (recompute `insert_line`).
- `rejects insert_line past EOF` — for a 2-line file, `insert_line: 4` is the past-EOF case.
- `rejects insert_line < 1` — replaces `rejects negative insert_line`.
- `inserts into an empty file when insert_line is 1` (was `is 0`).
- New test: error message for past-EOF includes the valid range string `1..3`.
- New test: error message for invalid type mentions `is required when command="insert"`.

TUI renderer test:
- `insert_line: 5` stays as-is in the args; the rendered headline text `at line 5` still matches.
