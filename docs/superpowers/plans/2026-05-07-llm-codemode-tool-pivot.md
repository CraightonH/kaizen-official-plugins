# llm-codemode Tool Pivot — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `llm-codemode-dispatch` (prose-fence dispatch + fake user-message results) with a new `llm-codemode` plugin that registers `execute_typescript` as a normal OpenAI tool, and surface tool calls as a first-class transcript kind in `llm-tui`. Side effect: fixes `docs/TODO.md` item #2.

**Architecture:** Drop the codemode-specific `tool-dispatch:strategy` provider; switch the openai-compatible harness to the existing `llm-native-dispatch` strategy and add a new `llm-codemode` plugin that registers exactly one tool (`execute_typescript`) via `tools:registry`. The native strategy invokes that tool like any other, producing standard `tool` role messages that the LLM recognizes on recall. Add a `tool:progress` event for sandbox stdout streaming, and add a `tool_call` transcript kind plus a tool-renderer service to `llm-tui`.

**Tech Stack:** Bun (test runner, transpiler, Worker), TypeScript, React + Ink (TUI), `json-schema-to-typescript` (DTS rendering), `mdast-util-from-markdown` (no longer needed — drops out).

**Spec:** `docs/superpowers/specs/2026-05-07-llm-codemode-tool-pivot-design.md`

---

## File structure

### Phase A — `tool:progress` event

- Modify: `plugins/llm-events/index.ts` — add `TOOL_PROGRESS: "tool:progress"` to VOCAB, add `defineEvent` call.
- Modify: `plugins/llm-events/public.d.ts` — add matching `Vocab` interface entry.
- Modify: `plugins/llm-events/index.test.ts` — add to expected set + spot-check.
- Modify: `plugins/llm-events/package.json` — bump minor version.

### Phase B — TUI changes (no codemode dependency)

- Modify: `plugins/llm-tui/state/store.ts` — extend `TranscriptKind`, add `ToolCallEntry` shape, add `appendToolCall` / `updateToolCall`.
- Modify: `plugins/llm-tui/state/store.test.ts` — tests for new methods.
- Create: `plugins/llm-tui/tool-renderers/registry.ts` — `makeToolRendererRegistry()` returns `{ service, lookup }`.
- Create: `plugins/llm-tui/tool-renderers/registry.test.ts`.
- Modify: `plugins/llm-tui/public.d.ts` — export `TuiToolRendererService`, `TuiToolRenderer`, `ToolCallStatus`.
- Create: `plugins/llm-tui/ui/ToolCallBlock.tsx` — collapsed/expanded views, default renderer for unknown tool names.
- Create: `plugins/llm-tui/ui/ToolCallBlock.test.tsx`.
- Modify: `plugins/llm-tui/ui/App.tsx` — add `tool_call` branch to `renderEntry`.
- Modify: `plugins/llm-tui/ui/HistoryView.tsx` — generalize to include `tool_call` entries alongside `thoughts`.
- Modify: `plugins/llm-tui/ui/HistoryView.test.tsx`.
- Modify: `plugins/llm-tui/index.tsx` — define service, subscribe to `tool:execute | tool:progress | tool:result | tool:error`, plumb registry through props.

### Phase C — New `llm-codemode` plugin

- Create: `plugins/llm-codemode/package.json`
- Create: `plugins/llm-codemode/tsconfig.json`
- Create: `plugins/llm-codemode/CLAUDE.md`
- Create: `plugins/llm-codemode/README.md`
- Create: `plugins/llm-codemode/public.d.ts`
- Create: `plugins/llm-codemode/index.ts` — plugin lifecycle, registers `execute_typescript`.
- Create: `plugins/llm-codemode/config.ts` — copied + path renamed.
- Create: `plugins/llm-codemode/wrapper.ts` — copied verbatim.
- Create: `plugins/llm-codemode/sandbox-host.ts` — copied + adds `tool:progress` emission for stdout.
- Create: `plugins/llm-codemode/sandbox-entry.ts` — copied verbatim.
- Create: `plugins/llm-codemode/rpc-types.ts` — copied verbatim.
- Create: `plugins/llm-codemode/dts-render.ts` — copied verbatim.
- Create: `plugins/llm-codemode/serialize.ts` — copied + drops `[code execution result]\n` prefix; produces plain string suitable for `tool` role content.
- Create: `plugins/llm-codemode/assembler.ts` — copied verbatim (only `normalizeServerName` is used by sandbox-host).
- Create: `plugins/llm-codemode/tui-renderer.tsx` — Ink renderer for `execute_typescript`.
- Create: `plugins/llm-codemode/test/*` — copied + adapted unit/integration tests.

### Phase D — Smoke test (manual)

No file changes; verification only.

### Phase E — Cutover

- Modify: `harnesses/openai-compatible.json` — three-way swap.
- Modify: `~/.kaizen/marketplaces/official/plugins/` — remove old plugin install dir.
- Delete: `plugins/llm-codemode-dispatch/` (whole directory).
- Modify: `plugins/llm-events/public.d.ts` — update comment header on `ToolDispatchStrategy` to drop the co-owner reference.
- Modify: `docs/superpowers/archive/specs/2026-04-30-llm-codemode-dispatch-design.md` — add `**Superseded by:**` line.
- Modify: `~/.claude/projects/-Users-chancock-git-kaizen-official-plugins/memory/openai_compatible_harness_arch.md` — replace the "Code-mode dispatch is the default tool-dispatch strategy" decision.
- Move: this plan's spec from `specs/` to `archive/specs/`.

---

## Phase A: Add `tool:progress` event

### Task A1: Add the event to the vocabulary

**Files:**
- Modify: `plugins/llm-events/index.ts`
- Modify: `plugins/llm-events/public.d.ts`

- [ ] **Step 1: Add the vocab literal**

In `plugins/llm-events/index.ts`, locate the existing `TOOL_ERROR: "tool:error"` line in the `VOCAB` object and add the new entry directly below it:

```typescript
TOOL_ERROR: "tool:error",
TOOL_PROGRESS: "tool:progress",
```

- [ ] **Step 2: Add the type entry**

In `plugins/llm-events/public.d.ts`, locate the `readonly TOOL_ERROR: "tool:error";` line in the `Vocab` interface and add directly below it:

```typescript
readonly TOOL_ERROR: "tool:error";
readonly TOOL_PROGRESS: "tool:progress";
```

- [ ] **Step 3: Run tests to see them fail on the missing entry**

Run: `cd plugins/llm-events && bun test`
Expected: at least one failing assertion in `index.test.ts` because the test asserts the VOCAB shape against an `expected` set that does not yet include `tool:progress`.

### Task A2: Update the events test suite

**Files:**
- Modify: `plugins/llm-events/index.test.ts`

- [ ] **Step 1: Add to the expected VOCAB set**

In `plugins/llm-events/index.test.ts`, find the test that builds the `expected` set of VOCAB literals and add `"tool:progress"` to it (alphabetically grouped with the other `tool:*` entries).

- [ ] **Step 2: Add a spot-check assertion**

Add to the same file, in the spot-check test that verifies a few literal values:

```typescript
expect(VOCAB.TOOL_PROGRESS).toBe("tool:progress");
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `cd plugins/llm-events && bun test`
Expected: PASS for all tests.

- [ ] **Step 4: Bump minor version**

In `plugins/llm-events/package.json`, change `"version": "0.3.0"` to `"version": "0.4.0"` (this is a public-ABI extension per the plugin's CLAUDE.md "Adding a new event" section).

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-events/
git commit -m "feat(llm-events): add tool:progress event for streaming tool stdout"
```

---

## Phase B: TUI changes

### Task B1: Extend `TranscriptKind` and add tool_call entry shape

**Files:**
- Modify: `plugins/llm-tui/state/store.ts`
- Modify: `plugins/llm-tui/state/store.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `plugins/llm-tui/state/store.test.ts`:

```typescript
test("appendToolCall adds a running tool_call entry", () => {
  const store = new TuiStore();
  store.appendToolCall("call-1", "read_file", { path: "/etc/hosts" });
  const t = store.snapshot().transcript;
  expect(t).toHaveLength(1);
  expect(t[0]?.kind).toBe("tool_call");
  expect((t[0] as ToolCallEntry).callId).toBe("call-1");
  expect((t[0] as ToolCallEntry).name).toBe("read_file");
  expect((t[0] as ToolCallEntry).status).toBe("running");
  expect((t[0] as ToolCallEntry).args).toEqual({ path: "/etc/hosts" });
});

test("updateToolCall transitions status and attaches result", () => {
  const store = new TuiStore();
  store.appendToolCall("call-1", "read_file", { path: "/etc/hosts" });
  store.updateToolCall("call-1", { status: "done", result: "127.0.0.1 localhost\n" });
  const e = store.snapshot().transcript[0] as ToolCallEntry;
  expect(e.status).toBe("done");
  expect(e.result).toBe("127.0.0.1 localhost\n");
});

test("updateToolCall accumulates stdoutDelta", () => {
  const store = new TuiStore();
  store.appendToolCall("call-1", "execute_typescript", { code: "console.log(1)" });
  store.updateToolCall("call-1", { stdoutDelta: "1\n" });
  store.updateToolCall("call-1", { stdoutDelta: "2\n" });
  const e = store.snapshot().transcript[0] as ToolCallEntry;
  expect(e.stdout).toBe("1\n2\n");
});

test("updateToolCall on unknown id is a no-op", () => {
  const store = new TuiStore();
  expect(() => store.updateToolCall("missing", { status: "done" })).not.toThrow();
  expect(store.snapshot().transcript).toHaveLength(0);
});

test("updateToolCall replaces the entry (snapshot identity changes)", () => {
  const store = new TuiStore();
  store.appendToolCall("call-1", "read_file", {});
  const before = store.snapshot().transcript[0];
  store.updateToolCall("call-1", { status: "done", result: "ok" });
  const after = store.snapshot().transcript[0];
  expect(after).not.toBe(before);
});
```

Add `ToolCallEntry` to the existing imports from `../state/store.ts` at the top of the test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/llm-tui && bun test state/store.test.ts`
Expected: FAIL with errors like "ToolCallEntry is not exported" and "appendToolCall is not a function".

- [ ] **Step 3: Implement the new types**

In `plugins/llm-tui/state/store.ts`, modify the type definitions at the top of the file. Replace this block:

```typescript
export type TranscriptKind = "output" | "notice" | "user" | "thoughts";
export interface TranscriptLine {
  id: number;
  kind: TranscriptKind;
  text: string;
}
```

with:

```typescript
export type TranscriptKind = "output" | "notice" | "user" | "thoughts" | "tool_call";

export type ToolCallStatus = "running" | "done" | "error";

export interface PlainTranscriptLine {
  id: number;
  kind: "output" | "notice" | "user" | "thoughts";
  text: string;
}

export interface ToolCallEntry {
  id: number;
  kind: "tool_call";
  callId: string;
  name: string;
  args: unknown;
  status: ToolCallStatus;
  stdout: string;
  result?: string;
  errorMessage?: string;
}

export type TranscriptLine = PlainTranscriptLine | ToolCallEntry;
```

- [ ] **Step 4: Add the store methods**

In `plugins/llm-tui/state/store.ts`, locate the `appendUser` method and add directly below it:

```typescript
appendToolCall(callId: string, name: string, args: unknown): void {
  const entry: ToolCallEntry = {
    id: ++this._seq,
    kind: "tool_call",
    callId,
    name,
    args,
    status: "running",
    stdout: "",
  };
  this._transcript = [...this._transcript, entry];
  this._emit();
}

updateToolCall(callId: string, patch: {
  status?: ToolCallStatus;
  result?: string;
  errorMessage?: string;
  stdoutDelta?: string;
}): void {
  const idx = this._transcript.findIndex(
    (e) => e.kind === "tool_call" && (e as ToolCallEntry).callId === callId,
  );
  if (idx < 0) return;
  const cur = this._transcript[idx] as ToolCallEntry;
  const next: ToolCallEntry = {
    ...cur,
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    ...(patch.result !== undefined ? { result: patch.result } : {}),
    ...(patch.errorMessage !== undefined ? { errorMessage: patch.errorMessage } : {}),
    stdout: patch.stdoutDelta !== undefined ? cur.stdout + patch.stdoutDelta : cur.stdout,
  };
  this._transcript = [
    ...this._transcript.slice(0, idx),
    next,
    ...this._transcript.slice(idx + 1),
  ];
  this._emit();
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd plugins/llm-tui && bun test state/store.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add plugins/llm-tui/state/
git commit -m "feat(llm-tui): add tool_call transcript kind with mutable status"
```

### Task B2: Add the tool-renderer registry service

**Files:**
- Create: `plugins/llm-tui/tool-renderers/registry.ts`
- Create: `plugins/llm-tui/tool-renderers/registry.test.ts`

- [ ] **Step 1: Write the failing test**

Create `plugins/llm-tui/tool-renderers/registry.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { makeToolRendererRegistry } from "./registry.ts";

test("register and lookup return the registered renderer", () => {
  const reg = makeToolRendererRegistry();
  const renderer = {
    toolName: "read_file",
    collapsedSummary: () => "summary",
    expandedView: () => null as any,
  };
  const off = reg.service.register(renderer);
  expect(reg.lookup("read_file")).toBe(renderer);
  off();
  expect(reg.lookup("read_file")).toBeUndefined();
});

test("unknown tool returns undefined", () => {
  const reg = makeToolRendererRegistry();
  expect(reg.lookup("nope")).toBeUndefined();
});

test("re-register replaces the prior renderer", () => {
  const reg = makeToolRendererRegistry();
  const r1 = { toolName: "x", collapsedSummary: () => "1", expandedView: () => null as any };
  const r2 = { toolName: "x", collapsedSummary: () => "2", expandedView: () => null as any };
  reg.service.register(r1);
  reg.service.register(r2);
  expect(reg.lookup("x")).toBe(r2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/llm-tui && bun test tool-renderers/registry.test.ts`
Expected: FAIL with module-not-found error.

- [ ] **Step 3: Implement the registry**

Create `plugins/llm-tui/tool-renderers/registry.ts`:

```typescript
import type { ReactNode } from "react";
import type { ToolCallStatus } from "../state/store.ts";

export interface TuiToolRenderer {
  toolName: string;
  collapsedSummary: (args: unknown) => string;
  expandedView: (args: unknown, result: string | undefined, status: ToolCallStatus, stdout: string) => ReactNode;
}

export interface TuiToolRendererService {
  register(renderer: TuiToolRenderer): () => void;
}

export interface ToolRendererRegistry {
  service: TuiToolRendererService;
  lookup(toolName: string): TuiToolRenderer | undefined;
}

export function makeToolRendererRegistry(): ToolRendererRegistry {
  const byName = new Map<string, TuiToolRenderer>();
  return {
    service: {
      register(renderer) {
        byName.set(renderer.toolName, renderer);
        return () => {
          if (byName.get(renderer.toolName) === renderer) byName.delete(renderer.toolName);
        };
      },
    },
    lookup(toolName) {
      return byName.get(toolName);
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd plugins/llm-tui && bun test tool-renderers/registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Export types from `public.d.ts`**

In `plugins/llm-tui/public.d.ts`, add at the top of the file (after existing imports):

```typescript
export type { TuiToolRendererService, TuiToolRenderer } from "./tool-renderers/registry";
export type { ToolCallStatus } from "./state/store";
```

- [ ] **Step 6: Commit**

```bash
git add plugins/llm-tui/tool-renderers/ plugins/llm-tui/public.d.ts
git commit -m "feat(llm-tui): add tool-renderer registry service"
```

### Task B3: Default `ToolCallBlock` component

**Files:**
- Create: `plugins/llm-tui/ui/ToolCallBlock.tsx`
- Create: `plugins/llm-tui/ui/ToolCallBlock.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `plugins/llm-tui/ui/ToolCallBlock.test.tsx`:

```typescript
import React from "react";
import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { ToolCallBlock } from "./ToolCallBlock.tsx";
import type { ToolCallEntry } from "../state/store.ts";
import type { ToolRendererRegistry } from "../tool-renderers/registry.ts";
import { makeToolRendererRegistry } from "../tool-renderers/registry.ts";

const theme = {
  promptColor: "cyan",
  outputColor: "white",
  noticeColor: "gray",
  busyColor: "yellow",
  statusBarColor: "blue",
} as const;

const entry = (patch: Partial<ToolCallEntry> = {}): ToolCallEntry => ({
  id: 1,
  kind: "tool_call",
  callId: "call-1",
  name: "read_file",
  args: { path: "/etc/hosts" },
  status: "running",
  stdout: "",
  ...patch,
});

test("renders running status with spinner glyph and tool name", () => {
  const reg = makeToolRendererRegistry();
  const { lastFrame } = render(
    <ToolCallBlock entry={entry()} registry={reg} theme={theme as any} />
  );
  const out = lastFrame() ?? "";
  expect(out).toContain("read_file");
  expect(out).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏…]|running/);
});

test("renders done status with check glyph", () => {
  const reg = makeToolRendererRegistry();
  const { lastFrame } = render(
    <ToolCallBlock entry={entry({ status: "done", result: "ok" })} registry={reg} theme={theme as any} />
  );
  expect(lastFrame() ?? "").toContain("✓");
});

test("renders error status with cross glyph and error message", () => {
  const reg = makeToolRendererRegistry();
  const { lastFrame } = render(
    <ToolCallBlock entry={entry({ status: "error", errorMessage: "boom" })} registry={reg} theme={theme as any} />
  );
  const out = lastFrame() ?? "";
  expect(out).toContain("✗");
  expect(out).toContain("boom");
});

test("uses custom collapsedSummary from a registered renderer", () => {
  const reg = makeToolRendererRegistry();
  reg.service.register({
    toolName: "read_file",
    collapsedSummary: (args) => `path=${(args as any).path}`,
    expandedView: () => null as any,
  });
  const { lastFrame } = render(
    <ToolCallBlock entry={entry()} registry={reg} theme={theme as any} />
  );
  expect(lastFrame() ?? "").toContain("path=/etc/hosts");
});

test("falls back to JSON.stringify of args when no renderer registered", () => {
  const reg = makeToolRendererRegistry();
  const { lastFrame } = render(
    <ToolCallBlock entry={entry()} registry={reg} theme={theme as any} />
  );
  expect(lastFrame() ?? "").toContain('{"path":"/etc/hosts"}');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/llm-tui && bun test ui/ToolCallBlock.test.tsx`
Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement the component**

Create `plugins/llm-tui/ui/ToolCallBlock.tsx`:

```typescript
import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import type { ToolCallEntry } from "../state/store.ts";
import type { ToolRendererRegistry } from "../tool-renderers/registry.ts";
import type { TuiTheme } from "../theme/loader.ts";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MAX_PREVIEW = 60;

function defaultCollapsedSummary(args: unknown): string {
  let s: string;
  try { s = JSON.stringify(args ?? {}); } catch { s = String(args); }
  if (s.length > MAX_PREVIEW) s = `${s.slice(0, MAX_PREVIEW - 1)}…`;
  return s;
}

export interface ToolCallBlockProps {
  entry: ToolCallEntry;
  registry: ToolRendererRegistry;
  theme: TuiTheme;
}

export const ToolCallBlock: React.FC<ToolCallBlockProps> = ({ entry, registry, theme }) => {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (entry.status !== "running") return;
    const t = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(t);
  }, [entry.status]);

  const renderer = registry.lookup(entry.name);
  const summary = renderer ? renderer.collapsedSummary(entry.args) : defaultCollapsedSummary(entry.args);

  let glyph: string;
  let glyphColor = theme.outputColor;
  if (entry.status === "running") { glyph = SPINNER_FRAMES[frame]!; glyphColor = theme.busyColor; }
  else if (entry.status === "done") { glyph = "✓"; glyphColor = theme.outputColor; }
  else { glyph = "✗"; glyphColor = theme.noticeColor; }

  const trail =
    entry.status === "error" && entry.errorMessage ? ` — ${entry.errorMessage}` :
    entry.status === "done" && entry.result ? ` — ${truncate(entry.result, 40)}` :
    "";

  return (
    <Text>
      <Text color={theme.promptColor}>{"▸ "}</Text>
      <Text color={theme.promptColor} bold>{entry.name}</Text>
      <Text color={theme.outputColor}>{"  "}</Text>
      <Text color={theme.outputColor} dimColor>{summary}</Text>
      <Text color={glyphColor}>{`  ${glyph}`}</Text>
      <Text color={theme.outputColor} dimColor>{trail}</Text>
    </Text>
  );
};

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd plugins/llm-tui && bun test ui/ToolCallBlock.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-tui/ui/ToolCallBlock.tsx plugins/llm-tui/ui/ToolCallBlock.test.tsx
git commit -m "feat(llm-tui): default ToolCallBlock renderer"
```

### Task B4: Wire `tool_call` rendering into `App.tsx`

**Files:**
- Modify: `plugins/llm-tui/ui/App.tsx`

- [ ] **Step 1: Extend props with the renderer registry**

In `plugins/llm-tui/ui/App.tsx`, replace the `AppProps` interface and the `App` component prop list as follows.

Replace:

```typescript
export interface AppProps {
  store: TuiStore;
  registry: CompletionRegistry;
  triggers: Set<string>;
  theme: TuiTheme;
  onSubmit: (text: string) => void;
  onCtrlC?: () => void;
}

export const App: React.FC<AppProps> = ({ store, registry, triggers, theme, onSubmit, onCtrlC }) => {
```

With:

```typescript
import type { ToolRendererRegistry } from "../tool-renderers/registry.ts";
import { ToolCallBlock } from "./ToolCallBlock.tsx";

export interface AppProps {
  store: TuiStore;
  registry: CompletionRegistry;
  toolRenderers: ToolRendererRegistry;
  triggers: Set<string>;
  theme: TuiTheme;
  onSubmit: (text: string) => void;
  onCtrlC?: () => void;
}

export const App: React.FC<AppProps> = ({ store, registry, toolRenderers, triggers, theme, onSubmit, onCtrlC }) => {
```

(Add the new `import` lines at the top of the file alongside the others.)

- [ ] **Step 2: Add the `tool_call` branch to `renderEntry`**

In the same file, replace the existing `renderEntry` function with:

```typescript
const renderEntry = (e: TranscriptLine) => {
  if (e.kind === "user") {
    return (
      <Text>
        <Text color={theme.promptColor} bold>{"❯ "}</Text>
        <Text color={theme.outputColor} backgroundColor="#2a2a2a">{e.text}</Text>
      </Text>
    );
  }
  if (e.kind === "thoughts") {
    return <ThoughtsBlock text={e.text} color={theme.noticeColor} />;
  }
  if (e.kind === "tool_call") {
    return <ToolCallBlock entry={e} registry={toolRenderers} theme={theme} />;
  }
  return (
    <Text color={e.kind === "notice" ? theme.noticeColor : theme.outputColor} dimColor={e.kind === "notice"}>
      {e.text}
    </Text>
  );
};
```

- [ ] **Step 3: Run the existing App test to confirm no regression**

Run: `cd plugins/llm-tui && bun test ui/App.test.tsx`
Expected: tests fail until `App.test.tsx` is updated to pass `toolRenderers` (do that next), but the static type-check of the new branch should resolve.

- [ ] **Step 4: Update `App.test.tsx` to pass a registry**

Open `plugins/llm-tui/ui/App.test.tsx`. Add an import:

```typescript
import { makeToolRendererRegistry } from "../tool-renderers/registry.ts";
```

For every place that does `render(<App ... />)`, add `toolRenderers={makeToolRendererRegistry()}` to the props. (One quick way: search the file for `<App ` and add the prop to each.)

- [ ] **Step 5: Run all TUI tests**

Run: `cd plugins/llm-tui && bun test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add plugins/llm-tui/ui/App.tsx plugins/llm-tui/ui/App.test.tsx
git commit -m "feat(llm-tui): render tool_call entries in App via ToolCallBlock"
```

### Task B5: Generalize `HistoryView` to include `tool_call` entries

**Files:**
- Modify: `plugins/llm-tui/ui/HistoryView.tsx`
- Modify: `plugins/llm-tui/ui/HistoryView.test.tsx`
- Modify: `plugins/llm-tui/state/store.ts`

- [ ] **Step 1: Widen the history filter in the store**

In `plugins/llm-tui/state/store.ts`, find every occurrence of:

```typescript
const blocks = this._transcript.filter((e) => e.kind === "thoughts");
```

and replace with:

```typescript
const blocks = this._transcript.filter((e) => e.kind === "thoughts" || e.kind === "tool_call");
```

There are four such occurrences (in `enterHistoryMode`, `historyMoveFocus`, `historyToggleFocused`, `historySetAllExpanded`). Replace all four.

- [ ] **Step 2: Update the existing store tests**

In `plugins/llm-tui/state/store.test.ts`, locate any test that asserts history-mode block count is exactly the number of `thoughts` entries — update it so the assertion holds when `tool_call` entries are also counted. If you find an existing test like:

```typescript
test("enterHistoryMode counts only thought blocks", () => { ... });
```

rename and revise it to assert on combined `thoughts` + `tool_call` counts. (If unsure, run the suite first and fix any failures inline based on the failure messages.)

Add a new test:

```typescript
test("enterHistoryMode focuses across thoughts and tool_calls in transcript order", () => {
  const store = new TuiStore();
  store.appendUser("hi");
  store.appendReasoning("thinking…");
  store.finalizeReasoning();
  store.appendToolCall("c1", "read_file", { path: "/x" });
  store.enterHistoryMode();
  const snap = store.snapshot();
  expect(snap.viewMode).toBe("history");
  expect(snap.historyView.focusIdx).toBe(0); // thoughts first (transcript order)
});
```

- [ ] **Step 3: Update `HistoryView.tsx`**

In `plugins/llm-tui/ui/HistoryView.tsx`, replace the line:

```typescript
const blocks = snap.transcript.filter((e: TranscriptLine) => e.kind === "thoughts");
```

with:

```typescript
const blocks = snap.transcript.filter(
  (e: TranscriptLine) => e.kind === "thoughts" || e.kind === "tool_call",
);
```

Then replace the block-rendering `.map(...)` so it switches on kind. Replace this section:

```typescript
{blocks.length === 0 ? (
  <Text color={theme.outputColor} dimColor>(no thought blocks yet)</Text>
) : (
  blocks.map((e, i) => {
    const isFocused = e.id === focusedId;
    const isOpen = expanded.has(e.id);
    const lineCount = e.text.split("\n").filter((l) => l.length > 0).length || 1;
    const caret = isOpen ? "▼" : "▶";
    const focusMarker = isFocused ? "▎ " : "  ";
    return (
      <Box
        key={e.id}
        flexDirection="column"
        borderStyle={isFocused ? "double" : "round"}
        borderColor={isFocused ? theme.promptColor : theme.noticeColor}
        paddingX={1}
      >
        <Text color={isFocused ? theme.promptColor : theme.noticeColor} dimColor={!isFocused}>
          {`${focusMarker}${caret} 💭 Block ${i + 1} (${lineCount} line${lineCount === 1 ? "" : "s"})`}
        </Text>
        {isOpen && (
          <Box flexDirection="column">
            {e.text.split("\n").map((l, j) => (
              <Text key={j} color={theme.noticeColor} dimColor>{l.length === 0 ? " " : l}</Text>
            ))}
          </Box>
        )}
      </Box>
    );
  })
)}
```

with:

```typescript
{blocks.length === 0 ? (
  <Text color={theme.outputColor} dimColor>(no entries yet)</Text>
) : (
  blocks.map((e, i) => {
    const isFocused = e.id === focusedId;
    const isOpen = expanded.has(e.id);
    const caret = isOpen ? "▼" : "▶";
    const focusMarker = isFocused ? "▎ " : "  ";
    if (e.kind === "thoughts") {
      const lineCount = e.text.split("\n").filter((l) => l.length > 0).length || 1;
      return (
        <Box key={e.id} flexDirection="column" borderStyle={isFocused ? "double" : "round"}
             borderColor={isFocused ? theme.promptColor : theme.noticeColor} paddingX={1}>
          <Text color={isFocused ? theme.promptColor : theme.noticeColor} dimColor={!isFocused}>
            {`${focusMarker}${caret} 💭 Thoughts ${i + 1} (${lineCount} line${lineCount === 1 ? "" : "s"})`}
          </Text>
          {isOpen && (
            <Box flexDirection="column">
              {e.text.split("\n").map((l, j) => (
                <Text key={j} color={theme.noticeColor} dimColor>{l.length === 0 ? " " : l}</Text>
              ))}
            </Box>
          )}
        </Box>
      );
    }
    // tool_call
    const status = e.status === "running" ? "…" : e.status === "done" ? "✓" : "✗";
    return (
      <Box key={e.id} flexDirection="column" borderStyle={isFocused ? "double" : "round"}
           borderColor={isFocused ? theme.promptColor : theme.noticeColor} paddingX={1}>
        <Text color={isFocused ? theme.promptColor : theme.noticeColor} dimColor={!isFocused}>
          {`${focusMarker}${caret} 🔧 ${e.name} ${status}`}
        </Text>
        {isOpen && (
          <Box flexDirection="column">
            <Text color={theme.outputColor} dimColor>args: {safeJson(e.args)}</Text>
            {e.stdout && <Text color={theme.outputColor} dimColor>stdout:</Text>}
            {e.stdout && e.stdout.split("\n").map((l, j) => (
              <Text key={`s${j}`} color={theme.outputColor} dimColor>{l.length === 0 ? " " : l}</Text>
            ))}
            {e.result && <Text color={theme.outputColor} dimColor>result: {e.result}</Text>}
            {e.errorMessage && <Text color={theme.noticeColor}>error: {e.errorMessage}</Text>}
          </Box>
        )}
      </Box>
    );
  })
)}
```

Add this helper at the bottom of `HistoryView.tsx`, outside the component:

```typescript
function safeJson(v: unknown): string {
  try { return JSON.stringify(v); } catch { return String(v); }
}
```

Update the header line above the list. Replace:

```typescript
📜 History — {blocks.length} thought block{blocks.length === 1 ? "" : "s"}
```

with:

```typescript
📜 History — {blocks.length} entr{blocks.length === 1 ? "y" : "ies"}
```

- [ ] **Step 4: Update HistoryView tests**

Open `plugins/llm-tui/ui/HistoryView.test.tsx`. Find any test that hardcodes the thought-only message ("thought block" or "(no thought blocks yet)") and update:
- "(no thought blocks yet)" → "(no entries yet)"
- "thought block" assertions → "entr" / "Thoughts" matches

Add a new test that asserts a `tool_call` entry renders with the wrench glyph:

```typescript
test("renders a tool_call entry with wrench glyph in history", () => {
  const store = new TuiStore();
  store.appendToolCall("c1", "read_file", { path: "/etc/hosts" });
  store.enterHistoryMode();
  const { lastFrame } = render(<HistoryView store={store} theme={theme as any} />);
  expect(lastFrame() ?? "").toContain("read_file");
  expect(lastFrame() ?? "").toContain("🔧");
});
```

- [ ] **Step 5: Run all TUI tests**

Run: `cd plugins/llm-tui && bun test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add plugins/llm-tui/ui/HistoryView.tsx plugins/llm-tui/ui/HistoryView.test.tsx plugins/llm-tui/state/
git commit -m "feat(llm-tui): include tool_call entries in /history audit view"
```

### Task B6: Wire the renderer registry and event subscriptions in `index.tsx`

**Files:**
- Modify: `plugins/llm-tui/index.tsx`
- Modify: `plugins/llm-tui/integration.test.ts`

- [ ] **Step 1: Add the service definition and registry construction**

In `plugins/llm-tui/index.tsx`:

Add an import at the top alongside other imports:

```typescript
import { makeToolRendererRegistry } from "./tool-renderers/registry.ts";
import type { TuiToolRendererService } from "./tool-renderers/registry.ts";
```

In `services.provides`, add the new service name:

```typescript
provides: ["llm-tui:channel", "llm-tui:completion", "llm-tui:status", "llm-tui:theme", "llm-tui:tool-renderer"],
```

After the existing `ctx.defineService("llm-tui:theme", ...);` line, add:

```typescript
ctx.defineService("llm-tui:tool-renderer", { description: "Per-tool TUI rendering registry." });
```

After `const registry = makeCompletionRegistry();`, add:

```typescript
const toolRenderers = makeToolRendererRegistry();
ctx.provideService<TuiToolRendererService>("llm-tui:tool-renderer", toolRenderers.service);
```

- [ ] **Step 2: Add the event subscriptions**

In `plugins/llm-tui/index.tsx`, locate the existing block that subscribes to `status:item-update` / `status:item-clear`. Add directly above that block:

```typescript
ctx.on("tool:execute", async (payload: any) => {
  if (!payload || typeof payload.callId !== "string" || typeof payload.name !== "string") return;
  store.appendToolCall(payload.callId, payload.name, payload.args);
});
ctx.on("tool:progress", async (payload: any) => {
  if (!payload || typeof payload.callId !== "string" || typeof payload.delta !== "string") return;
  store.updateToolCall(payload.callId, { stdoutDelta: payload.delta });
});
ctx.on("tool:result", async (payload: any) => {
  if (!payload || typeof payload.callId !== "string") return;
  const result = typeof payload.result === "string" ? payload.result : safeJson(payload.result);
  store.updateToolCall(payload.callId, { status: "done", result });
});
ctx.on("tool:error", async (payload: any) => {
  if (!payload || typeof payload.callId !== "string") return;
  const msg = typeof payload.message === "string" ? payload.message : "tool error";
  store.updateToolCall(payload.callId, { status: "error", errorMessage: msg });
});
```

Add this helper at the bottom of `index.tsx` (outside the plugin object, top-level):

```typescript
function safeJson(v: unknown): string {
  try { return JSON.stringify(v); } catch { return String(v); }
}
```

- [ ] **Step 3: Pass `toolRenderers` into the App component**

In the `render(<App ... />)` call inside `index.tsx`, add the new prop:

```typescript
const inkApp = render(
  <App
    store={store}
    registry={registry}
    toolRenderers={toolRenderers}
    triggers={triggers}
    theme={theme}
    onSubmit={onSubmit}
    onCtrlC={onCtrlC}
  />,
);
```

- [ ] **Step 4: Update the integration test**

Open `plugins/llm-tui/integration.test.ts`. Find any test that simulates events to drive the store. Add an integration test that exercises the tool lifecycle:

```typescript
test("tool:execute → tool:result populates a tool_call entry end-to-end", () => {
  const store = new TuiStore();
  // simulate the four event handlers wired in index.tsx
  store.appendToolCall("c1", "read_file", { path: "/etc/hosts" });
  store.updateToolCall("c1", { stdoutDelta: "127.0.0.1 localhost\n" });
  store.updateToolCall("c1", { status: "done", result: "127.0.0.1 localhost\n" });
  const t = store.snapshot().transcript;
  expect(t).toHaveLength(1);
  expect((t[0] as any).status).toBe("done");
  expect((t[0] as any).stdout).toBe("127.0.0.1 localhost\n");
});
```

- [ ] **Step 5: Update the lifecycle smoke test (`index.test.ts`)**

If `plugins/llm-tui/index.test.ts` constructs a fake `ctx` and asserts on `services.provides`, update its assertion to include `"llm-tui:tool-renderer"`. Adjust any `defineService` mock-call counts that hardcode a number.

- [ ] **Step 6: Run all TUI tests**

Run: `cd plugins/llm-tui && bun test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add plugins/llm-tui/
git commit -m "feat(llm-tui): subscribe to tool:* events and provide tool-renderer service"
```

### Task B7: Local deploy of llm-tui changes

**Files:**
- (deploy only)

- [ ] **Step 1: Bump version**

In `plugins/llm-tui/package.json`, bump `"version"` from `"0.1.0"` to `"0.2.0"`.

- [ ] **Step 2: Sync and rebuild the install dir**

Run:

```bash
mkdir -p ~/.kaizen/marketplaces/official/plugins/llm-tui@0.2.0
cp -R plugins/llm-tui/. ~/.kaizen/marketplaces/official/plugins/llm-tui@0.2.0/
(cd ~/.kaizen/marketplaces/official/plugins/llm-tui@0.2.0 \
  && bun build --target=bun --outfile=dist/index.js index.tsx)
```

Expected: build completes without error and writes `dist/index.js`.

- [ ] **Step 3: Update the harness manifest to reference the new version**

In `harnesses/openai-compatible.json`, change `"official/llm-tui@0.1.0"` to `"official/llm-tui@0.2.0"`.

- [ ] **Step 4: Commit**

```bash
git add plugins/llm-tui/package.json harnesses/openai-compatible.json
git commit -m "chore(llm-tui): bump to 0.2.0 and update harness manifest"
```

---

## Phase C: Build the new `llm-codemode` plugin

The new plugin lives at `plugins/llm-codemode/`. Most files are copies of the equivalents in `plugins/llm-codemode-dispatch/` with targeted edits. To avoid prose-only "copy this file" steps, the tasks below state exactly which files to copy, then call out the diffs explicitly for the modified ones.

### Task C1: Scaffold the plugin

**Files:**
- Create: `plugins/llm-codemode/package.json`
- Create: `plugins/llm-codemode/tsconfig.json`
- Create: `plugins/llm-codemode/public.d.ts`
- Create: `plugins/llm-codemode/test/` (empty dir)

- [ ] **Step 1: Create `package.json`**

Create `plugins/llm-codemode/package.json`:

```json
{
  "name": "llm-codemode",
  "version": "0.1.0",
  "description": "Registers execute_typescript as a single tool that runs LLM-emitted TypeScript in a Bun Worker sandbox with the kaizen.tools.* typed API.",
  "type": "module",
  "exports": {
    ".": "./index.ts"
  },
  "keywords": [
    "kaizen-plugin"
  ],
  "dependencies": {
    "json-schema-to-typescript": "^15.0.3",
    "llm-tools-registry": "workspace:*"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "@types/json-schema": "^7.0.15",
    "typescript": "^5.4.0"
  }
}
```

Note: this drops `llm-system-prompt`, `mdast-util-from-markdown`, `mdast-util-to-string` from dependencies — the new plugin does not extract code from prose or inject system-prompt sections.

- [ ] **Step 2: Create `tsconfig.json`**

Create `plugins/llm-codemode/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "lib": ["ESNext", "WebWorker"]
  }
}
```

- [ ] **Step 3: Create `public.d.ts`**

Create `plugins/llm-codemode/public.d.ts`:

```typescript
export interface CodeModeConfig {
  timeoutMs: number;
  maxStdoutBytes: number;
  maxReturnBytes: number;
  maxBlocksPerResponse: number;
}
```

- [ ] **Step 4: Create empty `test/` directory**

Run:

```bash
mkdir -p plugins/llm-codemode/test
touch plugins/llm-codemode/test/.gitkeep
```

- [ ] **Step 5: Commit the scaffold**

```bash
git add plugins/llm-codemode/
git commit -m "feat(llm-codemode): scaffold new plugin (no implementation yet)"
```

### Task C2: Copy unchanged files

**Files:**
- Create: `plugins/llm-codemode/wrapper.ts`
- Create: `plugins/llm-codemode/sandbox-entry.ts`
- Create: `plugins/llm-codemode/rpc-types.ts`
- Create: `plugins/llm-codemode/dts-render.ts`
- Create: `plugins/llm-codemode/assembler.ts`

- [ ] **Step 1: Copy unchanged source files**

Run:

```bash
cp plugins/llm-codemode-dispatch/wrapper.ts plugins/llm-codemode/wrapper.ts
cp plugins/llm-codemode-dispatch/sandbox-entry.ts plugins/llm-codemode/sandbox-entry.ts
cp plugins/llm-codemode-dispatch/rpc-types.ts plugins/llm-codemode/rpc-types.ts
cp plugins/llm-codemode-dispatch/dts-render.ts plugins/llm-codemode/dts-render.ts
cp plugins/llm-codemode-dispatch/assembler.ts plugins/llm-codemode/assembler.ts
```

- [ ] **Step 2: Copy their unit tests**

Run:

```bash
cp plugins/llm-codemode-dispatch/test/wrapper.test.ts plugins/llm-codemode/test/wrapper.test.ts 2>/dev/null || true
cp plugins/llm-codemode-dispatch/test/dts-render.test.ts plugins/llm-codemode/test/dts-render.test.ts
cp plugins/llm-codemode-dispatch/test/assembler.test.ts plugins/llm-codemode/test/assembler.test.ts
```

(If `wrapper.test.ts` does not exist in the source plugin, the test exists only via the e2e suite — that's fine, skip the missing one.)

- [ ] **Step 3: Run the tests in isolation**

Run:

```bash
cd plugins/llm-codemode && bun test
```

Expected: PASS for all copied tests. If any test fails because of cross-package imports that resolve to the old plugin, those imports must be self-contained (no test should depend on `llm-codemode-dispatch`'s other files). If the tests reference `../wrapper.ts` etc. only, they pass.

- [ ] **Step 4: Commit**

```bash
git add plugins/llm-codemode/wrapper.ts plugins/llm-codemode/sandbox-entry.ts \
        plugins/llm-codemode/rpc-types.ts plugins/llm-codemode/dts-render.ts \
        plugins/llm-codemode/assembler.ts plugins/llm-codemode/test/
git commit -m "feat(llm-codemode): copy unchanged sandbox/wrapper/dts modules"
```

### Task C3: Adapt `config.ts` (path rename)

**Files:**
- Create: `plugins/llm-codemode/config.ts`

- [ ] **Step 1: Copy then edit**

Run:

```bash
cp plugins/llm-codemode-dispatch/config.ts plugins/llm-codemode/config.ts
```

- [ ] **Step 2: Rename the config path**

In `plugins/llm-codemode/config.ts`:

Replace every occurrence of `~/.kaizen/plugins/llm-codemode-dispatch/config.json` with `~/.kaizen/plugins/llm-codemode/config.json`.
Replace every occurrence of `KAIZEN_LLM_CODEMODE_DISPATCH_CONFIG` (or the actual existing env var name — read the file to confirm; the original may differ) with `KAIZEN_LLM_CODEMODE_CONFIG`.

Run:

```bash
grep -n "llm-codemode-dispatch\|KAIZEN_LLM_CODEMODE" plugins/llm-codemode/config.ts
```

Expected: no remaining `llm-codemode-dispatch` strings; the env var (if present) reads `KAIZEN_LLM_CODEMODE_CONFIG`.

- [ ] **Step 3: Copy and adapt the config test**

```bash
cp plugins/llm-codemode-dispatch/test/config.test.ts plugins/llm-codemode/test/config.test.ts
```

Apply the same string replacements in the test file.

- [ ] **Step 4: Run the config test**

```bash
cd plugins/llm-codemode && bun test test/config.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-codemode/config.ts plugins/llm-codemode/test/config.test.ts
git commit -m "feat(llm-codemode): adapt config to new plugin name and path"
```

### Task C4: Adapt `serialize.ts` (drop `[code execution result]` envelope)

**Files:**
- Create: `plugins/llm-codemode/serialize.ts`
- Create: `plugins/llm-codemode/test/serialize.test.ts`

- [ ] **Step 1: Write the test for the new format**

Create `plugins/llm-codemode/test/serialize.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { formatToolResult } from "../serialize.ts";

test("ok result has no [code execution result] prefix", () => {
  const out = formatToolResult(
    { ok: true, returnValue: 42, stdout: "" },
    { maxStdoutBytes: 1024, maxReturnBytes: 1024, maxBlocksPerResponse: 8 },
  );
  expect(out).not.toContain("[code execution result]");
  expect(out).toContain("exit: ok");
  expect(out).toContain("returned: 42");
});

test("err result encodes exit/error/stdout cleanly", () => {
  const out = formatToolResult(
    { ok: false, errorName: "TypeError", errorMessage: "boom", stdout: "before\n" },
    { maxStdoutBytes: 1024, maxReturnBytes: 1024, maxBlocksPerResponse: 8 },
  );
  expect(out).not.toContain("[code execution result]");
  expect(out).toContain("exit: error");
  expect(out).toContain("error: TypeError: boom");
  expect(out).toContain("stdout:");
  expect(out).toContain("before");
});

test("stdout truncation respects maxStdoutBytes", () => {
  const big = "x".repeat(10_000);
  const out = formatToolResult(
    { ok: true, returnValue: null, stdout: big },
    { maxStdoutBytes: 64, maxReturnBytes: 1024, maxBlocksPerResponse: 8 },
  );
  expect(out).toContain("[truncated");
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd plugins/llm-codemode && bun test test/serialize.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the new `serialize.ts`**

Create `plugins/llm-codemode/serialize.ts`:

```typescript
export function stringifyReturn(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "bigint") return JSON.stringify(`${value.toString()}n`);
  if (typeof value === "function") return JSON.stringify("[Function]");
  if (typeof value === "symbol") return JSON.stringify("[Symbol]");
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_k, v) => {
    if (typeof v === "bigint") return `${v.toString()}n`;
    if (typeof v === "function") return "[Function]";
    if (typeof v === "symbol") return "[Symbol]";
    if (typeof v === "object" && v !== null) {
      if (seen.has(v)) return "[Circular]";
      seen.add(v);
    }
    return v;
  });
}

export function truncate(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.byteLength <= maxBytes) return s;
  const head = buf.subarray(0, maxBytes).toString("utf8");
  const more = buf.byteLength - maxBytes;
  return `${head}\n...[truncated, ${more} more bytes]`;
}

export interface FormatInputOk { ok: true; returnValue: unknown; stdout: string; ignoredBlocks?: number; }
export interface FormatInputErr { ok: false; errorName: string; errorMessage: string; stdout: string; ignoredBlocks?: number; }
export type FormatInput = FormatInputOk | FormatInputErr;

/**
 * Produces the string content for a `tool` role message after running the
 * sandbox. Unlike the old codemode-dispatch `formatResultMessage`, this output
 * does NOT carry the `[code execution result]` prefix — the role label `tool`
 * already signals to the LLM that this is runtime output.
 */
export function formatToolResult(
  input: FormatInput,
  caps: { maxStdoutBytes: number; maxReturnBytes: number; maxBlocksPerResponse?: number },
): string {
  const stdout = truncate(input.stdout ?? "", caps.maxStdoutBytes);
  const lines: string[] = [];
  if (input.ok) {
    lines.push("exit: ok");
    const ret = truncate(stringifyReturn(input.returnValue), caps.maxReturnBytes);
    lines.push(`returned: ${ret}`);
  } else {
    lines.push("exit: error");
    lines.push(`error: ${input.errorName}: ${input.errorMessage}`);
  }
  lines.push("stdout:");
  lines.push(stdout);
  return lines.join("\n");
}
```

- [ ] **Step 4: Run the test**

```bash
cd plugins/llm-codemode && bun test test/serialize.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-codemode/serialize.ts plugins/llm-codemode/test/serialize.test.ts
git commit -m "feat(llm-codemode): formatToolResult drops [code execution result] envelope"
```

### Task C5: Adapt `sandbox-host.ts` to emit `tool:progress`

**Files:**
- Create: `plugins/llm-codemode/sandbox-host.ts`

- [ ] **Step 1: Copy then edit**

Run:

```bash
cp plugins/llm-codemode-dispatch/sandbox-host.ts plugins/llm-codemode/sandbox-host.ts
```

- [ ] **Step 2: Add a `outerCallId` parameter**

In `plugins/llm-codemode/sandbox-host.ts`, find the `runInSandbox` signature:

```typescript
export async function runInSandbox(
  userCode: string,
  registry: SandboxRegistry,
  signal: AbortSignal,
  config: CodeModeConfig,
  emit?: (event: string, payload: unknown) => Promise<void>,
  turnId?: string,
  sessionId?: string,
): Promise<SandboxRunResult> {
```

Replace it with:

```typescript
export async function runInSandbox(
  userCode: string,
  registry: SandboxRegistry,
  signal: AbortSignal,
  config: CodeModeConfig,
  emit?: (event: string, payload: unknown) => Promise<void>,
  turnId?: string,
  sessionId?: string,
  outerCallId?: string,
): Promise<SandboxRunResult> {
```

- [ ] **Step 3: Emit `tool:progress` on stdout messages from the worker**

In the same file, find the stdout-handling branch in `worker.onmessage`:

```typescript
if (msg.type === "stdout") {
  if (stdoutBytes >= config.maxStdoutBytes) return;
  const remaining = config.maxStdoutBytes - stdoutBytes;
  const slice = Buffer.byteLength(msg.chunk, "utf8") <= remaining ? msg.chunk : msg.chunk.slice(0, remaining);
  stdout += slice;
  stdoutBytes += Buffer.byteLength(slice, "utf8");
  return;
}
```

Replace it with:

```typescript
if (msg.type === "stdout") {
  if (stdoutBytes >= config.maxStdoutBytes) return;
  const remaining = config.maxStdoutBytes - stdoutBytes;
  const slice = Buffer.byteLength(msg.chunk, "utf8") <= remaining ? msg.chunk : msg.chunk.slice(0, remaining);
  stdout += slice;
  stdoutBytes += Buffer.byteLength(slice, "utf8");
  if (outerCallId && emit) {
    void emit("tool:progress", { callId: outerCallId, delta: slice, turnId, sessionId });
  }
  return;
}
```

- [ ] **Step 4: Drop the codemode:* emits (they're internal sandbox telemetry now)**

Search the file for `codemode:` and remove or fold any remaining `codemode:before-execute` / `codemode:result` / `codemode:error` emits if they exist in this file. (They likely live only in `handle-response.ts`, which we are not copying — but check.) If `sandbox-host.ts` itself does not emit any `codemode:*` events, no edit is needed here. Confirm with:

```bash
grep -n "codemode:" plugins/llm-codemode/sandbox-host.ts
```

Expected: no matches, or only matches inside comments/dead code that you can prune.

- [ ] **Step 5: Copy and adapt the host tests**

Run:

```bash
cp plugins/llm-codemode-dispatch/test/sandbox-host-grouped.test.ts plugins/llm-codemode/test/sandbox-host-grouped.test.ts
cp plugins/llm-codemode-dispatch/test/e2e-sandbox.test.ts plugins/llm-codemode/test/e2e-sandbox.test.ts
```

In each copied test, update import paths from `../*` to `../*` (they should already be relative). Where any test references `[code execution result]` from the old result format, update the assertion (most tests will assert on `runInSandbox`'s return value directly, not on the formatted string — the formatter test is separate).

- [ ] **Step 6: Run sandbox host tests**

```bash
cd plugins/llm-codemode && bun test test/sandbox-host-grouped.test.ts test/e2e-sandbox.test.ts
```

Expected: PASS.

- [ ] **Step 7: Add a focused test for `tool:progress` emission**

Append to `plugins/llm-codemode/test/sandbox-host-grouped.test.ts`:

```typescript
test("emits tool:progress with stdout deltas when outerCallId is provided", async () => {
  const events: Array<{ name: string; payload: any }> = [];
  const emit = async (name: string, payload: unknown) => { events.push({ name, payload: payload as any }); };
  const registry = makeFakeRegistry(); // existing helper in this test file
  const config = { timeoutMs: 5000, maxStdoutBytes: 65536, maxReturnBytes: 65536, maxBlocksPerResponse: 8 };
  const ac = new AbortController();
  await runInSandbox(
    'console.log("hello"); 1 + 1;',
    registry,
    ac.signal,
    config,
    emit,
    "turn-1",
    "sess-1",
    "outer-call-1",
  );
  const progress = events.filter((e) => e.name === "tool:progress");
  expect(progress.length).toBeGreaterThanOrEqual(1);
  expect(progress[0]?.payload.callId).toBe("outer-call-1");
  expect(progress.map((e) => e.payload.delta).join("")).toContain("hello");
});
```

(Reuse whatever `makeFakeRegistry()` helper already exists in the file. If it's named differently, use the existing name.)

- [ ] **Step 8: Run that test**

```bash
cd plugins/llm-codemode && bun test test/sandbox-host-grouped.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add plugins/llm-codemode/sandbox-host.ts plugins/llm-codemode/test/
git commit -m "feat(llm-codemode): sandbox-host emits tool:progress for stdout deltas"
```

### Task C6: Implement `index.ts` — register `execute_typescript`

**Files:**
- Create: `plugins/llm-codemode/index.ts`
- Create: `plugins/llm-codemode/test/index.test.ts`

- [ ] **Step 1: Write the registration test**

Create `plugins/llm-codemode/test/index.test.ts`:

```typescript
import { test, expect } from "bun:test";
import plugin from "../index.ts";

function makeFakeCtx() {
  const services = new Map<string, unknown>();
  const consumed = new Set<string>();
  const log: string[] = [];
  const events = new Map<string, (p: unknown) => Promise<void>>();
  const registeredTools: Array<{ schema: any; handler: any }> = [];
  const fakeRegistry = {
    register(schema: any, handler: any) { registeredTools.push({ schema, handler }); return () => {}; },
    list() { return [{ name: "read_file", description: "", parameters: { type: "object" } }]; },
    listRegistrations() { return [{ schema: { name: "read_file", description: "", parameters: { type: "object" } }, source: { kind: "local" } }]; },
    invoke: async () => undefined,
  };
  services.set("tools:registry", fakeRegistry);
  return {
    config: {} as any,
    log: (m: string) => log.push(m),
    consumeService: (n: string) => { consumed.add(n); },
    defineService: () => {},
    provideService: () => {},
    on: (name: string, h: any) => { events.set(name, h); },
    emit: async () => {},
    useService: (n: string) => services.get(n),
    defineEvent: () => {},
    registeredTools,
    consumed,
  };
}

test("registers exactly one tool named execute_typescript", async () => {
  const ctx = makeFakeCtx();
  await (plugin as any).setup(ctx);
  expect(ctx.registeredTools.length).toBe(1);
  expect(ctx.registeredTools[0]?.schema.name).toBe("execute_typescript");
});

test("execute_typescript schema has a single 'code' string parameter", async () => {
  const ctx = makeFakeCtx();
  await (plugin as any).setup(ctx);
  const schema = ctx.registeredTools[0]!.schema;
  expect(schema.parameters?.type).toBe("object");
  expect(schema.parameters?.properties?.code?.type).toBe("string");
  expect(schema.parameters?.required).toContain("code");
});

test("description embeds the rendered kaizen.tools .d.ts surface", async () => {
  const ctx = makeFakeCtx();
  await (plugin as any).setup(ctx);
  const desc = ctx.registeredTools[0]!.schema.description as string;
  expect(desc).toContain("kaizen.tools");
});

test("does NOT provide tool-dispatch:strategy", async () => {
  const ctx = makeFakeCtx();
  await (plugin as any).setup(ctx);
  expect(ctx.consumed.has("tool-dispatch:strategy")).toBe(false);
});

test("consumes tools:registry only", async () => {
  const ctx = makeFakeCtx();
  await (plugin as any).setup(ctx);
  expect(ctx.consumed.has("tools:registry")).toBe(true);
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd plugins/llm-codemode && bun test test/index.test.ts
```

Expected: FAIL — `../index.ts` not found.

- [ ] **Step 3: Implement `index.ts`**

Create `plugins/llm-codemode/index.ts`:

```typescript
import type { KaizenPlugin } from "kaizen/types";
import type { ToolHandler, ToolSchema, ToolsRegistryService, ToolExecutionContext } from "llm-events/public";
import { loadConfig, realDeps } from "./config.ts";
import { renderDts } from "./dts-render.ts";
import { runInSandbox, type SandboxRunResult } from "./sandbox-host.ts";
import { formatToolResult } from "./serialize.ts";

const TOOL_NAME = "execute_typescript";

const PARAMETERS = {
  type: "object" as const,
  properties: {
    code: {
      type: "string" as const,
      description: "TypeScript source. Top-level await is allowed. Trailing expressions are returned. Use the kaizen.* APIs documented above to call tools, MCP servers, agents, skills, and memory.",
    },
  },
  required: ["code"],
  additionalProperties: false,
};

const PREAMBLE = `Executes TypeScript in a sandboxed Bun Worker. Top-level await is allowed; the trailing expression's value is returned. Console output is captured as stdout. The sandbox exposes a typed \`kaizen\` global with the runtime's tools, MCP servers, agents, skills, and memory grouped by source. Prefer composing many operations in one code block over many sequential tool calls.

Available API surface:`;

const plugin: KaizenPlugin = {
  name: "llm-codemode",
  apiVersion: "3.0.0",
  permissions: { tier: "unscoped" },
  services: {
    consumes: ["tools:registry"],
  },

  async setup(ctx) {
    ctx.consumeService("tools:registry");

    const config = await loadConfig(realDeps((m) => ctx.log(m)));

    const toolsRegistry = ctx.useService?.("tools:registry") as
      | (ToolsRegistryService & { listRegistrations?: () => Array<{ schema: ToolSchema; source: any }> })
      | undefined;
    if (!toolsRegistry) {
      ctx.log("llm-codemode: tools:registry not available; nothing to register");
      return;
    }

    // Render the kaizen.tools surface from currently-registered tools, EXCLUDING
    // ourselves. (Including execute_typescript in its own description would be
    // recursive and useless.)
    const otherTools = toolsRegistry.list().filter((t) => t.name !== TOOL_NAME);
    const dts = await renderDts(otherTools);
    const description = `${PREAMBLE}\n${dts}`;

    const schema: ToolSchema = {
      name: TOOL_NAME,
      description,
      parameters: PARAMETERS,
    };

    const handler: ToolHandler = async (args, exec: ToolExecutionContext) => {
      const code = (args as any)?.code;
      if (typeof code !== "string") {
        throw new Error(`execute_typescript: 'code' must be a string`);
      }
      const result: SandboxRunResult = await runInSandbox(
        code,
        toolsRegistry as any,
        exec.signal,
        config,
        async (name, payload) => { await ctx.emit(name, payload); },
        exec.turnId,
        exec.sessionId,
        exec.callId,
      );
      return formatToolResult(result, {
        maxStdoutBytes: config.maxStdoutBytes,
        maxReturnBytes: config.maxReturnBytes,
        maxBlocksPerResponse: config.maxBlocksPerResponse,
      });
    };

    toolsRegistry.register(schema, handler);
  },
};

export default plugin;
```

- [ ] **Step 4: Run the index test**

```bash
cd plugins/llm-codemode && bun test test/index.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run all plugin tests**

```bash
cd plugins/llm-codemode && bun test
```

Expected: PASS for all tests.

- [ ] **Step 6: Commit**

```bash
git add plugins/llm-codemode/index.ts plugins/llm-codemode/test/index.test.ts
git commit -m "feat(llm-codemode): register execute_typescript via tools:registry"
```

### Task C7: TUI renderer for `execute_typescript`

**Files:**
- Create: `plugins/llm-codemode/tui-renderer.tsx`
- Create: `plugins/llm-codemode/test/tui-renderer.test.tsx`

- [ ] **Step 1: Write the renderer test**

Create `plugins/llm-codemode/test/tui-renderer.test.tsx`:

```typescript
import React from "react";
import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { codemodeRenderer } from "../tui-renderer.tsx";

test("collapsedSummary reports line count", () => {
  expect(codemodeRenderer.collapsedSummary({ code: "a\nb\nc" })).toContain("3 lines");
});

test("collapsedSummary handles single line", () => {
  expect(codemodeRenderer.collapsedSummary({ code: "1+1" })).toContain("1 line");
});

test("expandedView shows code, stdout pane, and result", () => {
  const node = codemodeRenderer.expandedView(
    { code: "console.log('hi'); 42" },
    "exit: ok\nreturned: 42\nstdout:\nhi\n",
    "done",
    "hi\n",
  );
  const { lastFrame } = render(<>{node}</>);
  const out = lastFrame() ?? "";
  expect(out).toContain("console.log");
  expect(out).toContain("hi");
  expect(out).toContain("42");
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd plugins/llm-codemode && bun test test/tui-renderer.test.tsx
```

Expected: FAIL.

- [ ] **Step 3: Implement the renderer**

Create `plugins/llm-codemode/tui-renderer.tsx`:

```typescript
import React from "react";
import { Box, Text } from "ink";
import type { TuiToolRenderer } from "llm-tui/public";

function lineCount(code: string): number {
  if (!code) return 0;
  return code.split("\n").length;
}

export const codemodeRenderer: TuiToolRenderer = {
  toolName: "execute_typescript",
  collapsedSummary(args) {
    const n = lineCount(((args as any)?.code as string) ?? "");
    return `exec ${n} line${n === 1 ? "" : "s"}`;
  },
  expandedView(args, result, status, stdout) {
    const code = ((args as any)?.code as string) ?? "";
    return (
      <Box flexDirection="column">
        <Text dimColor>code:</Text>
        {code.split("\n").map((l, i) => (
          <Text key={`c${i}`}>{`  ${l}`}</Text>
        ))}
        {stdout && (
          <>
            <Text dimColor>stdout:</Text>
            {stdout.split("\n").map((l, i) => (
              <Text key={`s${i}`} dimColor>{`  ${l}`}</Text>
            ))}
          </>
        )}
        {result && (
          <>
            <Text dimColor>result:</Text>
            {result.split("\n").map((l, i) => (
              <Text key={`r${i}`}>{`  ${l}`}</Text>
            ))}
          </>
        )}
      </Box>
    );
  },
};
```

- [ ] **Step 4: Register the renderer in `index.ts`**

In `plugins/llm-codemode/index.ts`, in the `services.consumes` array, add `"llm-tui:tool-renderer"` so the line reads:

```typescript
services: {
  consumes: ["tools:registry", "llm-tui:tool-renderer"],
},
```

In `setup()`, add a `consumeService` and registration. After the `toolsRegistry.register(schema, handler);` line, add:

```typescript
ctx.consumeService("llm-tui:tool-renderer");
const tuiRenderers = ctx.useService?.("llm-tui:tool-renderer") as
  | { register: (r: any) => () => void }
  | undefined;
if (tuiRenderers) {
  const { codemodeRenderer } = await import("./tui-renderer.tsx");
  tuiRenderers.register(codemodeRenderer);
}
```

(The dynamic import keeps the React/Ink dependency lazy — non-TUI environments don't need to load the renderer file.)

- [ ] **Step 5: Run plugin tests**

```bash
cd plugins/llm-codemode && bun test
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add plugins/llm-codemode/tui-renderer.tsx plugins/llm-codemode/index.ts plugins/llm-codemode/test/tui-renderer.test.tsx
git commit -m "feat(llm-codemode): ship TUI renderer for execute_typescript"
```

### Task C8: Plugin docs (CLAUDE.md, README.md)

**Files:**
- Create: `plugins/llm-codemode/CLAUDE.md`
- Create: `plugins/llm-codemode/README.md`

- [ ] **Step 1: Create `CLAUDE.md`**

Create `plugins/llm-codemode/CLAUDE.md` with the agent-facing module map. Use this content:

```markdown
# Working in `llm-codemode`

Notes for agents editing this plugin. See `README.md` for the user-facing contract.

## What this plugin is (and is not)

This plugin registers exactly one tool, `execute_typescript`, with `tools:registry`. It does NOT provide `tool-dispatch:strategy`. The dispatch strategy is `llm-native-dispatch`; this plugin is just a tool implementer that happens to spawn a Bun Worker sandbox in its handler.

## Module map

```
index.ts            Plugin lifecycle. Loads config, renders the kaizen.tools .d.ts
                    from the live registry, registers `execute_typescript` with the
                    registry, registers a TUI renderer if `llm-tui:tool-renderer`
                    is available. The only file that touches `ctx`.
config.ts           loadConfig(deps) → CodeModeConfig. Reads
                    ~/.kaizen/plugins/llm-codemode/config.json (or
                    KAIZEN_LLM_CODEMODE_CONFIG override).
sandbox-host.ts     runInSandbox(...). Spawns Worker, owns message loop, enforces
                    timeout, aggregates stdout, bridges tool RPC. Emits
                    `tool:progress` with stdout deltas when an outerCallId is
                    provided (i.e. when invoked from the tool handler).
sandbox-entry.ts    Worker entrypoint. Builds the `kaizen` proxy and runs user code.
wrapper.ts          wrapCode(userCode) → { wrapped, transpileError? }.
dts-render.ts       renderDts(tools) → string. Used to build the tool description.
serialize.ts        formatToolResult(...) → string. Produces the `tool` role
                    message content. NOTE: no `[code execution result]` prefix —
                    the role label is the signal.
assembler.ts        normalizeServerName helper used by the host to build the
                    grouped kaizen global.
rpc-types.ts        Host↔worker message shapes.
tui-renderer.tsx    `codemodeRenderer: TuiToolRenderer`. Exported for the TUI to
                    register via `llm-tui:tool-renderer`.
```

## Invariants

- **Single tool surface.** This plugin registers exactly one tool. Adding more should be a separate plugin.
- **Self-exclusion in the description.** The rendered .d.ts must NOT include `execute_typescript` itself; it lists every OTHER registered tool. Recursion is meaningless here.
- **`tool:progress` emission requires `outerCallId`.** The handler in `index.ts` passes `exec.callId` to `runInSandbox`. Without that, no progress emits.
- **No system-prompt mutation.** Unlike `llm-codemode-dispatch`, this plugin does not consume `prompt:system`. The API surface lives in the tool description.
- **No code-from-prose extraction.** The LLM emits `tool_calls` with `code` as the argument. There is no fence parsing.

## Local deploy

```bash
cp -R plugins/llm-codemode/. ~/.kaizen/marketplaces/official/plugins/llm-codemode@0.1.0/
(cd ~/.kaizen/marketplaces/official/plugins/llm-codemode@0.1.0 \
  && bun build --target=bun --outfile=dist/index.js index.ts)
```

`sandbox-entry.ts` is loaded by URL at runtime — it must remain present alongside the bundle. Do not bundle it into `dist/index.js`.
```

- [ ] **Step 2: Create `README.md`**

Create `plugins/llm-codemode/README.md`:

```markdown
# llm-codemode

Registers `execute_typescript` as a single tool with `tools:registry`. The LLM invokes it through standard OpenAI tool-calling; the handler runs the code in a Bun Worker sandbox and returns the structured result as the tool message content.

## What it provides

- One tool registration: `execute_typescript({ code: string })`.
- A TUI renderer (registered with `llm-tui:tool-renderer` if available) that displays the code, stdout, and result inline.
- A `tool:progress` event emitted from the sandbox host while user code writes to stdout.

## What it doesn't do

- Does not provide `tool-dispatch:strategy`. The harness's dispatch strategy (`llm-native-dispatch`) consumes this tool like any other.
- Does not modify the system prompt. The `kaizen.*` API surface is taught via the tool's `description` field.
- Does not parse code out of assistant prose. The LLM emits `tool_calls` with the code as the `code` argument.

## Configuration

`~/.kaizen/plugins/llm-codemode/config.json` (override via `KAIZEN_LLM_CODEMODE_CONFIG`):

| Key | Default | Description |
| --- | --- | --- |
| `timeoutMs` | 30000 | Sandbox execution timeout. |
| `maxStdoutBytes` | 65536 | Cap on captured stdout. |
| `maxReturnBytes` | 65536 | Cap on returned-value serialization length. |
| `maxBlocksPerResponse` | 8 | Reserved (the new envelope only handles one block per call). |
```

- [ ] **Step 3: Commit**

```bash
git add plugins/llm-codemode/CLAUDE.md plugins/llm-codemode/README.md
git commit -m "docs(llm-codemode): plugin CLAUDE.md and README.md"
```

### Task C9: Local deploy of new plugin

- [ ] **Step 1: Copy and bundle**

Run:

```bash
mkdir -p ~/.kaizen/marketplaces/official/plugins/llm-codemode@0.1.0
cp -R plugins/llm-codemode/. ~/.kaizen/marketplaces/official/plugins/llm-codemode@0.1.0/
(cd ~/.kaizen/marketplaces/official/plugins/llm-codemode@0.1.0 \
  && bun build --target=bun --outfile=dist/index.js index.ts)
```

Expected: build completes without error and writes `dist/index.js`.

- [ ] **Step 2: Verify the plugin loads**

(Optional smoke load — only do if a local kaizen CLI exists in the user's environment.)

```bash
which kaizen >/dev/null 2>&1 && kaizen plugin list 2>&1 | grep llm-codemode || echo "skipping load check"
```

- [ ] **Step 3: No commit needed (deploy artifacts live outside the repo)**

---

## Phase D: Smoke test against target models

This phase has no code changes. It validates that the new plugin works against the local LLMs you target.

### Task D1: Manual smoke test

**Files:** none

- [ ] **Step 1: Add `llm-native-dispatch` to the harness manifest temporarily, alongside existing entries**

Edit `harnesses/openai-compatible.json` and replace the line:

```
"official/llm-codemode-dispatch@0.2.0",
```

with:

```
"official/llm-native-dispatch@0.2.0",
"official/llm-codemode@0.1.0",
```

Note: this is the same edit that ships in Phase E, just done early so smoke testing happens against the real shape. If smoke testing reveals problems, you can revert this single hunk.

- [ ] **Step 2: Bundle `llm-native-dispatch` if not already deployed**

Run:

```bash
ls ~/.kaizen/marketplaces/official/plugins/llm-native-dispatch@0.2.0/dist/index.js >/dev/null 2>&1 || (
  mkdir -p ~/.kaizen/marketplaces/official/plugins/llm-native-dispatch@0.2.0
  cp -R plugins/llm-native-dispatch/. ~/.kaizen/marketplaces/official/plugins/llm-native-dispatch@0.2.0/
  cd ~/.kaizen/marketplaces/official/plugins/llm-native-dispatch@0.2.0 \
    && bun build --target=bun --outfile=dist/index.js index.ts
)
```

- [ ] **Step 3: Run the harness against each target model and verify**

For each target model the user actually uses (LM Studio, Ollama, etc.), start a session and verify the four checks below. Record outcomes in this checklist.

- [ ] **Check 3a: The model emits a valid `tool_calls` array referencing `execute_typescript`.** Prompt: "Use the execute_typescript tool to compute 2+2 and print the result." Verify in the session log that the response contained a `tool_calls` array (not a fenced code block in `content`).

- [ ] **Check 3b: The `code` argument round-trips intact.** Prompt: "Execute this exact code: `console.log(\`hello ${1+1} world\`); return [1, 2, 3];`" — verify the sandbox stdout contains `hello 2 world` and the tool message content reports `returned: [1,2,3]`.

- [ ] **Check 3c: Multi-step turns work.** Prompt: "Read the file /etc/hostname using execute_typescript, then on the next turn, summarize what you read." Verify two consecutive turns each containing `tool_calls` followed by a final assistant message.

- [ ] **Check 3d: Cancellation leaves the conversation well-formed.** Start a long-running call (e.g. `await new Promise(r => setTimeout(r, 60000))`), hit Ctrl+C mid-execution, and on the next turn verify the LLM is sent a synthetic `tool` message for that `tool_call_id`. Inspect with whatever session log/replay mechanism is available (the `llm-session-manager` plugin's transcript files).

- [ ] **Step 4: Document outcomes**

If any check fails on a specific model, record the failure and the model name in `docs/TODO.md` under a new "Smoke test results" section. If all checks pass, leave a one-line note in the same place.

- [ ] **Step 5: Commit the harness manifest change (this is the cutover from Phase E step 1)**

```bash
git add harnesses/openai-compatible.json
git commit -m "feat(harness): swap to llm-native-dispatch + llm-codemode"
```

If smoke tests revealed any model that does NOT support tool-calling and is part of the supported set, stop here and surface the finding to the user. The pivot is conditional on tool-calling working on every target model.

---

## Phase E: Cutover

### Task E1: Retire `llm-codemode-dispatch` from the source tree

**Files:**
- Delete: `plugins/llm-codemode-dispatch/`
- Modify: `~/.kaizen/marketplaces/official/plugins/` (remove install dir)

- [ ] **Step 1: Delete the source plugin**

Run:

```bash
git rm -r plugins/llm-codemode-dispatch
```

- [ ] **Step 2: Remove the install dir**

Run:

```bash
rm -rf ~/.kaizen/marketplaces/official/plugins/llm-codemode-dispatch@0.2.0
```

- [ ] **Step 3: Confirm no remaining import paths reference the old plugin**

Run:

```bash
grep -rn "llm-codemode-dispatch" plugins/ harnesses/ docs/ 2>/dev/null
```

Expected output: only the commit-history references in `docs/superpowers/archive/specs/` (the old design spec) and the new spec's narrative paragraphs that mention the retirement. No live import paths.

- [ ] **Step 4: Run all plugin tests once**

Run:

```bash
for d in plugins/*/; do (cd "$d" && bun test 2>&1 | tail -5); done
```

Expected: PASS in every plugin. If any plugin imports from `llm-codemode-dispatch`, fix the import (it likely needs to point at `llm-codemode` or be removed entirely).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: retire llm-codemode-dispatch (superseded by llm-codemode)"
```

### Task E2: Update `llm-events/public.d.ts` comment header

**Files:**
- Modify: `plugins/llm-events/public.d.ts`

- [ ] **Step 1: Edit the comment**

Replace:

```typescript
// ---------- tool-dispatch:strategy (owned by `llm-native-dispatch`, `llm-codemode-dispatch`) ----------
```

with:

```typescript
// ---------- tool-dispatch:strategy (owned by `llm-native-dispatch`) ----------
```

- [ ] **Step 2: Run llm-events tests**

```bash
cd plugins/llm-events && bun test
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add plugins/llm-events/public.d.ts
git commit -m "docs(llm-events): drop retired co-owner from tool-dispatch comment header"
```

### Task E3: Mark the old design spec as superseded

**Files:**
- Modify: `docs/superpowers/archive/specs/2026-04-30-llm-codemode-dispatch-design.md`

- [ ] **Step 1: Add a superseded header line at the top**

Open `docs/superpowers/archive/specs/2026-04-30-llm-codemode-dispatch-design.md`. Below the H1 title (the first `#` line), insert this single line:

```markdown
> **Superseded by:** [`2026-05-07-llm-codemode-tool-pivot-design.md`](2026-05-07-llm-codemode-tool-pivot-design.md). This document describes the retired `llm-codemode-dispatch` plugin.
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/archive/specs/2026-04-30-llm-codemode-dispatch-design.md
git commit -m "docs: mark llm-codemode-dispatch design as superseded"
```

### Task E4: Update the architecture memory

**Files:**
- Modify: `~/.claude/projects/-Users-chancock-git-kaizen-official-plugins/memory/openai_compatible_harness_arch.md`

- [ ] **Step 1: Read the current memory**

```bash
cat ~/.claude/projects/-Users-chancock-git-kaizen-official-plugins/memory/openai_compatible_harness_arch.md
```

- [ ] **Step 2: Replace the load-bearing decision**

Find the paragraph beginning **`Code-mode dispatch is the default tool-dispatch strategy.`** Replace the entire paragraph with:

```markdown
**Codemode is a tool, not a dispatch strategy.** `llm-codemode` registers a single `execute_typescript` tool with `tools:registry`; the harness uses `llm-native-dispatch` as its sole `tool-dispatch:strategy`, which invokes `execute_typescript` like any other tool. The kaizen.tools `.d.ts` API surface is taught via the tool's `description` field, not via system-prompt injection. **Why:** local LLMs trained on tool-calling reliably emit single-trivial-schema `tool_calls` JSON; using the standard envelope means tool results round-trip through proper `tool` role messages (no fake user turns, no `[code execution result]` prefix). This was a 2026-05-07 pivot from the original prose-fence design — see `docs/superpowers/specs/2026-05-07-llm-codemode-tool-pivot-design.md`. **How to apply:** when adding a new tool that wants composition, register it normally; if you want it run inside the codemode sandbox, you don't — the LLM does that by writing code that calls it.
```

- [ ] **Step 3: Verify the edit**

```bash
grep -A1 "Codemode is a tool" ~/.claude/projects/-Users-chancock-git-kaizen-official-plugins/memory/openai_compatible_harness_arch.md
```

Expected: the new paragraph is present.

- [ ] **Step 4: No commit (memory lives outside the repo)**

### Task E5: Archive the spec and plan

**Files:**
- Move: `docs/superpowers/specs/2026-05-07-llm-codemode-tool-pivot-design.md` → `docs/superpowers/archive/specs/`
- Move: `docs/superpowers/plans/2026-05-07-llm-codemode-tool-pivot.md` → `docs/superpowers/archive/plans/`

- [ ] **Step 1: Move both files**

```bash
git mv docs/superpowers/specs/2026-05-07-llm-codemode-tool-pivot-design.md \
       docs/superpowers/archive/specs/2026-05-07-llm-codemode-tool-pivot-design.md
git mv docs/superpowers/plans/2026-05-07-llm-codemode-tool-pivot.md \
       docs/superpowers/archive/plans/2026-05-07-llm-codemode-tool-pivot.md
```

- [ ] **Step 2: Update the relative link in the spec's superseded-by reference**

The link added in Task E3 used the same-folder relative path `2026-05-07-llm-codemode-tool-pivot-design.md`. After the move, both files are in `archive/specs/`, so the relative link is still correct. Verify with:

```bash
grep "Superseded by" docs/superpowers/archive/specs/2026-04-30-llm-codemode-dispatch-design.md
```

- [ ] **Step 3: Commit**

```bash
git commit -m "docs: archive completed llm-codemode pivot spec and plan"
```

### Task E6: Final verification

- [ ] **Step 1: Run the full test matrix**

```bash
for d in plugins/*/; do echo "=== $d ==="; (cd "$d" && bun test 2>&1 | tail -10); done
```

Expected: all plugins pass tests.

- [ ] **Step 2: Verify the harness manifest is consistent**

```bash
cat harnesses/openai-compatible.json
```

Confirm:
- Contains `"official/llm-native-dispatch@0.2.0"`.
- Contains `"official/llm-codemode@0.1.0"`.
- Does NOT contain `"official/llm-codemode-dispatch@..."`.
- Contains `"official/llm-tui@0.2.0"` (or whatever current version was bumped to).
- Contains `"official/llm-events@0.4.0"` (the bumped version).

If `llm-events` is referenced as `0.3.0` in the manifest, update to `0.4.0`:

```bash
sed -i.bak 's|llm-events@0.3.0|llm-events@0.4.0|' harnesses/openai-compatible.json && rm harnesses/openai-compatible.json.bak
git add harnesses/openai-compatible.json
git commit -m "chore: pin llm-events@0.4.0 in openai-compatible harness"
```

Also redeploy `llm-events` to the install dir at the new version path:

```bash
mkdir -p ~/.kaizen/marketplaces/official/plugins/llm-events@0.4.0
cp -R plugins/llm-events/. ~/.kaizen/marketplaces/official/plugins/llm-events@0.4.0/
(cd ~/.kaizen/marketplaces/official/plugins/llm-events@0.4.0 \
  && bun build --target=bun --outfile=dist/index.js index.ts)
```

- [ ] **Step 3: Start the harness end-to-end**

If `kaizen` CLI is available locally, start the harness and verify:

```bash
kaizen run openai-compatible
```

Submit a prompt that should trigger `execute_typescript`. Verify in the TUI that:
- A `tool_call` block appears with `▸ execute_typescript` and a spinner glyph.
- Live stdout (if the code prints anything) appears under the running entry.
- The block transitions to `✓` with a result summary on success.
- `/history` lists the call as a 🔧 entry.

- [ ] **Step 4: Done**

The pivot is complete. TODO #2 is closed by structure. The codemode plugin is a drop-in replaceable tool implementer.

---

## Cross-references

- **Spec:** `docs/superpowers/specs/2026-05-07-llm-codemode-tool-pivot-design.md` (moved to archive in Task E5).
- **TODO that this closes:** `docs/TODO.md` item #2.
- **Adjacent specs that may need follow-up edits:** `docs/superpowers/archive/specs/2026-04-30-openai-compatible-foundation-design.md` (Spec 0) — if it explicitly states code-mode is the default, update it. Read once before assuming an edit is needed.
