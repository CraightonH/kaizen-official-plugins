# Human-readable tool result previews

**Date:** 2026-05-10
**Status:** Approved
**Closes:** TODO #1

## Problem

The TUI tool-call row currently surfaces the raw JSON-serialized handler
return value in two places:

1. **Header trail** — `ToolCallBlock.tsx:98` does
   `truncate(entry.result, 40)`, producing
   `bash(...) ✓ — {"exit_code":0,"output":"On branch main…`.
2. **Expanded `⎿` block** — the bash renderer's `expandedView`
   (`tool-renderers/defaults.tsx:170-178`) falls back to the raw
   `result` string when `stdout` is empty (bash never streams via
   `tool:progress`), producing
   `⎿  {"exit_code":0,"output":"On branch main\n…`.

Both are dominated by braces, quotes, and escapes — unreadable at a
glance.

The previous commit `25b4632` ("human-readable tool call summaries")
already solved the symmetric problem for **args**: it introduced
`PRIMARY_ARG_KEYS` + `defaultCollapsedSummary()` in `ToolCallBlock.tsx`,
which picks a primary string field (e.g. `command`, `file_path`) out of
the args object instead of dumping JSON.

This change mirrors that work for **results**.

## Design

### One generic heuristic, two consumers

Introduce `PRIMARY_RESULT_KEYS` parallel to `PRIMARY_ARG_KEYS`:

```ts
const PRIMARY_RESULT_KEYS = [
  "output",   // bash
  "stdout",   // generic shell
  "text",     // read/grep-style
  "content",  // file readers
  "result",   // generic
  "message",  // status/info tools
];
```

Add `defaultResultPreview(result: unknown): string` that:

- Returns `""` for null/undefined.
- For strings starting with `{` or `[`: try `JSON.parse`; if the parse
  yields an object/array, walk it via the shared `pickPrimary` helper
  below. On any failure, fall through.
- For non-JSON strings: `truncate(compactWhitespace(s), MAX_PREVIEW)`.
- For objects: same shape as `defaultCollapsedSummary` —
  primary-key → single-key → compact `key=value` pairs.

Truncation cap is `MAX_PREVIEW` (80, today's constant). The trail's
current 40-char cap goes away — symmetric with the args summary.

### Shared helper module

Extract the common bits to `plugins/llm-tui/tool-renderers/util.ts`:

- `MAX_PREVIEW`
- `compactWhitespace(s)`
- `truncate(s, n)`
- `pickPrimary(obj, keys): string` — encapsulates the
  primary-key → single-key → key=value walk currently inlined in
  `defaultCollapsedSummary`.
- `PRIMARY_ARG_KEYS` and `PRIMARY_RESULT_KEYS`.
- `defaultCollapsedSummary` (moved from `ToolCallBlock.tsx`).
- `defaultResultPreview` (new).

Both `ToolCallBlock.tsx` and `tool-renderers/defaults.tsx` import from
this module. The existing tests in `ToolCallBlock.test.tsx` continue
to assert the summary behavior through the component.

### Consumers

**Header trail** (`ToolCallBlock.tsx:98`). Replace:

```ts
entry.status === "done" && entry.result ? ` — ${truncate(entry.result, 40)}` : ""
```

with:

```ts
entry.status === "done" && entry.result ? ` — ${defaultResultPreview(entry.result)}` : ""
```

**Bash expanded view** (`tool-renderers/defaults.tsx`, bash entry).
When `stdout` is empty, before falling back to raw `result`, attempt
the same projection:

- If `result` is a JSON string and parses to an object with a primary
  string key (per `PRIMARY_RESULT_KEYS`), render the line-preview of
  that string.
- Else render raw `result` as today.

This keeps the multi-line preview behavior; only the source text
changes from JSON blob → extracted output.

## Non-goals

- No renderer interface change (no new `resultPreview` hook).
- No change to `tool:result` plumbing or store shape.
- No exit-code surfacing in the collapsed summary.
- No change to the bash handler or any other tool handler.
- Other tool renderers (`edit`, `write`, `create`) are unchanged —
  their `expandedView` does not consult `result`.

## Risks

- The heuristic is generic, so a tool whose result happens to have a
  string field named `output`/`text`/etc. that is **not** its primary
  payload would show the wrong thing. Mitigated by key ordering:
  `output` (bash) before `text` before `content` before `result`
  before `message`. Any tool with a different shape can still register
  a custom renderer with an explicit `expandedView`.
- Parsing every result as JSON before display adds a small per-row cost
  in the trail. Bounded by `result` length, no async, negligible.

## Files changed

- `plugins/llm-tui/tool-renderers/util.ts` (new)
- `plugins/llm-tui/ui/ToolCallBlock.tsx` — import from util; trail uses
  `defaultResultPreview`; remove inlined summary helpers.
- `plugins/llm-tui/tool-renderers/defaults.tsx` — bash `expandedView`
  consults `pickPrimary` before raw fallback.
- `plugins/llm-tui/ui/ToolCallBlock.test.tsx` — new cases for trail
  preview (mirrors existing summary tests).
- `plugins/llm-tui/tool-renderers/defaults.test.tsx` — bash
  `expandedView` shows extracted `output` text from JSON result; falls
  back to raw on parse failure; `stdout` still wins.

## Test plan

`ToolCallBlock.test.tsx` — new cases:

- Trail with bash-shaped JSON result (`{"exit_code":0,"output":"hi"}`)
  renders `hi`, not the JSON.
- Trail with non-JSON result string renders the string itself.
- Trail with empty result renders no trail (today's behavior).
- Trail with multi-line `output` renders single-line compacted preview.
- Trail respects `MAX_PREVIEW` (80) cap with ellipsis.

`defaults.test.tsx` — new cases for bash `expandedView`:

- JSON result with `output` → `⎿` block shows output lines, not JSON.
- Malformed result string → falls back to raw rendering (no crash).
- Streamed `stdout` present → wins over parsed `output`.
- Empty `output` field → `(no output)`.
