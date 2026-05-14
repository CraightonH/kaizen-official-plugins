# TUI Opt-in Markdown Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make markdown rendering an opt-in per-write capability across the TUI channel — slash command output (`writeNotice`), assistant output (`writeOutput`), and user echo (`writeUser`) — and add render-time markdown rendering for expanded thoughts in the history view (gated by a new theme key, default on). The live `ThinkingBox` stays plain by design.

**Architecture:** Additive contract changes only. New `WriteOptions` (`{ markdown?: boolean }`) on the three `UiChannelService` write methods, threaded through `TuiStore` to a new `markdown?` field on `PlainTranscriptLine`, consumed by a render switch in `App.tsx`. Per-kind defaults preserve current behavior bit-for-bit: `output` defaults `true`, `notice`/`user` default `false`. Thoughts are gated by a new `UiTheme.thoughtsMarkdown` (default `true`), driving a single-pass `renderMarkdown` in `HistoryView` (memoized by entry id). Slash commands get a `SlashPrintOptions` extension on `ctx.print(text, opts?)` that propagates `markdown` through the existing `conversation:system-message` event payload; the driver bridge forwards it to `writeNotice`.

**Tech Stack:** TypeScript / Bun, `bun:test`, kaizen plugin API v3, `marked` + `marked-terminal` (already vendored in `llm-tui`), Ink + `ink-testing-library`.

**Spec:** `docs/superpowers/specs/2026-05-14-tui-markdown-opt-in.md`

---

## File map

### MR 1 — Contract + TUI + fallback (zero observable change, back-compat by construction)

- **Modify** `plugins/llm-contracts/contracts/ui-channel.ts` — add `WriteOptions` interface; add optional `opts` param on `writeOutput` / `writeNotice` / `writeUser`.
- **Modify** `plugins/llm-contracts/contracts/ui-theme.ts` — add `thoughtsMarkdown: boolean` to `UiTheme`.
- **Modify** `plugins/llm-contracts/public.ts` — re-export `WriteOptions`.
- **Modify** `plugins/llm-tui/state/store.ts` — add `markdown?: boolean` to `PlainTranscriptLine`; add opts param to `appendOutput` / `appendNotice` / `appendUser`.
- **Modify** `plugins/llm-tui/state/store.test.ts` — new cases for the flag carry-through.
- **Modify** `plugins/llm-tui/theme/loader.ts` — add `thoughtsMarkdown: true` to `DEFAULT_THEME`; thread through `pickValid`.
- **Modify** `plugins/llm-tui/theme/loader.test.ts` — assert default + override.
- **Modify** `plugins/llm-tui/ui/App.tsx` — `shouldRenderMarkdown(e)` switch; render through `renderMarkdown` per-kind; drop `dimColor` for markdown notices.
- **Create** `plugins/llm-tui/ui/App.test.tsx` *if absent or sparse* — cases for output / notice / user with and without the flag. (Check whether existing tests already cover render output; extend rather than duplicate.)
- **Modify** `plugins/llm-tui/ui/HistoryView.tsx` — when expanded thoughts + `theme.thoughtsMarkdown`: single `<Text>` + `renderMarkdown`, drop per-line split, drop `dimColor`. Memo cache keyed by `entry.id`.
- **Modify** `plugins/llm-tui/ui/HistoryView.test.tsx` — cases for markdown-on / markdown-off / memo-no-rerun.
- **Modify** `plugins/llm-tui/index.tsx` — pass `opts` through `writeOutput` / `writeNotice` / `writeUser` to the store.
- **Modify** `plugins/llm-tui/fallback.ts` — accept opts; pipe through `renderMarkdown` when `markdown: true`.
- **Modify** `plugins/llm-tui/CLAUDE.md` — invariants for per-kind defaults, thoughts-render rule, theme key.
- **Modify** `plugins/llm-contracts/CLAUDE.md` — note `WriteOptions` and `thoughtsMarkdown` in the contracts table.

### MR 2 — Slash dispatcher + driver bridge (unlocks markdown for slash commands)

- **Modify** `plugins/llm-contracts/contracts/slash-registry.ts` — add `SlashPrintOptions`; update `SlashCommandContext.print` signature.
- **Modify** `plugins/llm-contracts/public.ts` — re-export `SlashPrintOptions`.
- **Modify** `plugins/llm-slash-commands/dispatcher.ts` — `print(text, opts?)` forwards `markdown` into `conversation:system-message` payload.
- **Modify** `plugins/llm-slash-commands/test/dispatcher.test.ts` — case for `markdown: true` propagating into the payload.
- **Modify** `plugins/llm-driver/index.ts` — bridge subscriber reads `payload.markdown` and forwards to `moduleUi.writeNotice(text, opts)`.
- **Modify** `plugins/llm-driver/test/integration.test.ts` (or appropriate driver test) — case for the markdown payload reaching the channel.
- **Modify** `plugins/llm-slash-commands/CLAUDE.md` — note that `ctx.print` accepts an optional `{ markdown }` flag.

### Verification

- Local deploy + smoke test (Task 12).

Explicitly **unchanged**: `plugins/llm-tui/ui/ThoughtsBlock.tsx`, `plugins/llm-tui/ui/ThinkingBox.tsx`. Both stay plain on purpose.

---

## Task 1: Contract changes in `llm-contracts` (TDD)

**Files:**
- Modify: `plugins/llm-contracts/contracts/ui-channel.ts`
- Modify: `plugins/llm-contracts/contracts/ui-theme.ts`
- Modify: `plugins/llm-contracts/public.ts`

This task is type-only; there is no runtime behavior in `llm-contracts`. Tests in this plugin only verify `defineService` calls, so we just confirm the existing test still passes and the type re-exports are present. Type correctness is verified transitively when consumer plugins (`llm-tui`, etc.) build against the updated types in subsequent tasks.

- [ ] **Step 1: Add `WriteOptions` and update `UiChannelService`**

In `plugins/llm-contracts/contracts/ui-channel.ts`, replace the existing contents with:

```typescript
export const CONTRACT_ID = "ui:channel";
export const DESCRIPTION = "Pull-style chat I/O channel between driver and UI.";

export interface WriteOptions {
  /**
   * Render `text` as markdown before display.
   * Default depends on the method:
   *   writeOutput → true  (back-compat with current always-on rendering)
   *   writeNotice → false
   *   writeUser   → false
   * When false, text is rendered verbatim. When true, text is run through
   * the TUI's markdown renderer (marked + marked-terminal) which emits ANSI
   * suitable for Ink <Text> or stdout.
   */
  markdown?: boolean;
}

export interface UiChannelService {
  writeOutput(chunk: string, opts?: WriteOptions): void;
  writeNotice(text: string, opts?: WriteOptions): void;
  /**
   * Append a user-authored message to the transcript. Rendered with the
   * prompt accent (magenta `❯` gutter + subtle background highlight) so
   * it visually anchors the start of a turn against the assistant reply.
   */
  writeUser(text: string, opts?: WriteOptions): void;
  setBusy(state: boolean, message?: string): void;
  /** Set the start time for the current busy period (called on turn:start). */
  setBusyTiming(startedAt: number): void;
  /** Set the absolute completion-token count for the current busy period. */
  updateBusyTokens(deltaTokens: number): void;
  /** Increment the completion-token count by `n` (used during streaming). */
  incrementBusyTokens(n?: number): void;
  readInput(): Promise<string>;
  /** Append a reasoning/thinking delta to the live thinking buffer (rendered above input while busy). */
  appendReasoning(delta: string): void;
  /** Move accumulated reasoning into the transcript as a collapsed Thoughts block. */
  finalizeReasoning(): void;
  /** Discard accumulated reasoning without writing a transcript entry. */
  clearLiveThinking(): void;
  /**
   * Replace the input buffer contents (used for draft prefill on session:handoff
   * with autostart=false). Cursor lands at the end of the inserted text.
   */
  setInputDraft(text: string): void;
}
```

- [ ] **Step 2: Add `thoughtsMarkdown` to `UiTheme`**

In `plugins/llm-contracts/contracts/ui-theme.ts`, replace the contents with:

```typescript
export const CONTRACT_ID = "ui:theme";
export const DESCRIPTION = "Read-only UI theme tokens.";

export interface UiTheme {
  promptLabel: string;
  promptColor: string;
  outputColor: string;
  noticeColor: string;
  busyColor: string;
  statusBarColor: string;
  /**
   * Render expanded thoughts in HistoryView through the markdown renderer.
   * The live ThinkingBox is always plain regardless of this flag.
   * Default: true.
   */
  thoughtsMarkdown: boolean;
}

export interface UiThemeService {
  current(): UiTheme;
}
```

- [ ] **Step 3: Re-export `WriteOptions` from `public.ts`**

In `plugins/llm-contracts/public.ts`, change the `ui-channel` re-export line from:

```typescript
export type { UiChannelService } from "./contracts/ui-channel";
```

to:

```typescript
export type { UiChannelService, WriteOptions } from "./contracts/ui-channel";
```

- [ ] **Step 4: Run the contracts test suite**

Run: `cd plugins/llm-contracts && bun test`
Expected: all existing tests pass. No new test required — the contract change is type-only and is exercised by consumers in later tasks.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-contracts/contracts/ui-channel.ts plugins/llm-contracts/contracts/ui-theme.ts plugins/llm-contracts/public.ts
git commit -m "feat(llm-contracts): add WriteOptions and UiTheme.thoughtsMarkdown"
```

---

## Task 2: `TuiStore` carries `markdown?` on entries (TDD)

**Files:**
- Modify: `plugins/llm-tui/state/store.ts`
- Modify: `plugins/llm-tui/state/store.test.ts`

- [ ] **Step 1: Append failing tests**

Append the following tests to `plugins/llm-tui/state/store.test.ts` (at the bottom of the existing `describe("TuiStore", ...)` block, before the closing brace):

```typescript
  it("appendOutput defaults to no markdown flag on the entry", () => {
    const s = new TuiStore();
    s.appendOutput("hello");
    const e = s.snapshot().transcript[0]! as any;
    expect(e.markdown).toBeUndefined();
  });

  it("appendOutput records markdown: false when explicitly opted out", () => {
    const s = new TuiStore();
    s.appendOutput("raw", { markdown: false });
    const e = s.snapshot().transcript[0]! as any;
    expect(e.markdown).toBe(false);
  });

  it("appendNotice records markdown: true when opted in", () => {
    const s = new TuiStore();
    s.appendNotice("# heading", { markdown: true });
    const e = s.snapshot().transcript[0]! as any;
    expect(e.kind).toBe("notice");
    expect(e.markdown).toBe(true);
  });

  it("appendNotice without opts leaves markdown undefined", () => {
    const s = new TuiStore();
    s.appendNotice("plain");
    const e = s.snapshot().transcript[0]! as any;
    expect(e.markdown).toBeUndefined();
  });

  it("appendUser records markdown: true when opted in (handoffFrom unaffected)", () => {
    const s = new TuiStore();
    s.appendUser("**hi**", { markdown: true, handoffFrom: "abc" });
    const e = s.snapshot().transcript[0]! as any;
    expect(e.kind).toBe("user");
    expect(e.markdown).toBe(true);
    expect(e.handoffFrom).toBe("abc");
  });

  it("two consecutive writes with different flags produce two distinct entries", () => {
    const s = new TuiStore();
    s.appendNotice("plain");
    s.appendNotice("# md", { markdown: true });
    const t = s.snapshot().transcript as any[];
    expect(t).toHaveLength(2);
    expect(t[0].markdown).toBeUndefined();
    expect(t[1].markdown).toBe(true);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd plugins/llm-tui && bun test state/store.test.ts`
Expected: 6 new failures with a TypeScript error like "Expected 1 argument but got 2" on the appender calls.

- [ ] **Step 3: Update `PlainTranscriptLine` and the three appenders**

In `plugins/llm-tui/state/store.ts`, update the `PlainTranscriptLine` interface:

```typescript
export interface PlainTranscriptLine {
  id: number;
  kind: "output" | "notice" | "user" | "thoughts";
  text: string;
  /** Set on `kind: "user"` lines that were seeded by a session:handoff. */
  handoffFrom?: string;
  /**
   * Whether to render the text through renderMarkdown in the UI.
   * Undefined means "use the kind's default" (output → true, notice/user → false).
   * Thoughts ignore this field — they are governed by theme.thoughtsMarkdown.
   */
  markdown?: boolean;
}
```

Find the existing `appendOutput`, `appendNotice`, and `appendUser` methods (around lines 121–140 in the current file). Replace them with:

```typescript
  appendOutput(text: string, opts?: { markdown?: boolean }): void {
    const entry: PlainTranscriptLine = { id: ++this._seq, kind: "output", text };
    if (opts?.markdown !== undefined) entry.markdown = opts.markdown;
    this._transcript = [...this._transcript, entry];
    this._emit();
  }

  appendNotice(text: string, opts?: { markdown?: boolean }): void {
    const entry: PlainTranscriptLine = { id: ++this._seq, kind: "notice", text };
    if (opts?.markdown !== undefined) entry.markdown = opts.markdown;
    this._transcript = [...this._transcript, entry];
    this._emit();
  }

  appendUser(text: string, opts?: { handoffFrom?: string; markdown?: boolean }): void {
    const entry: PlainTranscriptLine = { id: ++this._seq, kind: "user", text };
    if (opts?.handoffFrom) entry.handoffFrom = opts.handoffFrom;
    if (opts?.markdown !== undefined) entry.markdown = opts.markdown;
    this._transcript = [...this._transcript, entry];
    this._emit();
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd plugins/llm-tui && bun test state/store.test.ts`
Expected: all tests pass (existing + 6 new).

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-tui/state/store.ts plugins/llm-tui/state/store.test.ts
git commit -m "feat(llm-tui): carry markdown flag on PlainTranscriptLine"
```

---

## Task 3: Theme `thoughtsMarkdown` default and override (TDD)

**Files:**
- Modify: `plugins/llm-tui/theme/loader.ts`
- Modify: `plugins/llm-tui/theme/loader.test.ts`

- [ ] **Step 1: Append failing tests**

Append the following to `plugins/llm-tui/theme/loader.test.ts` inside the main describe block:

```typescript
  it("DEFAULT_THEME has thoughtsMarkdown: true", () => {
    expect(DEFAULT_THEME.thoughtsMarkdown).toBe(true);
  });

  it("user config can disable thoughtsMarkdown", async () => {
    const theme = await loadTheme({
      home: "/h",
      env: { KAIZEN_LLM_TUI_CONFIG: "/cfg.json" },
      readFile: async () => JSON.stringify({ theme: { thoughtsMarkdown: false } }),
      log: () => {},
    });
    expect(theme.thoughtsMarkdown).toBe(false);
  });

  it("non-boolean thoughtsMarkdown in user config is ignored (falls back to default)", async () => {
    const theme = await loadTheme({
      home: "/h",
      env: { KAIZEN_LLM_TUI_CONFIG: "/cfg.json" },
      readFile: async () => JSON.stringify({ theme: { thoughtsMarkdown: "yes" } }),
      log: () => {},
    });
    expect(theme.thoughtsMarkdown).toBe(true);
  });
```

If `DEFAULT_THEME` is not already imported in the test file, add it to the existing import.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd plugins/llm-tui && bun test theme/loader.test.ts`
Expected: 3 new failures.

- [ ] **Step 3: Update `DEFAULT_THEME` and `pickValid`**

In `plugins/llm-tui/theme/loader.ts`:

Update `DEFAULT_THEME` to include `thoughtsMarkdown`:

```typescript
export const DEFAULT_THEME: UiTheme = Object.freeze({
  promptLabel: "kaizen",
  promptColor: "magenta",
  outputColor: "white",
  noticeColor: "yellow",
  busyColor: "magenta",
  statusBarColor: "gray",
  thoughtsMarkdown: true,
});
```

Update `pickValid` to handle the new boolean key. Insert a new conditional after the `statusBarColor` line:

```typescript
  if (typeof input.thoughtsMarkdown === "boolean") out.thoughtsMarkdown = input.thoughtsMarkdown;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd plugins/llm-tui && bun test theme/loader.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-tui/theme/loader.ts plugins/llm-tui/theme/loader.test.ts
git commit -m "feat(llm-tui): add UiTheme.thoughtsMarkdown (default true)"
```

---

## Task 4: `App.tsx` render switch for output / notice / user (TDD)

**Files:**
- Modify: `plugins/llm-tui/ui/App.tsx`
- Modify: `plugins/llm-tui/ui/App.test.tsx`

- [ ] **Step 1: Inspect the existing `App.test.tsx`**

Run: `cd plugins/llm-tui && cat ui/App.test.tsx | head -40`

Note the existing pattern (Ink test rendering via `ink-testing-library`, fake store construction). New cases should follow that style.

- [ ] **Step 2: Append failing tests**

Append the following tests to `plugins/llm-tui/ui/App.test.tsx` (in the main describe block; if the file has no top-level describe, wrap in one):

```typescript
  it("output entry without markdown flag renders through renderMarkdown (default true)", async () => {
    const s = new TuiStore();
    s.appendOutput("**bold**");
    const { lastFrame } = render(<App store={s} registry={fakeReg()} toolRenderers={fakeTR()} triggers={new Set()} theme={DEFAULT_THEME} onSubmit={() => {}} />);
    // ANSI bold sequence indicates marked-terminal ran. We don't lock the exact codes
    // because chalk versions vary — instead assert the literal asterisks are gone.
    const frame = lastFrame() ?? "";
    expect(frame.includes("**bold**")).toBe(false);
    expect(frame.includes("bold")).toBe(true);
  });

  it("output entry with markdown: false renders raw", async () => {
    const s = new TuiStore();
    s.appendOutput("**bold**", { markdown: false });
    const { lastFrame } = render(<App store={s} registry={fakeReg()} toolRenderers={fakeTR()} triggers={new Set()} theme={DEFAULT_THEME} onSubmit={() => {}} />);
    expect((lastFrame() ?? "").includes("**bold**")).toBe(true);
  });

  it("notice entry without markdown flag renders raw with dim", async () => {
    const s = new TuiStore();
    s.appendNotice("**plain**");
    const { lastFrame } = render(<App store={s} registry={fakeReg()} toolRenderers={fakeTR()} triggers={new Set()} theme={DEFAULT_THEME} onSubmit={() => {}} />);
    expect((lastFrame() ?? "").includes("**plain**")).toBe(true);
  });

  it("notice entry with markdown: true renders through renderMarkdown (no dim)", async () => {
    const s = new TuiStore();
    s.appendNotice("**md**", { markdown: true });
    const { lastFrame } = render(<App store={s} registry={fakeReg()} toolRenderers={fakeTR()} triggers={new Set()} theme={DEFAULT_THEME} onSubmit={() => {}} />);
    const frame = lastFrame() ?? "";
    expect(frame.includes("**md**")).toBe(false);
    expect(frame.includes("md")).toBe(true);
  });

  it("user entry with markdown: true renders through renderMarkdown", async () => {
    const s = new TuiStore();
    s.appendUser("**hi**", { markdown: true });
    const { lastFrame } = render(<App store={s} registry={fakeReg()} toolRenderers={fakeTR()} triggers={new Set()} theme={DEFAULT_THEME} onSubmit={() => {}} />);
    const frame = lastFrame() ?? "";
    expect(frame.includes("**hi**")).toBe(false);
  });
```

If `fakeReg` / `fakeTR` helpers don't already exist in the test file, copy the pattern from the existing tests (likely returning `{ register: () => () => {}, query: () => ({ items: [], total: 0 }) }` for the completion registry and `{ get: () => undefined }` for the tool-renderer registry — adjust to match the actual shapes used by other tests in this file).

If `DEFAULT_THEME` isn't already imported in the test, add it:

```typescript
import { DEFAULT_THEME } from "../theme/loader.ts";
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd plugins/llm-tui && bun test ui/App.test.tsx`
Expected: 5 new failures (notice markdown:true and user markdown:true still render raw; output markdown:false still renders ANSI).

- [ ] **Step 4: Add the render switch to `App.tsx`**

In `plugins/llm-tui/ui/App.tsx`, replace the `renderEntry` function with:

```typescript
  // Whether a transcript entry should be rendered through marked-terminal.
  // output defaults true (back-compat); notice/user default false; thoughts/tool_call always false here
  // (HistoryView handles thoughts; tool_call has its own renderer).
  const shouldRenderMarkdown = (e: TranscriptLine): boolean => {
    if (e.kind === "output") return e.markdown !== false;
    if (e.kind === "notice" || e.kind === "user") return e.markdown === true;
    return false;
  };

  const renderEntry = (e: TranscriptLine) => {
    if (e.kind === "user") {
      const body = shouldRenderMarkdown(e) ? renderMarkdown(e.text) : e.text;
      return (
        <Text>
          {e.handoffFrom && (
            <Text color={theme.noticeColor} dimColor>
              {`[handoff from ${e.handoffFrom}] `}
            </Text>
          )}
          <Text color={theme.promptColor} bold>{"❯ "}</Text>
          <Text color={theme.outputColor} backgroundColor="#2a2a2a">{body}</Text>
        </Text>
      );
    }
    if (e.kind === "thoughts") {
      // Always render collapsed in chat. Use /history (or Ctrl+R) to expand.
      return <ThoughtsBlock text={e.text} color={theme.noticeColor} />;
    }
    if (e.kind === "tool_call") {
      return <ToolCallBlock entry={e} registry={toolRenderers} theme={theme} />;
    }
    if (e.kind === "output") {
      // Render assistant output through marked-terminal by default. Caller can
      // opt out with { markdown: false } (e.g., raw stdout passthrough).
      const body = shouldRenderMarkdown(e) ? renderMarkdown(e.text) : e.text;
      return <Text color={theme.outputColor}>{body}</Text>;
    }
    // notice
    const isMd = shouldRenderMarkdown(e);
    const body = isMd ? renderMarkdown(e.text) : e.text;
    return (
      <Text color={theme.noticeColor} dimColor={!isMd}>
        {body}
      </Text>
    );
  };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd plugins/llm-tui && bun test ui/App.test.tsx`
Expected: all tests pass (existing + 5 new).

Also run the full plugin suite:

Run: `cd plugins/llm-tui && bun test`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add plugins/llm-tui/ui/App.tsx plugins/llm-tui/ui/App.test.tsx
git commit -m "feat(llm-tui): per-entry markdown render switch in App.tsx"
```

---

## Task 5: `HistoryView` markdown rendering for expanded thoughts (TDD)

**Files:**
- Modify: `plugins/llm-tui/ui/HistoryView.tsx`
- Modify: `plugins/llm-tui/ui/HistoryView.test.tsx`

- [ ] **Step 1: Inspect existing test patterns**

Run: `cd plugins/llm-tui && cat ui/HistoryView.test.tsx | head -60`

Note how thoughts are seeded, how `enterHistoryMode` is triggered, and how expansion is toggled.

- [ ] **Step 2: Append failing tests**

Append the following tests to `plugins/llm-tui/ui/HistoryView.test.tsx`:

```typescript
  it("renders expanded thoughts through markdown when theme.thoughtsMarkdown is true (no dim on body)", async () => {
    const s = new TuiStore();
    s.appendReasoning("**bold thought**");
    s.finalizeReasoning();
    s.enterHistoryMode();
    s.historySetAllExpanded(true);
    const theme = { ...DEFAULT_THEME, thoughtsMarkdown: true };
    const { lastFrame } = render(<HistoryView store={s} theme={theme} />);
    const frame = lastFrame() ?? "";
    expect(frame.includes("**bold thought**")).toBe(false);
    expect(frame.includes("bold thought")).toBe(true);
  });

  it("renders expanded thoughts as plain per-line dim text when theme.thoughtsMarkdown is false", async () => {
    const s = new TuiStore();
    s.appendReasoning("**not rendered**");
    s.finalizeReasoning();
    s.enterHistoryMode();
    s.historySetAllExpanded(true);
    const theme = { ...DEFAULT_THEME, thoughtsMarkdown: false };
    const { lastFrame } = render(<HistoryView store={s} theme={theme} />);
    expect((lastFrame() ?? "").includes("**not rendered**")).toBe(true);
  });

  it("memoizes rendered markdown per entry id (renderMarkdown not re-run on collapse/expand)", async () => {
    // Track calls by spying through a thoughts text that contains a unique marker;
    // we cannot intercept renderMarkdown directly without module mocks, so this
    // test verifies the cache contract behaviorally: re-toggling expanded state
    // does not change the rendered ANSI output.
    const s = new TuiStore();
    s.appendReasoning("**stable**");
    s.finalizeReasoning();
    s.enterHistoryMode();
    s.historySetAllExpanded(true);
    const theme = { ...DEFAULT_THEME, thoughtsMarkdown: true };
    const { lastFrame, rerender } = render(<HistoryView store={s} theme={theme} />);
    const first = lastFrame() ?? "";
    s.historySetAllExpanded(false);
    rerender(<HistoryView store={s} theme={theme} />);
    s.historySetAllExpanded(true);
    rerender(<HistoryView store={s} theme={theme} />);
    expect(lastFrame()).toBe(first);
  });
```

If `DEFAULT_THEME` isn't imported, add `import { DEFAULT_THEME } from "../theme/loader.ts";`.

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd plugins/llm-tui && bun test ui/HistoryView.test.tsx`
Expected: 3 new failures (the markdown-on test will see `**bold thought**` in the frame).

- [ ] **Step 4: Add the markdown render path + memo to `HistoryView.tsx`**

In `plugins/llm-tui/ui/HistoryView.tsx`:

Add an import at the top:

```typescript
import { renderMarkdown } from "./markdown.ts";
```

Add a module-scope memo cache above the component:

```typescript
// Memo keyed by transcript entry id. Entries are immutable once committed
// (see TuiStore snapshot identity invariant), so a per-id cache never needs
// invalidation. Survives expand/collapse cycles within the session.
const renderedThoughtsCache = new Map<number, string>();

function getRenderedThoughts(id: number, text: string): string {
  const cached = renderedThoughtsCache.get(id);
  if (cached !== undefined) return cached;
  const out = renderMarkdown(text);
  renderedThoughtsCache.set(id, out);
  return out;
}
```

Replace the `if (e.kind === "thoughts") { ... }` branch inside the `blocks.map` body with:

```typescript
          if (e.kind === "thoughts") {
            const lineCount = e.text.split("\n").filter((l) => l.length > 0).length || 1;
            const renderMd = theme.thoughtsMarkdown;
            return (
              <Box key={e.id} flexDirection="column" borderStyle={isFocused ? "double" : "round"}
                   borderColor={isFocused ? theme.promptColor : theme.noticeColor} paddingX={1}>
                <Text color={isFocused ? theme.promptColor : theme.noticeColor} dimColor={!isFocused}>
                  {`${focusMarker}${caret} 💭 Thoughts ${i + 1} (${lineCount} line${lineCount === 1 ? "" : "s"})`}
                </Text>
                {isOpen && renderMd && (
                  <Text color={theme.noticeColor}>{getRenderedThoughts(e.id, e.text)}</Text>
                )}
                {isOpen && !renderMd && (
                  <Box flexDirection="column">
                    {e.text.split("\n").map((l, j) => (
                      <Text key={j} color={theme.noticeColor} dimColor>{l.length === 0 ? " " : l}</Text>
                    ))}
                  </Box>
                )}
              </Box>
            );
          }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd plugins/llm-tui && bun test ui/HistoryView.test.tsx`
Expected: all tests pass.

Then run the full plugin suite:

Run: `cd plugins/llm-tui && bun test`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add plugins/llm-tui/ui/HistoryView.tsx plugins/llm-tui/ui/HistoryView.test.tsx
git commit -m "feat(llm-tui): render expanded thoughts as markdown (theme.thoughtsMarkdown)"
```

---

## Task 6: Channel wiring in `index.tsx` + fallback (TDD)

**Files:**
- Modify: `plugins/llm-tui/index.tsx`
- Modify: `plugins/llm-tui/fallback.ts`
- Modify: `plugins/llm-tui/index.test.ts`

- [ ] **Step 1: Append failing tests for the wired channel**

Append to `plugins/llm-tui/index.test.ts` (inside the main describe block — match the existing fake-ctx helper pattern):

```typescript
  it("ui:channel writeNotice with markdown:true sets the markdown flag on the store entry", async () => {
    // Use the existing fake ctx helper and mount pattern. The pattern likely
    // looks like: const ctx = makeFakeCtx(); await plugin.setup(ctx); await plugin.start(ctx);
    // Replace with whatever the file already uses.
    const { ctx, store } = await mountTui();
    const ch = ctx.services.get("ui:channel");
    ch.writeNotice("**md**", { markdown: true });
    const e = store.snapshot().transcript.at(-1)! as any;
    expect(e.kind).toBe("notice");
    expect(e.markdown).toBe(true);
  });

  it("ui:channel writeOutput with markdown:false sets markdown: false on the entry", async () => {
    const { ctx, store } = await mountTui();
    const ch = ctx.services.get("ui:channel");
    ch.writeOutput("raw", { markdown: false });
    const e = store.snapshot().transcript.at(-1)! as any;
    expect(e.kind).toBe("output");
    expect(e.markdown).toBe(false);
  });
```

Note: the `mountTui()` helper above is a placeholder — match the actual helper present in `index.test.ts`. If the existing test mounts via `plugin.setup(fakeCtx)` and exposes the store differently, adapt these assertions to the same shape (e.g. read from a fake transcript captured in the ctx).

For the fallback test, append to `plugins/llm-tui/index.test.ts` (or create a `plugins/llm-tui/fallback.test.ts` if none exists):

```typescript
import { createFallbackChannel } from "./fallback.ts";

describe("createFallbackChannel", () => {
  it("writeNotice without opts writes raw text to stderr", () => {
    const writes: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (s: string) => { writes.push(s); return true; };
    try {
      const ch = createFallbackChannel();
      ch.writeNotice("**plain**");
      expect(writes.join("")).toBe("**plain**\n");
    } finally {
      (process.stderr as any).write = origWrite;
    }
  });

  it("writeNotice with markdown:true writes ANSI to stderr", () => {
    const writes: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (s: string) => { writes.push(s); return true; };
    try {
      const ch = createFallbackChannel();
      ch.writeNotice("**md**", { markdown: true });
      const out = writes.join("");
      expect(out.includes("**md**")).toBe(false);
      expect(out.includes("md")).toBe(true);
    } finally {
      (process.stderr as any).write = origWrite;
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd plugins/llm-tui && bun test`
Expected: the new channel-wiring tests fail (writeOutput/writeNotice currently take only one arg in the service implementation) and the fallback tests fail (no opts handling).

- [ ] **Step 3: Wire opts through `index.tsx`**

In `plugins/llm-tui/index.tsx`, find the channel construction (around line 235) and replace it with:

```typescript
    const channel: UiChannelService = {
      readInput: () => store.awaitInput(),
      writeOutput: (chunk: string, opts?: { markdown?: boolean }) => store.appendOutput(chunk, opts),
      writeNotice: (text: string, opts?: { markdown?: boolean }) => store.appendNotice(text, opts),
      writeUser: (text: string, opts?: { markdown?: boolean }) => store.appendUser(text, opts),
      setBusy: (busy: boolean, message?: string) => store.setBusy(busy, message),
      setBusyTiming: (startedAt: number) => store.setBusyTiming(startedAt),
      updateBusyTokens: (deltaTokens: number) => store.updateBusyTokens(deltaTokens),
      incrementBusyTokens: (n?: number) => store.incrementBusyTokens(n),
      appendReasoning: (delta: string) => store.appendReasoning(delta),
      finalizeReasoning: () => store.finalizeReasoning(),
      clearLiveThinking: () => store.clearLiveThinking(),
      setInputDraft: (text: string) => store.setInput(text, text.length),
    };
```

- [ ] **Step 4: Wire opts through `fallback.ts`**

Replace `plugins/llm-tui/fallback.ts` with:

```typescript
import readline from "node:readline";
import type { UiChannelService } from "llm-contracts/public";
import { renderMarkdown } from "./ui/markdown.ts";

export function createFallbackChannel(): UiChannelService {
  let queued: string[] = [];
  let pending: ((line: string) => void) | null = null;
  let rl: readline.Interface | null = null;

  function ensureReader(): void {
    if (rl) return;
    rl = readline.createInterface({ input: process.stdin });
    rl.on("line", (line) => {
      if (pending) {
        const r = pending;
        pending = null;
        r(line);
      } else {
        queued.push(line);
      }
    });
  }

  return {
    // Defaults match the TTY channel: output renders markdown unless opted out;
    // notice/user are plain unless opted in.
    writeOutput(chunk, opts) {
      const md = opts?.markdown !== false;
      process.stdout.write(md ? renderMarkdown(chunk) : chunk);
    },
    writeNotice(text, opts) {
      const md = opts?.markdown === true;
      process.stderr.write(`${md ? renderMarkdown(text) : text}\n`);
    },
    writeUser(text, opts) {
      const md = opts?.markdown === true;
      process.stdout.write(`> ${md ? renderMarkdown(text) : text}\n`);
    },
    setBusy() { /* no-op in non-TTY mode */ },
    setBusyTiming() { /* no-op in non-TTY mode */ },
    updateBusyTokens() { /* no-op in non-TTY mode */ },
    incrementBusyTokens() { /* no-op in non-TTY mode */ },
    appendReasoning() { /* no-op: thinking deltas are dropped in non-TTY mode */ },
    finalizeReasoning() { /* no-op */ },
    clearLiveThinking() { /* no-op */ },
    setInputDraft() { /* no-op: no input buffer in non-TTY mode */ },
    readInput() {
      ensureReader();
      if (queued.length > 0) {
        const next = queued.shift()!;
        return Promise.resolve(next);
      }
      return new Promise<string>((resolve) => { pending = resolve; });
    },
  };
}
```

- [ ] **Step 5: Run the full plugin suite**

Run: `cd plugins/llm-tui && bun test`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add plugins/llm-tui/index.tsx plugins/llm-tui/fallback.ts plugins/llm-tui/index.test.ts plugins/llm-tui/fallback.test.ts 2>/dev/null
git commit -m "feat(llm-tui): thread WriteOptions through channel + fallback"
```

(Use whichever test file you actually added/edited in Step 1.)

---

## Task 7: CLAUDE.md updates (MR 1)

**Files:**
- Modify: `plugins/llm-tui/CLAUDE.md`
- Modify: `plugins/llm-contracts/CLAUDE.md`

- [ ] **Step 1: Add an invariant in `llm-tui/CLAUDE.md`**

In `plugins/llm-tui/CLAUDE.md`, in the "Invariants" section, append:

```
- **Markdown rendering is per-entry, render-time.** Output entries default `markdown: true`; notice/user default `false`. Caller passes `{ markdown: bool }` on the write to override. Thoughts ignore the per-entry flag and are governed by `theme.thoughtsMarkdown` (default true); the live `ThinkingBox` is always plain regardless. `dimColor` is dropped for markdown notices and rendered thoughts.
```

- [ ] **Step 2: Note the contract additions in `llm-contracts/CLAUDE.md`**

In `plugins/llm-contracts/CLAUDE.md`, locate the "What stays in implementation plugins" or equivalent section that summarizes the contracts surface. Append a one-line note (or extend an existing row) calling out the new `WriteOptions` export and `UiTheme.thoughtsMarkdown` key. Concrete text:

```
- `ui-channel` now exposes `WriteOptions { markdown?: boolean }`; opts is additive on `writeOutput` / `writeNotice` / `writeUser`. Per-method default is consumer-side (`llm-tui`), not encoded in the contract.
- `ui-theme` now includes `thoughtsMarkdown: boolean` (default `true`); read by `llm-tui/HistoryView` to gate markdown rendering of expanded thought blocks.
```

- [ ] **Step 3: Commit**

```bash
git add plugins/llm-tui/CLAUDE.md plugins/llm-contracts/CLAUDE.md
git commit -m "docs: document opt-in markdown channel + thoughtsMarkdown theme key"
```

---

## Task 8: Local deploy of MR 1 and back-compat smoke test

**Files:** none modified — verification only.

- [ ] **Step 1: Build and deploy each touched plugin**

```bash
for PLUGIN in llm-contracts llm-tui; do
  VERSION=$(jq -r .version plugins/$PLUGIN/package.json)
  INSTALL_DIR=~/.kaizen/marketplaces/official/plugins/${PLUGIN}@${VERSION}
  ENTRY=$( [ -f plugins/$PLUGIN/index.tsx ] && echo index.tsx || echo index.ts )
  (cd plugins/$PLUGIN && bun build --target=bun --outfile=dist/index.js "$ENTRY")
  mkdir -p "$INSTALL_DIR/dist"
  cp plugins/$PLUGIN/dist/index.js "$INSTALL_DIR/dist/index.js"
  rsync -a --exclude='node_modules' --exclude='dist' plugins/$PLUGIN/ "$INSTALL_DIR/"
done
```

Expected: both builds produce non-zero-byte `dist/index.js`; rsync exits 0.

- [ ] **Step 2: Launch the openai-compatible harness**

```bash
kaizen --harness ./harnesses/openai-compatible.json
```

- [ ] **Step 3: Verify no regression on assistant markdown output**

Send any prompt that produces a markdown response (e.g., "respond with a short markdown list of 3 colors"). The response should still render with ANSI styling exactly as before (this is the same code path as v0; the only change is making the implicit always-on into an explicit default-on).

- [ ] **Step 4: Verify history-view thoughts markdown**

Trigger a turn where the model emits reasoning (use any reasoning-capable model in the harness). After the turn ends, press `Ctrl+R` (or type `/history`) to enter history mode. Navigate to the thoughts block, press Enter to expand. Expected: any markdown in the reasoning (bullets, bold, code spans) renders styled. The collapsed-in-chat thoughts entry still shows only the line-count header.

- [ ] **Step 5: No commit required**

Smoke-only. Done.

---

## Task 9: Slash dispatcher forwards `markdown` flag (TDD) — MR 2 begins

**Files:**
- Modify: `plugins/llm-contracts/contracts/slash-registry.ts`
- Modify: `plugins/llm-contracts/public.ts`
- Modify: `plugins/llm-slash-commands/dispatcher.ts`
- Modify: `plugins/llm-slash-commands/test/dispatcher.test.ts`

- [ ] **Step 1: Append failing tests**

Append to `plugins/llm-slash-commands/test/dispatcher.test.ts` (inside the main describe block):

```typescript
  it("ctx.print without opts emits conversation:system-message without a markdown flag", async () => {
    const events: Array<{ event: string; payload: any }> = [];
    const onSubmit = makeOnInputSubmit({
      registry: mkRegistryWith({
        name: "test:plain",
        handler: async (ctx) => { await ctx.print("hello"); },
      }),
      bus: { emit: async (event, payload) => { events.push({ event, payload }); }, signal: new AbortController().signal },
    });
    await onSubmit({ text: "/test:plain" });
    const sys = events.find((e) => e.event === "conversation:system-message");
    expect(sys).toBeDefined();
    expect(sys!.payload.markdown).toBeUndefined();
    expect(sys!.payload.message.content).toBe("hello");
  });

  it("ctx.print with { markdown: true } emits conversation:system-message with markdown: true", async () => {
    const events: Array<{ event: string; payload: any }> = [];
    const onSubmit = makeOnInputSubmit({
      registry: mkRegistryWith({
        name: "test:md",
        handler: async (ctx) => { await ctx.print("# hi", { markdown: true }); },
      }),
      bus: { emit: async (event, payload) => { events.push({ event, payload }); }, signal: new AbortController().signal },
    });
    await onSubmit({ text: "/test:md" });
    const sys = events.find((e) => e.event === "conversation:system-message");
    expect(sys).toBeDefined();
    expect(sys!.payload.markdown).toBe(true);
    expect(sys!.payload.message.content).toBe("# hi");
  });
```

If `mkRegistryWith` does not exist in the file, build a minimal helper inline using `createRegistry()` + `register()`. Match the helper pattern already used by the other tests in this file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd plugins/llm-slash-commands && bun test test/dispatcher.test.ts`
Expected: the markdown-true case fails because the dispatcher doesn't currently propagate the flag.

- [ ] **Step 3: Add `SlashPrintOptions` to the contract**

In `plugins/llm-contracts/contracts/slash-registry.ts`, replace the existing `SlashCommandContext` interface with:

```typescript
export interface SlashPrintOptions {
  /**
   * When true, the print body is forwarded through the
   * conversation:system-message event with a markdown:true marker.
   * Subscribers that bridge into the UI (e.g., llm-driver → llm-tui)
   * use this to enable markdown rendering on the resulting notice.
   */
  markdown?: boolean;
}

export interface SlashCommandContext {
  args: string;
  raw: string;
  signal: AbortSignal;
  emit: (event: string, payload: unknown) => Promise<void>;
  print: (text: string, opts?: SlashPrintOptions) => Promise<void>;
}
```

- [ ] **Step 4: Re-export `SlashPrintOptions` from `public.ts`**

In `plugins/llm-contracts/public.ts`, change the slash-registry export line to include `SlashPrintOptions`:

```typescript
export type {
  SlashRegistryService,
  SlashCommandContext,
  SlashCommandHandler,
  SlashPrintOptions,
  SlashCommandManifest,
  SlashRegistryEntry,
  RegistryEntry,
} from "./contracts/slash-registry";
```

- [ ] **Step 5: Update `dispatcher.ts` to forward the flag**

In `plugins/llm-slash-commands/dispatcher.ts`, replace the `print` definition with:

```typescript
      const print = async (text: string, opts?: { markdown?: boolean }) => {
        const payload: { message: { role: "system"; content: string }; markdown?: boolean } = {
          message: { role: "system", content: text },
        };
        if (opts?.markdown) payload.markdown = true;
        await deps.bus.emit("conversation:system-message", payload);
      };
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd plugins/llm-slash-commands && bun test`
Expected: all tests pass (existing + 2 new).

- [ ] **Step 7: Commit**

```bash
git add plugins/llm-contracts/contracts/slash-registry.ts plugins/llm-contracts/public.ts plugins/llm-slash-commands/dispatcher.ts plugins/llm-slash-commands/test/dispatcher.test.ts
git commit -m "feat(llm-slash-commands): ctx.print accepts { markdown } opt"
```

---

## Task 10: Driver bridge forwards `payload.markdown` (TDD)

**Files:**
- Modify: `plugins/llm-driver/index.ts`
- Modify: `plugins/llm-driver/test/integration.test.ts` (or appropriate adjacent test)

- [ ] **Step 1: Inspect existing driver tests for the bridge**

Run: `cd plugins/llm-driver && grep -rn "conversation:system-message\|writeNotice" test/`

Identify the test file that exercises the system-message → UI bridge. If none exists, add a focused unit test to `test/integration.test.ts`.

- [ ] **Step 2: Append failing tests**

In the appropriate driver test file, append:

```typescript
  it("forwards conversation:system-message markdown:true to writeNotice with { markdown: true }", async () => {
    const calls: Array<{ text: string; opts: any }> = [];
    const fakeUi = {
      writeNotice: (text: string, opts?: any) => { calls.push({ text, opts }); },
      // …include whatever other UiChannelService method stubs the bridge invokes during setup…
    };
    // Mount driver via the existing test harness, swap moduleUi to fakeUi, then:
    await ctx.emit("conversation:system-message", { message: { role: "system", content: "# md" }, markdown: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toBe("# md");
    expect(calls[0].opts?.markdown).toBe(true);
  });

  it("forwards conversation:system-message without markdown as a plain writeNotice", async () => {
    const calls: Array<{ text: string; opts: any }> = [];
    const fakeUi = {
      writeNotice: (text: string, opts?: any) => { calls.push({ text, opts }); },
    };
    await ctx.emit("conversation:system-message", { message: { role: "system", content: "plain" } });
    expect(calls[0].text).toBe("plain");
    expect(calls[0].opts).toBeUndefined();
  });
```

The exact mount/wire scaffolding (`ctx`, `fakeUi` injection) must match this file's existing helpers. If the integration test mounts the plugin via `plugin.setup(fakeCtx)` and stores `moduleUi` via a side-channel, adapt these tests to the same shape.

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd plugins/llm-driver && bun test`
Expected: the markdown-true test fails because the bridge currently always calls `writeNotice(text)` without opts.

- [ ] **Step 4: Update the bridge in `index.ts`**

In `plugins/llm-driver/index.ts`, find the `ctx.on("conversation:system-message", ...)` subscriber (around line 137) and replace with:

```typescript
    // Bridge system messages (slash command output, plugin notices) to the
    // UI so /help and friends are actually visible. Forwards the optional
    // markdown flag so callers (e.g., ctx.print(text, { markdown: true }))
    // get rendered output in the TUI.
    ctx.on("conversation:system-message", (payload: any) => {
      const text = payload?.message?.content;
      if (typeof text === "string" && text && moduleUi) {
        const opts = payload?.markdown === true ? { markdown: true } : undefined;
        moduleUi.writeNotice(text, opts);
      }
    });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd plugins/llm-driver && bun test`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add plugins/llm-driver/index.ts plugins/llm-driver/test/integration.test.ts
git commit -m "feat(llm-driver): forward markdown flag from system-message to UI"
```

---

## Task 11: CLAUDE.md update for `llm-slash-commands`

**Files:**
- Modify: `plugins/llm-slash-commands/CLAUDE.md`

- [ ] **Step 1: Document the `print` opts in the "Adding a built-in / plugin command" section**

In `plugins/llm-slash-commands/CLAUDE.md`, find the code example in the "Adding a built-in / plugin command" section. Add a one-liner note above or below it:

```
**Markdown output.** `cmdCtx.print(text, { markdown: true })` forwards a `markdown: true` marker on the `conversation:system-message` payload; the driver bridges that into `writeNotice(text, { markdown: true })`, and `llm-tui` renders the body through marked-terminal (and drops `dimColor`). Omit the opt for plain notices.
```

- [ ] **Step 2: Commit**

```bash
git add plugins/llm-slash-commands/CLAUDE.md
git commit -m "docs(llm-slash-commands): note ctx.print markdown opt"
```

---

## Task 12: Local deploy of MR 2 and end-to-end smoke test

**Files:** none modified — verification only.

- [ ] **Step 1: Build and deploy the changed plugins**

```bash
for PLUGIN in llm-contracts llm-slash-commands llm-driver; do
  VERSION=$(jq -r .version plugins/$PLUGIN/package.json)
  INSTALL_DIR=~/.kaizen/marketplaces/official/plugins/${PLUGIN}@${VERSION}
  ENTRY=$( [ -f plugins/$PLUGIN/index.tsx ] && echo index.tsx || echo index.ts )
  (cd plugins/$PLUGIN && bun build --target=bun --outfile=dist/index.js "$ENTRY")
  mkdir -p "$INSTALL_DIR/dist"
  cp plugins/$PLUGIN/dist/index.js "$INSTALL_DIR/dist/index.js"
  rsync -a --exclude='node_modules' --exclude='dist' plugins/$PLUGIN/ "$INSTALL_DIR/"
done
```

Expected: three non-zero-byte bundles; rsync exits 0 for each.

- [ ] **Step 2: Pick one slash command that should render markdown**

Choose one of the slash commands the user recently added that emits markdown bodies (the original motivation for this change). Edit its handler to pass `{ markdown: true }` to `cmdCtx.print`. For example, if a command currently does:

```typescript
await cmdCtx.print(formatThings());
```

change it to:

```typescript
await cmdCtx.print(formatThings(), { markdown: true });
```

Rebuild and redeploy that plugin (same recipe as Step 1, substituting the plugin name).

- [ ] **Step 3: Smoke**

```bash
kaizen --harness ./harnesses/openai-compatible.json
```

Type the slash command. Expected: the body renders with markdown styling (headers, lists, bold, code spans) instead of literal `*`/`#`/backticks.

Also type a stock slash like `/help`. Expected: still renders plain (we did not change `/help` to pass the flag).

- [ ] **Step 4: Verify back-compat one more time**

Send a normal user message and confirm the assistant reply still renders markdown. Trigger reasoning + `Ctrl+R` again to confirm history-view thoughts still render markdown.

- [ ] **Step 5: No commit required**

Smoke-only. Done.

---

## Self-review summary

**Spec coverage:**
- `WriteOptions` on `writeOutput` / `writeNotice` / `writeUser` — Task 1, Task 2, Task 6.
- Per-kind defaults (output→true, notice/user→false), preserving back-compat — Task 4 (`shouldRenderMarkdown`), Task 6 (fallback defaults).
- `UiTheme.thoughtsMarkdown` (default true) — Task 1, Task 3.
- `HistoryView` markdown rendering + memo cache + drop `dimColor` — Task 5.
- `ThinkingBox` and `ThoughtsBlock` unchanged (intentional) — verified by absence from file map.
- `SlashPrintOptions` + dispatcher forwarding via `conversation:system-message` payload — Task 9.
- Driver bridge forwards `payload.markdown` — Task 10.
- Fallback channel honors `markdown: true` and renders ANSI to stdout/stderr — Task 6.
- CLAUDE.md updates across `llm-tui`, `llm-contracts`, `llm-slash-commands` — Tasks 7 and 11.
- Two-MR split (back-compat then activation) — Tasks 1–8 are MR 1; Tasks 9–12 are MR 2.

**Type consistency:** `WriteOptions` and `SlashPrintOptions` are added in `llm-contracts` first and re-exported via `public.ts`; both `llm-tui` (channel impl) and `llm-slash-commands` (dispatcher) import the same names; consumer code uses local structural types (`{ markdown?: boolean }`) for forward-compat. `UiTheme.thoughtsMarkdown` is added to the contract before any consumer reads it, and `DEFAULT_THEME` in the loader keeps the type checker happy by including the new key.

**Placeholders:** the channel-wiring test (`Task 6 Step 1`) and the driver-bridge test (`Task 10 Step 2`) describe shapes that must be adapted to each plugin's existing test harness — I called this out inline rather than guessing at scaffolding I haven't read. Everything else is concrete code.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-14-tui-markdown-opt-in.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks, fast iteration. Natural MR boundary between Task 8 and Task 9.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
