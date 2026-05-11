# Human-readable tool result previews — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the TUI from dumping raw JSON for tool results — surface the primary string field (`output`, `stdout`, `text`, …) the same way `ToolCallBlock` already does for args.

**Architecture:** Mirror commit `25b4632` ("human-readable tool call summaries"). Extract the existing args-summary heuristic into `tool-renderers/util.ts`, add a parallel `defaultResultPreview` driven by `PRIMARY_RESULT_KEYS`, and consume it in two spots: the header trail (`ToolCallBlock.tsx`) and the bash renderer's fallback (`tool-renderers/defaults.tsx`).

**Tech Stack:** TypeScript + React + Ink. Tests via `bun:test` + `ink-testing-library`.

**Spec:** `docs/superpowers/specs/2026-05-10-bash-tool-output-render-design.md`

---

## File Structure

- **Create:** `plugins/llm-tui/tool-renderers/util.ts` — shared heuristics (constants, `pickPrimary`, `defaultCollapsedSummary`, `defaultResultPreview`).
- **Modify:** `plugins/llm-tui/ui/ToolCallBlock.tsx` — import helpers from util; trail uses `defaultResultPreview`.
- **Modify:** `plugins/llm-tui/tool-renderers/defaults.tsx` — bash `expandedView` consults `pickPrimary` before raw fallback.
- **Modify:** `plugins/llm-tui/ui/ToolCallBlock.test.tsx` — new trail-preview tests.
- **Modify:** `plugins/llm-tui/tool-renderers/defaults.test.tsx` — new bash-output tests.

Existing tests for `defaultCollapsedSummary` continue to assert behavior through `ToolCallBlock` (no test moves), guarding the extract-to-util refactor.

---

### Task 1: Extract shared helpers into `tool-renderers/util.ts`

Pure refactor. No behavior change. Existing tests must continue to pass.

**Files:**
- Create: `plugins/llm-tui/tool-renderers/util.ts`
- Modify: `plugins/llm-tui/ui/ToolCallBlock.tsx`

- [ ] **Step 1: Create `tool-renderers/util.ts` with the existing helpers verbatim**

Write `plugins/llm-tui/tool-renderers/util.ts`:

```ts
export const MAX_PREVIEW = 80;

// Heuristic: when args is an object, these keys (in priority order) usually
// hold the "interesting" payload — show their value rather than the whole
// object. Mirrors what Claude Code does for its built-in tools.
export const PRIMARY_ARG_KEYS = [
  "command",     // Bash
  "code",        // execute_typescript / shell-eval
  "file_path", "filePath", "path",   // Read/Edit/Write/Glob
  "pattern",     // Grep/Glob
  "query",       // Search-like tools
  "url",         // Fetch
  "prompt",      // Sub-agent style tools
  "text",
  "message",
  "name",
];

export function compactWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}

// Walk an object: prefer a known primary key with a non-empty string value;
// fall back to single-key value; fall back to compact "key=value" pairs.
// Returns a single-line string suitable for further truncation.
export function pickPrimary(obj: Record<string, unknown>, primaryKeys: string[]): string {
  for (const k of primaryKeys) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) return compactWhitespace(v);
  }

  const keys = Object.keys(obj);
  if (keys.length === 1) {
    const v = obj[keys[0]!];
    if (typeof v === "string") return compactWhitespace(v);
    let vs: string;
    try { vs = JSON.stringify(v); } catch { vs = String(v); }
    return compactWhitespace(vs);
  }

  const parts = keys.map((k) => {
    const v = obj[k];
    const vs = typeof v === "string" ? v : (() => {
      try { return JSON.stringify(v); } catch { return String(v); }
    })();
    return `${k}=${vs}`;
  });
  return compactWhitespace(parts.join(", "));
}

// Render args as a short, human-readable string. Tries to surface the
// "primary" argument value (e.g. the command for Bash, the file path for
// Read) rather than dumping the full JSON object, which is unreadable
// at a glance and dominated by braces and quotes.
export function defaultCollapsedSummary(args: unknown): string {
  if (args == null) return "";
  if (typeof args === "string") return truncate(compactWhitespace(args), MAX_PREVIEW);
  if (typeof args !== "object") return truncate(String(args), MAX_PREVIEW);
  return truncate(pickPrimary(args as Record<string, unknown>, PRIMARY_ARG_KEYS), MAX_PREVIEW);
}
```

- [ ] **Step 2: Replace inlined helpers in `ToolCallBlock.tsx` with imports from util**

Edit `plugins/llm-tui/ui/ToolCallBlock.tsx`:

Replace the top imports + helper definitions (lines ~1-71) with:

```tsx
import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import type { ToolCallEntry } from "../state/store.ts";
import type { ToolRendererRegistry } from "../tool-renderers/registry.ts";
import type { TuiTheme } from "../theme/loader.ts";
import { compactWhitespace, defaultCollapsedSummary, truncate } from "../tool-renderers/util.ts";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
```

Remove `MAX_PREVIEW`, `PRIMARY_ARG_KEYS`, `compactWhitespace`, `truncate`, and `defaultCollapsedSummary` from this file — they now live in `util.ts`. Leave the rest of the component unchanged.

- [ ] **Step 3: Run existing tests to verify refactor is clean**

Run: `cd plugins/llm-tui && bun test ui/ToolCallBlock.test.tsx`
Expected: All existing tests PASS (including the args-summary cases, which exercise the moved code through the component).

Run: `cd plugins/llm-tui && bun test`
Expected: All tests PASS.

- [ ] **Step 4: Commit**

```bash
git add plugins/llm-tui/tool-renderers/util.ts plugins/llm-tui/ui/ToolCallBlock.tsx
git commit -m "refactor(llm-tui): extract tool-summary helpers into util.ts"
```

---

### Task 2: Add `defaultResultPreview` (failing test first)

**Files:**
- Modify: `plugins/llm-tui/ui/ToolCallBlock.test.tsx`
- Modify: `plugins/llm-tui/tool-renderers/util.ts`
- Modify: `plugins/llm-tui/ui/ToolCallBlock.tsx`

- [ ] **Step 1: Add a failing test for the bash JSON trail**

Append to `plugins/llm-tui/ui/ToolCallBlock.test.tsx`:

```tsx
test("default trail extracts `output` from a bash-shaped JSON result", () => {
  const reg = makeToolRendererRegistry();
  const result = JSON.stringify({ exit_code: 0, output: "On branch main\nnothing to commit", duration_ms: 12 });
  const { lastFrame } = render(
    <ToolCallBlock entry={entry({ name: "bash", status: "done", result })} registry={reg} theme={theme as any} />
  );
  const out = lastFrame() ?? "";
  expect(out).toContain("On branch main");
  expect(out).not.toContain('"exit_code"');
  expect(out).not.toContain('"output"');
});

test("default trail renders non-JSON result strings unchanged (compacted)", () => {
  const reg = makeToolRendererRegistry();
  const { lastFrame } = render(
    <ToolCallBlock entry={entry({ name: "x", status: "done", result: "plain output here" })} registry={reg} theme={theme as any} />
  );
  expect(lastFrame() ?? "").toContain("plain output here");
});

test("default trail renders nothing when result is empty", () => {
  const reg = makeToolRendererRegistry();
  const { lastFrame } = render(
    <ToolCallBlock entry={entry({ name: "x", status: "done", result: "" })} registry={reg} theme={theme as any} />
  );
  const out = lastFrame() ?? "";
  expect(out).not.toContain(" — ");
});

test("default trail collapses whitespace in extracted output", () => {
  const reg = makeToolRendererRegistry();
  const result = JSON.stringify({ output: "line1\nline2\n  line3" });
  const { lastFrame } = render(
    <ToolCallBlock entry={entry({ name: "bash", status: "done", result })} registry={reg} theme={theme as any} />
  );
  expect(lastFrame() ?? "").toContain("line1 line2 line3");
});

test("default trail truncates very long output with an ellipsis", () => {
  const reg = makeToolRendererRegistry();
  const long = "a".repeat(200);
  const result = JSON.stringify({ output: long });
  const { lastFrame } = render(
    <ToolCallBlock entry={entry({ name: "bash", status: "done", result })} registry={reg} theme={theme as any} />
  );
  expect(lastFrame() ?? "").toContain("…");
});
```

- [ ] **Step 2: Run new tests to verify they fail**

Run: `cd plugins/llm-tui && bun test ui/ToolCallBlock.test.tsx -t "default trail"`
Expected: FAIL — the trail currently shows the raw JSON, so assertions like `not.toContain('"output"')` fail.

- [ ] **Step 3: Add `PRIMARY_RESULT_KEYS` + `defaultResultPreview` to util.ts**

Edit `plugins/llm-tui/tool-renderers/util.ts`. Append after `defaultCollapsedSummary`:

```ts
// Heuristic: when a tool result is an object, these keys (in priority order)
// usually hold the "interesting" payload. `output` is the bash result shape;
// `stdout` covers generic shell adapters; `text`/`content` cover readers;
// `result`/`message` are generic fallbacks.
export const PRIMARY_RESULT_KEYS = [
  "output",
  "stdout",
  "text",
  "content",
  "result",
  "message",
];

// Render a tool result as a short, human-readable preview. Mirrors
// defaultCollapsedSummary for args. If the result is a JSON string that
// parses to an object, surface the primary string field; otherwise render
// the string itself. Always single-line, truncated to MAX_PREVIEW.
export function defaultResultPreview(result: unknown): string {
  if (result == null) return "";
  if (typeof result === "object") {
    return truncate(pickPrimary(result as Record<string, unknown>, PRIMARY_RESULT_KEYS), MAX_PREVIEW);
  }
  if (typeof result !== "string") return truncate(String(result), MAX_PREVIEW);

  const s = result;
  if (s.length === 0) return "";
  const first = s[0];
  if (first === "{" || first === "[") {
    try {
      const parsed = JSON.parse(s);
      if (parsed && typeof parsed === "object") {
        const picked = pickPrimary(parsed as Record<string, unknown>, PRIMARY_RESULT_KEYS);
        if (picked.length > 0) return truncate(picked, MAX_PREVIEW);
      }
    } catch { /* fall through to raw */ }
  }
  return truncate(compactWhitespace(s), MAX_PREVIEW);
}
```

- [ ] **Step 4: Wire the trail in `ToolCallBlock.tsx` to use `defaultResultPreview`**

Edit `plugins/llm-tui/ui/ToolCallBlock.tsx`:

Update the import:

```tsx
import { compactWhitespace, defaultCollapsedSummary, defaultResultPreview, truncate } from "../tool-renderers/util.ts";
```

Replace the trail computation. Find:

```tsx
  const trail =
    entry.status === "error" && entry.errorMessage ? ` — ${entry.errorMessage}` :
    entry.status === "done" && entry.result ? ` — ${truncate(entry.result, 40)}` :
    "";
```

Replace with:

```tsx
  const resultPreview = entry.status === "done" ? defaultResultPreview(entry.result) : "";
  const trail =
    entry.status === "error" && entry.errorMessage ? ` — ${entry.errorMessage}` :
    resultPreview ? ` — ${resultPreview}` :
    "";
```

(`truncate` and `compactWhitespace` are no longer used directly in this file; remove them from the import if your editor flags unused imports. They remain exported from util for other callers.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd plugins/llm-tui && bun test ui/ToolCallBlock.test.tsx`
Expected: All tests PASS — new trail cases included.

Run: `cd plugins/llm-tui && bun test`
Expected: All tests PASS (no regressions in args-summary or other suites).

- [ ] **Step 6: Commit**

```bash
git add plugins/llm-tui/tool-renderers/util.ts plugins/llm-tui/ui/ToolCallBlock.tsx plugins/llm-tui/ui/ToolCallBlock.test.tsx
git commit -m "feat(llm-tui): human-readable trail preview for tool results"
```

---

### Task 3: Bash `expandedView` extracts `output` from JSON result

**Files:**
- Modify: `plugins/llm-tui/tool-renderers/defaults.test.tsx`
- Modify: `plugins/llm-tui/tool-renderers/defaults.tsx`

- [ ] **Step 1: Add failing tests for the bash expanded view**

Append to `plugins/llm-tui/tool-renderers/defaults.test.tsx`:

```tsx
test("bash renderer extracts `output` text from a JSON result", () => {
  const reg = withDefaults();
  const result = JSON.stringify({
    exit_code: 0,
    output: "On branch main\nnothing to commit, working tree clean",
    duration_ms: 8,
  });
  const { lastFrame } = render(
    <ToolCallBlock
      registry={reg}
      theme={theme as any}
      entry={entry({
        name: "bash",
        args: { command: "git status" },
        status: "done",
        stdout: "",
        result,
      })}
    />
  );
  const out = lastFrame() ?? "";
  expect(out).toContain("On branch main");
  expect(out).toContain("nothing to commit");
  expect(out).not.toContain('"exit_code"');
  expect(out).not.toContain('"output"');
});

test("bash renderer falls back to raw result when it is not parseable JSON", () => {
  const reg = withDefaults();
  const { lastFrame } = render(
    <ToolCallBlock
      registry={reg}
      theme={theme as any}
      entry={entry({
        name: "bash",
        args: { command: "echo hi" },
        status: "done",
        stdout: "",
        result: "not json at all",
      })}
    />
  );
  expect(lastFrame() ?? "").toContain("not json at all");
});

test("bash renderer prefers streamed stdout over parsed output", () => {
  const reg = withDefaults();
  const result = JSON.stringify({ exit_code: 0, output: "FROM-RESULT" });
  const { lastFrame } = render(
    <ToolCallBlock
      registry={reg}
      theme={theme as any}
      entry={entry({
        name: "bash",
        args: { command: "x" },
        status: "done",
        stdout: "FROM-STDOUT",
        result,
      })}
    />
  );
  const out = lastFrame() ?? "";
  expect(out).toContain("FROM-STDOUT");
  expect(out).not.toContain("FROM-RESULT");
});

test("bash renderer renders (no output) when output is empty", () => {
  const reg = withDefaults();
  const result = JSON.stringify({ exit_code: 0, output: "" });
  const { lastFrame } = render(
    <ToolCallBlock
      registry={reg}
      theme={theme as any}
      entry={entry({
        name: "bash",
        args: { command: "true" },
        status: "done",
        stdout: "",
        result,
      })}
    />
  );
  expect(lastFrame() ?? "").toContain("(no output)");
});
```

- [ ] **Step 2: Run new tests to verify they fail**

Run: `cd plugins/llm-tui && bun test tool-renderers/defaults.test.tsx -t "bash renderer"`
Expected: FAIL on the JSON-extraction cases — current code renders the JSON blob.

- [ ] **Step 3: Update bash `expandedView` to parse and extract**

Edit `plugins/llm-tui/tool-renderers/defaults.tsx`.

Update the top import block:

```tsx
import React from "react";
import { Text } from "ink";
import type { TuiToolRenderer } from "./registry.ts";
import type { TuiTheme } from "../theme/loader.ts";
import { PRIMARY_RESULT_KEYS } from "./util.ts";
```

Replace the bash `expandedView` (lines ~170-178) with:

```tsx
      expandedView: (_args, result, status, stdout) => {
        if (status === "error") {
          return result ? renderError(result, theme) : null;
        }
        let text = stdout && stdout.length > 0 ? stdout : "";
        if (!text && result) {
          // Try to extract the primary string field (e.g. `output`) from a
          // JSON-stringified handler result. Fall back to the raw result on
          // any parse failure or shape mismatch.
          if (result.startsWith("{") || result.startsWith("[")) {
            try {
              const parsed = JSON.parse(result);
              if (parsed && typeof parsed === "object") {
                for (const k of PRIMARY_RESULT_KEYS) {
                  const v = (parsed as Record<string, unknown>)[k];
                  if (typeof v === "string") { text = v; break; }
                }
              }
            } catch { /* fall through to raw */ }
          }
          if (!text) text = result;
        }
        if (!text) return <Text color={theme.outputColor} dimColor>(no output)</Text>;
        const prev = previewLines(text, PREVIEW_LINES);
        return renderLines(prev.lines, theme, prev.hidden);
      },
```

Note: empty `output` (string of length 0) is a legitimate extraction — `text` stays `""` and the `(no output)` branch fires. That matches the test expectation.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd plugins/llm-tui && bun test tool-renderers/defaults.test.tsx`
Expected: All tests PASS — new bash cases included, existing edit/write/create cases unaffected.

Run: `cd plugins/llm-tui && bun test`
Expected: All tests PASS across the plugin.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-tui/tool-renderers/defaults.tsx plugins/llm-tui/tool-renderers/defaults.test.tsx
git commit -m "feat(llm-tui): bash renderer extracts output from JSON result"
```

---

### Task 4: Close out TODO and deploy

**Files:**
- Modify: `docs/TODO.md`
- Deploy: copy `plugins/llm-tui` into the local marketplace install dir and rebundle `dist/index.js`.

- [ ] **Step 1: Remove item #1 from `docs/TODO.md`**

Open `docs/TODO.md` and delete the bash-output cleanup entry (the only entry at time of writing). If the file ends up empty, leave it as an empty file — don't delete it.

- [ ] **Step 2: Rebundle the plugin into the local install dir**

```bash
cp -R plugins/llm-tui/. ~/.kaizen/marketplaces/official/plugins/llm-tui@0.1.0/
(cd ~/.kaizen/marketplaces/official/plugins/llm-tui@0.1.0 \
  && bun build --target=bun --outfile=dist/index.js index.tsx)
```

Expected: Bundler completes with `index.js` written; no errors. (Per `plugins/llm-tui/CLAUDE.md` — the runtime prefers the bundled `dist/index.js` over source.)

- [ ] **Step 3: Smoke-test in the actual TUI**

Launch the harness, run a bash tool call (e.g. `git status`), and confirm:
- The header reads roughly `bash(git status) ✓ — On branch main…` (no JSON).
- The `⎿` expansion shows the actual output lines (no JSON).
- Errors and other tools still render correctly.

If the TUI cannot be run in this environment, note that explicitly in the commit message rather than claiming success.

- [ ] **Step 4: Commit**

```bash
git add docs/TODO.md
git commit -m "chore: close TODO #1 — bash tool output cleanup landed"
```
