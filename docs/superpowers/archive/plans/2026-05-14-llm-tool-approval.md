# `llm-tool-approval` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a new plugin that intercepts every `tool:before-execute` event, renders a modal prompt above the TUI input box with four terminal options (Approve Once / Always / Domain Always / Deny), and persists allow/deny rules incrementally to project/global config.

**Architecture:** One new plugin (`llm-tool-approval`), one new cross-plugin contract (`ui:prompt`) defined in `llm-contracts` and implemented by `llm-tui`, two small additive contract extensions (`ToolBeforeExecutePayload.cancelReason`, `UiToolRendererService.summarize`). The plugin owns no service; it subscribes to the bus, consumes `ui:prompt`/`ui:tool-renderer`/`slash:registry`/`ui:status`/`ui:channel`, and writes its own JSON config files. Modal UI lives in `llm-tui` as a new `<PromptBox>` component above `<InputBox>`, driven by a `prompt` slice on `TuiStore`. All keystrokes stay routed through `InputBox` per the existing TUI invariant; while a prompt is active, `InputBox` branches its `useInput` handler to drive the prompt instead.

**Tech Stack:** Bun workspace monorepo · TypeScript · React + Ink (TUI) · `bun:test` · `ink-testing-library` (UI tests). Kaizen plugin runtime via the `kaizen/types` workspace dep. Cross-plugin contracts via `llm-contracts/public`.

**Spec:** `docs/superpowers/specs/2026-05-14-llm-tool-approval-design.md`. Read it before starting.

**Commit style for this repo (per `CLAUDE.md`):** Commits go straight to `main`. No `Co-Authored-By` lines. Skip the `document-and-commit` skill.

**Local deploy reminder:** Kaizen prefers `dist/index.js` over source. After editing any plugin, rebuild its bundle and rsync into `~/.kaizen/marketplaces/official/plugins/<plugin>@<ver>/`. The exact commands per plugin live in each plugin's `CLAUDE.md`. Local deploy is the very last step (Task 19).

---

## File map

### Modify

- `plugins/llm-contracts/contracts/tools-registry.ts` — formalize `ToolBeforeExecutePayload` type with optional `cancelReason`.
- `plugins/llm-contracts/contracts/ui-tool-renderer.ts` — add `summarize(name, args): string` to `UiToolRendererService`.
- `plugins/llm-contracts/public.ts` — re-export the new types.
- `plugins/llm-contracts/index.ts` — `defineService("ui:prompt", …)`.
- `plugins/llm-tools-registry/registry.ts` — use `payload.cancelReason` in the `tool:error` message on cancel.
- `plugins/llm-tools-registry/test/registry.test.ts` — add `cancelReason` cases.
- `plugins/llm-tui/state/store.ts` — `PromptSlice` types and reducers; `prompt` field on snapshot.
- `plugins/llm-tui/state/store.test.ts` — reducer tests.
- `plugins/llm-tui/tool-renderers/registry.ts` — implement `summarize`.
- `plugins/llm-tui/ui/App.tsx` — mount `<PromptBox>` above `<InputBox>`.
- `plugins/llm-tui/ui/InputBox.tsx` — branch `useInput` on `snap.prompt`.
- `plugins/llm-tui/index.tsx` — provide `ui:prompt`.
- `plugins/llm-tui/fallback.ts` — add `ui:prompt` no-op impl.
- `plugins/llm-tui/public.d.ts` — re-export `UiPromptService` from contracts.
- `harnesses/openai-compatible.json` — add the new plugin after `llm-hooks-shell`.

### Create

- `plugins/llm-contracts/contracts/ui-prompt.ts` — the new contract module.
- `plugins/llm-tui/ui/PromptBox.tsx` — Ink component for the modal.
- `plugins/llm-tui/ui/PromptBox.test.tsx` — snapshot tests.
- `plugins/llm-tool-approval/package.json`
- `plugins/llm-tool-approval/tsconfig.json`
- `plugins/llm-tool-approval/README.md`
- `plugins/llm-tool-approval/CLAUDE.md`
- `plugins/llm-tool-approval/defaults.json`
- `plugins/llm-tool-approval/index.ts`
- `plugins/llm-tool-approval/matcher.ts`
- `plugins/llm-tool-approval/config.ts`
- `plugins/llm-tool-approval/subscriber.ts`
- `plugins/llm-tool-approval/slash.ts`
- `plugins/llm-tool-approval/test/matcher.test.ts`
- `plugins/llm-tool-approval/test/config.test.ts`
- `plugins/llm-tool-approval/test/subscriber.test.ts`
- `plugins/llm-tool-approval/test/slash.test.ts`
- `plugins/llm-tool-approval/test/index.test.ts`

---

## Phase A — Contracts

### Task 1: Add `ui:prompt` contract

**Files:**
- Create: `plugins/llm-contracts/contracts/ui-prompt.ts`
- Modify: `plugins/llm-contracts/public.ts`
- Modify: `plugins/llm-contracts/index.ts`

- [ ] **Step 1: Create the contract module**

Write `plugins/llm-contracts/contracts/ui-prompt.ts`:

```ts
export interface UiPromptOption {
  id: string;
  label: string;
  /**
   * If set, Tab on this option expands an inline text field; Enter then
   * submits with both the option id and the typed text. Esc collapses back
   * to the option list (text is discarded).
   */
  expandsTo?: { kind: "text"; placeholder?: string; defaultValue?: string };
}

export interface UiPromptOptionsRequest {
  title: string;
  body: string;
  options: ReadonlyArray<UiPromptOption>;
  /** Initial selection id; defaults to options[0].id. */
  defaultId?: string;
  /** Esc at the top level resolves with this id; defaults to options.at(-1).id. */
  cancelId?: string;
}

export interface UiPromptTextRequest {
  title: string;
  body?: string;
  placeholder?: string;
  defaultValue?: string;
}

export interface UiPromptService {
  /** Resolves to { id } unless the chosen option expanded a text field. */
  requestOption(req: UiPromptOptionsRequest): Promise<{ id: string; text?: string }>;
  /** Standalone text prompt. Esc → empty string. */
  requestText(req: UiPromptTextRequest): Promise<string>;
}

export const CONTRACT_ID = "ui:prompt" as const;
export const DESCRIPTION = "Modal prompt above the input box for option choices and free-form text.";
```

- [ ] **Step 2: Re-export from `public.ts`**

Open `plugins/llm-contracts/public.ts` and add after the `UiToolRendererService` re-export line:

```ts
export type {
  UiPromptService,
  UiPromptOption,
  UiPromptOptionsRequest,
  UiPromptTextRequest,
} from "./contracts/ui-prompt";
```

- [ ] **Step 3: Define the service in `index.ts`**

Open `plugins/llm-contracts/index.ts`. Add to the imports list:

```ts
import * as uiPromptContract from "./contracts/ui-prompt";
```

Add inside `setup(ctx)` after the `uiToolRendererContract.CONTRACT_ID` line:

```ts
ctx.defineService(uiPromptContract.CONTRACT_ID, { description: uiPromptContract.DESCRIPTION });
```

- [ ] **Step 4: Type-check the contracts package**

Run: `cd plugins/llm-contracts && bunx tsc --noEmit`

Expected: exit 0, no diagnostics.

- [ ] **Step 5: Commit**

```sh
git add plugins/llm-contracts/
git commit -m "feat(llm-contracts): add ui:prompt contract for modal option/text prompts"
```

---

### Task 2: Formalize `ToolBeforeExecutePayload` with `cancelReason`

**Files:**
- Modify: `plugins/llm-contracts/contracts/tools-registry.ts`
- Modify: `plugins/llm-contracts/public.ts`

- [ ] **Step 1: Add the payload interface**

Open `plugins/llm-contracts/contracts/tools-registry.ts`. After the existing `ToolExecutionContext` interface and before `ToolHandler`, add:

```ts
export interface ToolBeforeExecutePayload {
  name: string;
  /**
   * Subscribers may overwrite to mutate the args the handler sees, or set
   * to `CANCEL_TOOL` (`Symbol.for("kaizen.cancel")`) to cancel the call.
   */
  args: unknown;
  callId: string;
  turnId?: string;
  sessionId?: string;
  /**
   * Optional human-readable cancellation reason. When `args === CANCEL_TOOL`,
   * the registry emits `tool:error` with this string as the message
   * (defaulting to `"cancelled by subscriber"` when absent) and rejects with
   * an `AbortError` whose `.message` matches. Additive: existing subscribers
   * that don't set this field see no behavior change.
   */
  cancelReason?: string;
}
```

- [ ] **Step 2: Re-export from `public.ts`**

In `plugins/llm-contracts/public.ts`, extend the existing `tools-registry` re-export line. The current line reads:

```ts
export type { ToolsRegistryService, ToolHandler, ToolExecutionContext } from "./contracts/tools-registry";
```

Change it to:

```ts
export type { ToolsRegistryService, ToolHandler, ToolExecutionContext, ToolBeforeExecutePayload } from "./contracts/tools-registry";
```

- [ ] **Step 3: Type-check**

Run: `cd plugins/llm-contracts && bunx tsc --noEmit`

Expected: exit 0, no diagnostics.

- [ ] **Step 4: Commit**

```sh
git add plugins/llm-contracts/
git commit -m "feat(llm-contracts): formalize ToolBeforeExecutePayload with optional cancelReason"
```

---

### Task 3: Add `summarize` to `UiToolRendererService`

**Files:**
- Modify: `plugins/llm-contracts/contracts/ui-tool-renderer.ts`

- [ ] **Step 1: Extend the service interface**

Open `plugins/llm-contracts/contracts/ui-tool-renderer.ts`. Change the `UiToolRendererService` interface from:

```ts
export interface UiToolRendererService {
  register(renderer: UiToolRenderer): () => void;
}
```

to:

```ts
export interface UiToolRendererService {
  register(renderer: UiToolRenderer): () => void;
  /**
   * Human-readable one-line (or short multi-line) summary of a tool call.
   * If a renderer is registered for `name`, returns its `collapsedSummary(args)`.
   * Otherwise returns `name + "\n" + JSON.stringify(args, null, 2)` truncated to
   * roughly 1500 chars with a `… (N more chars)` suffix.
   */
  summarize(name: string, args: unknown): string;
}
```

- [ ] **Step 2: Type-check**

Run: `cd plugins/llm-contracts && bunx tsc --noEmit`

Expected: exit 0.

- [ ] **Step 3: Commit**

```sh
git add plugins/llm-contracts/
git commit -m "feat(llm-contracts): add summarize(name, args) to UiToolRendererService"
```

Note: this will trigger a downstream type error in `plugins/llm-tui/tool-renderers/registry.ts` (missing `summarize` impl) when other plugins typecheck. Task 5 implements it. Do not run `bun test` at the workspace root between Task 3 and Task 5 — it'll fail.

---

## Phase B — Behavior changes wiring up to contracts

### Task 4: Use `cancelReason` in `tools-registry`

**Files:**
- Modify: `plugins/llm-tools-registry/registry.ts`
- Modify: `plugins/llm-tools-registry/test/registry.test.ts`

- [ ] **Step 1: Write the failing test**

Open `plugins/llm-tools-registry/test/registry.test.ts`. Find the existing cancel test (search for `cancelled by subscriber`). After it, add:

```ts
it("uses payload.cancelReason as the tool:error message when set", async () => {
  const { emit, on, events } = captureEmit();
  const r = makeRegistry(emit as any);
  on("tool:before-execute", (p) => {
    p.args = CANCEL_TOOL;
    p.cancelReason = "user denied: not yet";
  });
  r.register(SCHEMA("a"), async () => "should not run");
  await expect(r.invoke("a", { x: 1 }, ctx())).rejects.toMatchObject({
    name: "AbortError",
    message: "user denied: not yet",
  });
  const errEvent = events.find((e) => e.name === "tool:error")!;
  expect(errEvent.payload).toMatchObject({ name: "a", message: "user denied: not yet" });
});

it("falls back to 'cancelled by subscriber' when cancelReason is absent", async () => {
  const { emit, on, events } = captureEmit();
  const r = makeRegistry(emit as any);
  on("tool:before-execute", (p) => { p.args = CANCEL_TOOL; });
  r.register(SCHEMA("a"), async () => "");
  await expect(r.invoke("a", {}, ctx())).rejects.toMatchObject({
    name: "AbortError",
    message: "cancelled by subscriber",
  });
  const errEvent = events.find((e) => e.name === "tool:error")!;
  expect(errEvent.payload.message).toBe("cancelled by subscriber");
});
```

- [ ] **Step 2: Run test to verify the new one fails**

Run: `cd plugins/llm-tools-registry && bun test test/registry.test.ts`

Expected: the new `uses payload.cancelReason` test fails (registry currently emits the hardcoded `"cancelled by subscriber"`). The fallback test should pass already.

- [ ] **Step 3: Update `registry.ts`**

Open `plugins/llm-tools-registry/registry.ts`. Find the block (around line 113):

```ts
const beforePayload: {
  name: string;
  args: unknown;
  callId: string;
  turnId?: string;
  sessionId?: string;
} = { name, args, callId: ctx.callId, ...scoped };
await emit("tool:before-execute", beforePayload);

if (beforePayload.args === CANCEL_TOOL) {
  const message = "cancelled by subscriber";
  await emit("tool:error", { name, callId: ctx.callId, message, ...scoped });
  const err = new Error(message);
  (err as any).name = "AbortError";
  throw err;
}
```

Replace with:

```ts
import type { ToolBeforeExecutePayload } from "llm-contracts/public";
// ... (keep this import grouped with the other type imports at the top)

const beforePayload: ToolBeforeExecutePayload = { name, args, callId: ctx.callId, ...scoped };
await emit("tool:before-execute", beforePayload);

if (beforePayload.args === CANCEL_TOOL) {
  const message = beforePayload.cancelReason ?? "cancelled by subscriber";
  await emit("tool:error", { name, callId: ctx.callId, message, ...scoped });
  const err = new Error(message);
  (err as any).name = "AbortError";
  throw err;
}
```

Move the `import type { ToolBeforeExecutePayload } from "llm-contracts/public";` to the top of the file with the other `llm-contracts/public` imports (do not leave the import inline as shown above — that was illustrative only).

- [ ] **Step 4: Run tests to verify they all pass**

Run: `cd plugins/llm-tools-registry && bun test`

Expected: all tests pass.

- [ ] **Step 5: Commit**

```sh
git add plugins/llm-tools-registry/
git commit -m "feat(llm-tools-registry): honor payload.cancelReason in tool:error message"
```

---

### Task 5: Implement `summarize` on the TUI tool-renderer registry

**Files:**
- Modify: `plugins/llm-tui/tool-renderers/registry.ts`

- [ ] **Step 1: Write a failing test**

Open `plugins/llm-tui/tool-renderers/registry.test.ts` (create if it doesn't exist — verify with `ls plugins/llm-tui/tool-renderers/`).

If the file doesn't exist, create it with:

```ts
import { describe, it, expect } from "bun:test";
import { makeToolRendererRegistry } from "./registry.ts";

describe("makeToolRendererRegistry — summarize", () => {
  it("uses registered renderer's collapsedSummary", () => {
    const reg = makeToolRendererRegistry();
    reg.service.register({
      toolName: "fs:read_file",
      collapsedSummary: (args: any) => `read ${args.path}`,
    });
    expect(reg.service.summarize("fs:read_file", { path: "/tmp/foo" })).toBe("read /tmp/foo");
  });

  it("falls back to name + JSON for unregistered tools", () => {
    const reg = makeToolRendererRegistry();
    const out = reg.service.summarize("mcp:github:list_issues", { state: "open" });
    expect(out).toContain("mcp:github:list_issues");
    expect(out).toContain(`"state": "open"`);
  });

  it("truncates long args with a suffix", () => {
    const reg = makeToolRendererRegistry();
    const big = "x".repeat(5000);
    const out = reg.service.summarize("noop", { big });
    expect(out.length).toBeLessThan(1700); // 1500 + name + suffix
    expect(out).toMatch(/… \(\d+ more chars\)/);
  });

  it("handles errors in collapsedSummary by falling back to JSON", () => {
    const reg = makeToolRendererRegistry();
    reg.service.register({
      toolName: "boom",
      collapsedSummary: () => { throw new Error("bad"); },
    });
    const out = reg.service.summarize("boom", { x: 1 });
    expect(out).toContain("boom");
    expect(out).toContain(`"x": 1`);
  });
});
```

If the file already exists, add the four `it(...)` blocks above to an appropriate `describe` block.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/llm-tui && bun test tool-renderers/registry.test.ts`

Expected: failures referring to `summarize is not a function` (or the TS error from Task 3 manifesting).

- [ ] **Step 3: Implement `summarize`**

Open `plugins/llm-tui/tool-renderers/registry.ts`. Locate the factory (returns `{ service, ... }`). Add a `summarize` method to the service object. The complete impl:

```ts
function summarize(name: string, args: unknown): string {
  const renderer = registry.get(name);  // or however the existing registry stores them — match the local var name
  if (renderer) {
    try {
      return renderer.collapsedSummary(args);
    } catch {
      // fall through to JSON fallback
    }
  }
  let json: string;
  try {
    json = JSON.stringify(args, null, 2);
  } catch {
    json = String(args);
  }
  const maxLen = 1500;
  if (json.length <= maxLen) return `${name}\n${json}`;
  const truncated = json.slice(0, maxLen);
  return `${name}\n${truncated}… (${json.length - maxLen} more chars)`;
}
```

Wire `summarize` into the service object so it's exposed as `service.summarize`. Read the existing factory to match its style; the variable holding the renderer map may be called `entries`, `renderers`, or similar — use whatever exists.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd plugins/llm-tui && bun test tool-renderers/`

Expected: all pass.

- [ ] **Step 5: Run the whole TUI test suite to confirm no regression**

Run: `cd plugins/llm-tui && bun test`

Expected: all pass.

- [ ] **Step 6: Commit**

```sh
git add plugins/llm-tui/tool-renderers/
git commit -m "feat(llm-tui): implement summarize(name, args) on tool-renderer registry"
```

---

## Phase C — TUI store: prompt slice + reducers

### Task 6: Add `PromptSlice` types and open reducers

**Files:**
- Modify: `plugins/llm-tui/state/store.ts`
- Modify: `plugins/llm-tui/state/store.test.ts`

- [ ] **Step 1: Write failing reducer tests**

Open `plugins/llm-tui/state/store.test.ts`. Append:

```ts
describe("TuiStore — prompt slice (open)", () => {
  it("starts with prompt = null", () => {
    const s = new TuiStore();
    expect(s.snapshot().prompt).toBeNull();
  });

  it("openOptionsPrompt sets the slice with defaults", () => {
    const s = new TuiStore();
    let resolved: any = null;
    s.openOptionsPrompt(
      {
        title: "T",
        body: "B",
        options: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
      },
      (r) => { resolved = r; },
    );
    const slice = s.snapshot().prompt;
    expect(slice).not.toBeNull();
    expect(slice!.kind).toBe("options");
    if (slice!.kind === "options") {
      expect(slice!.selectedIndex).toBe(0);
      expect(slice!.expanded).toBeNull();
      expect(slice!.request.options.length).toBe(2);
    }
    expect(resolved).toBeNull(); // open does not resolve
  });

  it("openOptionsPrompt honors defaultId", () => {
    const s = new TuiStore();
    s.openOptionsPrompt(
      { title: "T", body: "B", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], defaultId: "b" },
      () => {},
    );
    const slice = s.snapshot().prompt;
    expect(slice!.kind === "options" && slice!.selectedIndex).toBe(1);
  });

  it("openTextPrompt sets kind=text with defaultValue", () => {
    const s = new TuiStore();
    s.openTextPrompt({ title: "T", defaultValue: "hello" }, () => {});
    const slice = s.snapshot().prompt;
    expect(slice!.kind).toBe("text");
    if (slice!.kind === "text") {
      expect(slice!.text).toBe("hello");
    }
  });

  it("openTextPrompt defaults text to empty string", () => {
    const s = new TuiStore();
    s.openTextPrompt({ title: "T" }, () => {});
    const slice = s.snapshot().prompt;
    expect(slice!.kind === "text" && slice!.text).toBe("");
  });

  it("snapshot identity changes when prompt opens", () => {
    const s = new TuiStore();
    const a = s.snapshot();
    s.openOptionsPrompt({ title: "T", body: "B", options: [{ id: "a", label: "A" }] }, () => {});
    const b = s.snapshot();
    expect(b).not.toBe(a);
  });
});
```

- [ ] **Step 2: Verify failing**

Run: `cd plugins/llm-tui && bun test state/store.test.ts`

Expected: failures — `openOptionsPrompt is not a function`, `prompt` field missing on snapshot.

- [ ] **Step 3: Add types to `store.ts`**

Open `plugins/llm-tui/state/store.ts`. Above the `TuiSnapshot` interface, add:

```ts
import type {
  UiPromptOptionsRequest,
  UiPromptTextRequest,
} from "llm-contracts/public";

export type PromptSlice =
  | null
  | {
      kind: "options";
      request: UiPromptOptionsRequest;
      selectedIndex: number;
      expanded: { id: string; text: string } | null;
      resolve: (result: { id: string; text?: string }) => void;
    }
  | {
      kind: "text";
      request: UiPromptTextRequest;
      text: string;
      resolve: (text: string) => void;
    };
```

Add a `prompt: PromptSlice` field to `TuiSnapshot` (place it after `historyView`).

- [ ] **Step 4: Add internal state and snapshot rebuild**

Inside the `TuiStore` class, add a private field next to the other `_x` fields:

```ts
private _prompt: PromptSlice = null;
```

Find the snapshot-build function (usually `_buildSnapshot()` or similar). Include the prompt slice in the returned object:

```ts
prompt: this._prompt,
```

Match the existing snapshot construction style exactly.

- [ ] **Step 5: Implement `openOptionsPrompt` and `openTextPrompt`**

Add to `TuiStore`:

```ts
openOptionsPrompt(
  request: UiPromptOptionsRequest,
  resolve: (result: { id: string; text?: string }) => void,
): void {
  const defaultId = request.defaultId ?? request.options[0]?.id;
  const idx = Math.max(0, request.options.findIndex((o) => o.id === defaultId));
  this._prompt = { kind: "options", request, selectedIndex: idx, expanded: null, resolve };
  this._notify();
}

openTextPrompt(
  request: UiPromptTextRequest,
  resolve: (text: string) => void,
): void {
  this._prompt = { kind: "text", request, text: request.defaultValue ?? "", resolve };
  this._notify();
}
```

Use whatever the store's notification method is named (`_notify`, `_emit`, `_rebuild`, etc.). Snapshots must rebuild fresh per the snapshot-identity invariant.

- [ ] **Step 6: Verify passing**

Run: `cd plugins/llm-tui && bun test state/store.test.ts -t "prompt slice"`

Expected: all `prompt slice (open)` tests pass.

- [ ] **Step 7: Commit**

```sh
git add plugins/llm-tui/state/
git commit -m "feat(llm-tui): add PromptSlice types and open reducers to TuiStore"
```

---

### Task 7: Add navigation reducers

**Files:**
- Modify: `plugins/llm-tui/state/store.ts`
- Modify: `plugins/llm-tui/state/store.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `plugins/llm-tui/state/store.test.ts` inside or after the previous `describe`:

```ts
describe("TuiStore — prompt slice (navigation)", () => {
  const openTwo = (s: TuiStore) => {
    s.openOptionsPrompt(
      {
        title: "T",
        body: "B",
        options: [
          { id: "a", label: "A" },
          { id: "b", label: "B", expandsTo: { kind: "text", placeholder: "p" } },
        ],
      },
      () => {},
    );
  };

  it("moveSelection clamps to [0, length-1]", () => {
    const s = new TuiStore();
    openTwo(s);
    s.moveSelection(-1);
    expect(s.snapshot().prompt!.kind === "options" && s.snapshot().prompt!.selectedIndex).toBe(0);
    s.moveSelection(1);
    expect(s.snapshot().prompt!.kind === "options" && s.snapshot().prompt!.selectedIndex).toBe(1);
    s.moveSelection(1); // already at end
    expect(s.snapshot().prompt!.kind === "options" && s.snapshot().prompt!.selectedIndex).toBe(1);
  });

  it("moveSelection is a no-op when prompt is text or null", () => {
    const s = new TuiStore();
    s.moveSelection(1);
    expect(s.snapshot().prompt).toBeNull();
    s.openTextPrompt({ title: "T" }, () => {});
    s.moveSelection(1);
    expect(s.snapshot().prompt!.kind).toBe("text");
  });

  it("tabExpand only expands when selected option has expandsTo", () => {
    const s = new TuiStore();
    openTwo(s);
    // selectedIndex 0 = option "a" with no expandsTo
    s.tabExpand();
    expect(s.snapshot().prompt!.kind === "options" && s.snapshot().prompt!.expanded).toBeNull();
    s.moveSelection(1); // now on "b" which has expandsTo
    s.tabExpand();
    const slice = s.snapshot().prompt;
    expect(slice!.kind === "options" && slice!.expanded).toEqual({ id: "b", text: "" });
  });

  it("tabExpand uses defaultValue when expandsTo provides one", () => {
    const s = new TuiStore();
    s.openOptionsPrompt(
      {
        title: "T",
        body: "B",
        options: [{ id: "x", label: "X", expandsTo: { kind: "text", defaultValue: "seed" } }],
      },
      () => {},
    );
    s.tabExpand();
    const slice = s.snapshot().prompt;
    expect(slice!.kind === "options" && slice!.expanded).toEqual({ id: "x", text: "seed" });
  });

  it("collapseExpansion clears expanded (discarding text)", () => {
    const s = new TuiStore();
    openTwo(s);
    s.moveSelection(1);
    s.tabExpand();
    s.setExpandedText("typed");
    s.collapseExpansion();
    const slice = s.snapshot().prompt;
    expect(slice!.kind === "options" && slice!.expanded).toBeNull();
  });

  it("setExpandedText replaces the expanded text", () => {
    const s = new TuiStore();
    openTwo(s);
    s.moveSelection(1);
    s.tabExpand();
    s.setExpandedText("new");
    const slice = s.snapshot().prompt;
    expect(slice!.kind === "options" && slice!.expanded?.text).toBe("new");
  });

  it("setExpandedText is a no-op when not expanded", () => {
    const s = new TuiStore();
    openTwo(s);
    s.setExpandedText("ignored");
    const slice = s.snapshot().prompt;
    expect(slice!.kind === "options" && slice!.expanded).toBeNull();
  });

  it("setStandaloneText replaces text in text mode", () => {
    const s = new TuiStore();
    s.openTextPrompt({ title: "T" }, () => {});
    s.setStandaloneText("hello");
    expect(s.snapshot().prompt!.kind === "text" && s.snapshot().prompt!.text).toBe("hello");
  });
});
```

- [ ] **Step 2: Verify failing**

Run: `cd plugins/llm-tui && bun test state/store.test.ts -t "navigation"`

Expected: failures referring to `moveSelection`, `tabExpand`, etc.

- [ ] **Step 3: Implement the reducers**

Add to `TuiStore` (keep in the same group as the open reducers from Task 6):

```ts
moveSelection(delta: number): void {
  const p = this._prompt;
  if (!p || p.kind !== "options") return;
  const len = p.request.options.length;
  if (len === 0) return;
  const next = Math.max(0, Math.min(len - 1, p.selectedIndex + delta));
  if (next === p.selectedIndex) return;
  this._prompt = { ...p, selectedIndex: next };
  this._notify();
}

tabExpand(): void {
  const p = this._prompt;
  if (!p || p.kind !== "options") return;
  const opt = p.request.options[p.selectedIndex];
  if (!opt?.expandsTo) return;
  this._prompt = {
    ...p,
    expanded: { id: opt.id, text: opt.expandsTo.defaultValue ?? "" },
  };
  this._notify();
}

collapseExpansion(): void {
  const p = this._prompt;
  if (!p || p.kind !== "options" || !p.expanded) return;
  this._prompt = { ...p, expanded: null };
  this._notify();
}

setExpandedText(text: string): void {
  const p = this._prompt;
  if (!p || p.kind !== "options" || !p.expanded) return;
  this._prompt = { ...p, expanded: { ...p.expanded, text } };
  this._notify();
}

setStandaloneText(text: string): void {
  const p = this._prompt;
  if (!p || p.kind !== "text") return;
  this._prompt = { ...p, text };
  this._notify();
}
```

- [ ] **Step 4: Verify passing**

Run: `cd plugins/llm-tui && bun test state/store.test.ts -t "navigation"`

Expected: all pass.

- [ ] **Step 5: Commit**

```sh
git add plugins/llm-tui/state/
git commit -m "feat(llm-tui): add prompt navigation/expand/text reducers to TuiStore"
```

---

### Task 8: Add `submitPrompt` and `escapePrompt` (with transcript echo)

**Files:**
- Modify: `plugins/llm-tui/state/store.ts`
- Modify: `plugins/llm-tui/state/store.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `plugins/llm-tui/state/store.test.ts`:

```ts
describe("TuiStore — prompt slice (submit/escape)", () => {
  it("submitPrompt resolves with result and clears the slice", () => {
    const s = new TuiStore();
    let resolved: any = null;
    s.openOptionsPrompt(
      { title: "Approve?", body: "B", options: [{ id: "ok", label: "OK" }] },
      (r) => { resolved = r; },
    );
    s.submitPrompt({ id: "ok" });
    expect(resolved).toEqual({ id: "ok" });
    expect(s.snapshot().prompt).toBeNull();
  });

  it("submitPrompt for options appends a notice transcript entry", () => {
    const s = new TuiStore();
    s.openOptionsPrompt(
      { title: "Approve?", body: "B", options: [{ id: "ok", label: "OK" }] },
      () => {},
    );
    s.submitPrompt({ id: "ok" });
    const entries = s.snapshot().transcript.filter((e) => e.kind === "notice");
    const last = entries.at(-1)!;
    expect((last as any).text).toBe("? Approve? → OK");
  });

  it("submitPrompt for options with text appends '<label>: <text>'", () => {
    const s = new TuiStore();
    s.openOptionsPrompt(
      {
        title: "Approve?",
        body: "B",
        options: [{ id: "deny", label: "Deny", expandsTo: { kind: "text" } }],
      },
      () => {},
    );
    s.submitPrompt({ id: "deny", text: "looks dangerous" });
    const entries = s.snapshot().transcript.filter((e) => e.kind === "notice");
    const last = entries.at(-1)!;
    expect((last as any).text).toBe("? Approve? → Deny: looks dangerous");
  });

  it("submitPrompt for text appends '<text>' or '(skipped)'", () => {
    const s1 = new TuiStore();
    s1.openTextPrompt({ title: "Reason?" }, () => {});
    s1.submitPrompt("because");
    const t1 = s1.snapshot().transcript.filter((e) => e.kind === "notice").at(-1)!;
    expect((t1 as any).text).toBe("? Reason? → because");

    const s2 = new TuiStore();
    s2.openTextPrompt({ title: "Reason?" }, () => {});
    s2.submitPrompt("");
    const t2 = s2.snapshot().transcript.filter((e) => e.kind === "notice").at(-1)!;
    expect((t2 as any).text).toBe("? Reason? → (skipped)");
  });

  it("submitPrompt is a no-op when no prompt is active", () => {
    const s = new TuiStore();
    const before = s.snapshot();
    s.submitPrompt({ id: "x" } as any);
    expect(s.snapshot()).toBe(before); // identity unchanged
  });

  it("escapePrompt resolves options with cancelId (or last option) and clears", () => {
    const s = new TuiStore();
    let resolved: any = null;
    s.openOptionsPrompt(
      { title: "T", body: "B", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] },
      (r) => { resolved = r; },
    );
    s.escapePrompt();
    expect(resolved).toEqual({ id: "b" });
    expect(s.snapshot().prompt).toBeNull();
  });

  it("escapePrompt honors explicit cancelId on options request", () => {
    const s = new TuiStore();
    let resolved: any = null;
    s.openOptionsPrompt(
      { title: "T", body: "B", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], cancelId: "a" },
      (r) => { resolved = r; },
    );
    s.escapePrompt();
    expect(resolved).toEqual({ id: "a" });
  });

  it("escapePrompt resolves text with empty string", () => {
    const s = new TuiStore();
    let resolved: string | null = null;
    s.openTextPrompt({ title: "T", defaultValue: "x" }, (t) => { resolved = t; });
    s.escapePrompt();
    expect(resolved).toBe("");
    expect(s.snapshot().prompt).toBeNull();
  });
});
```

- [ ] **Step 2: Verify failing**

Run: `cd plugins/llm-tui && bun test state/store.test.ts -t "submit/escape"`

Expected: failures.

- [ ] **Step 3: Implement the reducers**

Add to `TuiStore`:

```ts
submitPrompt(result: { id: string; text?: string } | string): void {
  const p = this._prompt;
  if (!p) return;
  let noticeText: string;
  if (p.kind === "options") {
    if (typeof result === "string") return; // wrong shape; ignore
    const opt = p.request.options.find((o) => o.id === result.id);
    const label = opt?.label ?? result.id;
    noticeText = result.text
      ? `? ${p.request.title} → ${label}: ${result.text}`
      : `? ${p.request.title} → ${label}`;
    const resolve = p.resolve;
    this._prompt = null;
    this._appendNotice(noticeText);
    this._notify();
    resolve(result);
  } else {
    if (typeof result !== "string") return; // wrong shape; ignore
    noticeText = `? ${p.request.title} → ${result === "" ? "(skipped)" : result}`;
    const resolve = p.resolve;
    this._prompt = null;
    this._appendNotice(noticeText);
    this._notify();
    resolve(result);
  }
}

escapePrompt(): void {
  const p = this._prompt;
  if (!p) return;
  if (p.kind === "options") {
    const cancelId = p.request.cancelId ?? p.request.options.at(-1)?.id;
    if (cancelId === undefined) {
      // Empty options list — clear the slice but don't try to resolve.
      this._prompt = null;
      this._notify();
      return;
    }
    this.submitPrompt({ id: cancelId });
  } else {
    this.submitPrompt("");
  }
}
```

`_appendNotice(text)` is a helper that pushes a `{ kind: "notice", text, markdown: false }` entry into `_transcript` with a fresh id (use `this._nextId++` or whatever id counter exists). If no `_appendNotice` exists, factor it out of the existing notice-write code path; do not duplicate. If a `writeNotice` method exists on the store, use that — but it likely won't, because notices arrive via the `UiChannel` service. Look at the existing `writeNotice` flow in `index.tsx` to mirror the construction.

Concretely, the existing `UiChannelService.writeNotice` in `index.tsx` calls something like `store.appendTranscript({ kind: "notice", text, markdown: false })`. If `appendTranscript` exists, use it. Otherwise add a minimal `_appendNotice(text: string)` private method that does the same push + id bump.

- [ ] **Step 4: Verify passing**

Run: `cd plugins/llm-tui && bun test state/store.test.ts -t "submit/escape"`

Expected: all pass.

- [ ] **Step 5: Run the full store test suite to confirm no regression**

Run: `cd plugins/llm-tui && bun test state/store.test.ts`

Expected: all pass.

- [ ] **Step 6: Commit**

```sh
git add plugins/llm-tui/state/
git commit -m "feat(llm-tui): add prompt submit/escape reducers with transcript echo"
```

---

## Phase D — TUI rendering

### Task 9: Create `<PromptBox>` component

**Files:**
- Create: `plugins/llm-tui/ui/PromptBox.tsx`
- Create: `plugins/llm-tui/ui/PromptBox.test.tsx`

- [ ] **Step 1: Write failing snapshot tests**

Create `plugins/llm-tui/ui/PromptBox.test.tsx`:

```tsx
import { describe, it, expect } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { PromptBox } from "./PromptBox.tsx";
import { TuiStore } from "../state/store.ts";
import { DEFAULT_THEME } from "../theme/loader.ts";

const theme = DEFAULT_THEME;

describe("<PromptBox>", () => {
  it("renders nothing when prompt is null", () => {
    const store = new TuiStore();
    const { lastFrame } = render(<PromptBox store={store} theme={theme} />);
    expect(lastFrame()?.trim() ?? "").toBe("");
  });

  it("renders options mode with selected indicator", () => {
    const store = new TuiStore();
    store.openOptionsPrompt(
      {
        title: "Approve tool call?",
        body: "fs:read_file",
        options: [
          { id: "once", label: "Approve Once" },
          { id: "deny", label: "Deny", expandsTo: { kind: "text" } },
        ],
        defaultId: "once",
      },
      () => {},
    );
    const { lastFrame } = render(<PromptBox store={store} theme={theme} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Approve tool call?");
    expect(frame).toContain("fs:read_file");
    expect(frame).toContain("Approve Once");
    expect(frame).toContain("Deny");
    // Selected indicator on the first row.
    expect(frame).toMatch(/[▸>].*Approve Once/);
  });

  it("renders Tab-hint on options with expandsTo", () => {
    const store = new TuiStore();
    store.openOptionsPrompt(
      {
        title: "T",
        body: "B",
        options: [{ id: "deny", label: "Deny", expandsTo: { kind: "text" } }],
      },
      () => {},
    );
    const { lastFrame } = render(<PromptBox store={store} theme={theme} />);
    expect(lastFrame()).toContain("Tab");
  });

  it("renders expanded mode with text input row", () => {
    const store = new TuiStore();
    store.openOptionsPrompt(
      {
        title: "T",
        body: "B",
        options: [{ id: "deny", label: "Deny", expandsTo: { kind: "text", placeholder: "Reason" } }],
      },
      () => {},
    );
    store.tabExpand();
    store.setExpandedText("looks dangerous");
    const { lastFrame } = render(<PromptBox store={store} theme={theme} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("looks dangerous");
    expect(frame).toMatch(/Enter.*Esc/); // hint row
  });

  it("renders standalone text mode", () => {
    const store = new TuiStore();
    store.openTextPrompt({ title: "Reason?", body: "Why deny?", placeholder: "type here" }, () => {});
    const { lastFrame } = render(<PromptBox store={store} theme={theme} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Reason?");
    expect(frame).toContain("Why deny?");
  });

  it("handles CJK width in body without breaking layout", () => {
    const store = new TuiStore();
    store.openOptionsPrompt(
      {
        title: "ツール呼び出しを承認しますか?",
        body: "fs:読み取り",
        options: [{ id: "ok", label: "承認" }],
      },
      () => {},
    );
    const { lastFrame } = render(<PromptBox store={store} theme={theme} />);
    // We don't assert exact byte width — just that the frame renders and
    // contains the strings. CJK width is enforced by Ink/yoga; this guards
    // against regressions where we accidentally measure with `.length`.
    expect(lastFrame()).toContain("承認");
  });
});
```

- [ ] **Step 2: Verify failing**

Run: `cd plugins/llm-tui && bun test ui/PromptBox.test.tsx`

Expected: import failure — `PromptBox.tsx` doesn't exist yet.

- [ ] **Step 3: Implement `<PromptBox>`**

Create `plugins/llm-tui/ui/PromptBox.tsx`:

```tsx
import React, { useSyncExternalStore } from "react";
import { Box, Text } from "ink";
import type { TuiStore } from "../state/store.ts";
import type { TuiTheme } from "../theme/loader.ts";

export interface PromptBoxProps {
  store: TuiStore;
  theme: TuiTheme;
}

export const PromptBox: React.FC<PromptBoxProps> = ({ store, theme }) => {
  const snap = useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => store.snapshot(),
  );
  const prompt = snap.prompt;
  if (!prompt) return null;

  if (prompt.kind === "text") {
    const { request, text } = prompt;
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.noticeColor} paddingX={1}>
        <Text color={theme.noticeColor} bold>{request.title}</Text>
        {request.body ? <Text>{request.body}</Text> : null}
        <Box marginTop={1}>
          <Text color={theme.promptColor}>{"▏ "}</Text>
          <Text>{text || (request.placeholder ?? "")}</Text>
        </Box>
        <Text color={theme.noticeColor} dimColor>
          {"Enter to submit · Esc to skip"}
        </Text>
      </Box>
    );
  }

  // options mode
  const { request, selectedIndex, expanded } = prompt;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.noticeColor} paddingX={1}>
      <Text color={theme.noticeColor} bold>{request.title}</Text>
      <Text>{request.body}</Text>
      <Box marginTop={1} flexDirection="column">
        {request.options.map((opt, i) => {
          const isSelected = i === selectedIndex;
          const indicator = isSelected ? "▸ " : "  ";
          const tabHint = opt.expandsTo && isSelected && !expanded ? "  (Tab for reason)" : "";
          return (
            <React.Fragment key={opt.id}>
              <Box>
                <Text color={isSelected ? theme.promptColor : undefined} bold={isSelected}>
                  {indicator}{opt.label}{tabHint}
                </Text>
              </Box>
              {expanded && expanded.id === opt.id ? (
                <Box flexDirection="column" marginLeft={4}>
                  <Box>
                    <Text>{(opt.expandsTo?.placeholder ?? "Reason") + ": "}</Text>
                    <Text>{expanded.text}</Text>
                    <Text color={theme.promptColor}>▏</Text>
                  </Box>
                  <Text color={theme.noticeColor} dimColor>
                    {"Enter to submit · Esc to collapse"}
                  </Text>
                </Box>
              ) : null}
            </React.Fragment>
          );
        })}
      </Box>
    </Box>
  );
};
```

If `DEFAULT_THEME` is not exported from `theme/loader.ts`, find what is exported and adapt the test's import (it may be `DEFAULT_THEME` from a different file in the theme dir, or a named export the loader uses).

- [ ] **Step 4: Verify tests pass**

Run: `cd plugins/llm-tui && bun test ui/PromptBox.test.tsx`

Expected: all pass.

- [ ] **Step 5: Commit**

```sh
git add plugins/llm-tui/ui/
git commit -m "feat(llm-tui): add PromptBox component (options/expanded/text modes)"
```

---

### Task 10: Mount `<PromptBox>` in `<App>`; gate `<InputBox>` keystrokes

**Files:**
- Modify: `plugins/llm-tui/ui/App.tsx`
- Modify: `plugins/llm-tui/ui/InputBox.tsx`
- Modify: `plugins/llm-tui/integration.test.ts` (or create a focused integration test if appropriate)

- [ ] **Step 1: Write failing integration test**

Open `plugins/llm-tui/integration.test.ts`. Append a `describe` block:

```ts
describe("prompt keystroke gating", () => {
  it("Up/Down navigate options; Enter submits with id; transcript echo lands", async () => {
    const store = new TuiStore();
    let resolved: any = null;
    store.openOptionsPrompt(
      {
        title: "Approve?",
        body: "fs:read_file",
        options: [
          { id: "once", label: "Approve Once" },
          { id: "deny", label: "Deny", expandsTo: { kind: "text" } },
        ],
        defaultId: "once",
      },
      (r) => { resolved = r; },
    );
    // simulate Down + Enter via store mutations (the actual key wiring is in
    // InputBox; this integration test exercises the reducer chain that
    // InputBox would invoke).
    store.moveSelection(1);
    store.submitPrompt({ id: "deny" });
    expect(resolved).toEqual({ id: "deny" });
    expect(store.snapshot().prompt).toBeNull();
    const last = store.snapshot().transcript.filter((e) => e.kind === "notice").at(-1)!;
    expect((last as any).text).toBe("? Approve? → Deny");
  });

  it("Tab on expandsTo option opens text; typing + Enter resolves with text", async () => {
    const store = new TuiStore();
    let resolved: any = null;
    store.openOptionsPrompt(
      {
        title: "Approve?",
        body: "fs:read_file",
        options: [{ id: "deny", label: "Deny", expandsTo: { kind: "text" } }],
      },
      (r) => { resolved = r; },
    );
    store.tabExpand();
    store.setExpandedText("no");
    store.submitPrompt({ id: "deny", text: "no" });
    expect(resolved).toEqual({ id: "deny", text: "no" });
  });
});
```

The test mutates the store directly because Ink's `useInput` is awkward to stimulate in isolation; full keypress tests go through `ink-testing-library`'s `stdin.write` in the existing `InputBox.test.tsx` if there is one. The reducer-level integration above guards against the reducer wiring breaking when the InputBox branching is added.

- [ ] **Step 2: Verify failing or passing**

Run: `cd plugins/llm-tui && bun test integration.test.ts -t "prompt keystroke gating"`

Expected: passes immediately (the reducers from Phase C support this). This is a regression guard for the next step.

- [ ] **Step 3: Mount `<PromptBox>` in `<App>`**

Open `plugins/llm-tui/ui/App.tsx`. Add the import at the top:

```tsx
import { PromptBox } from "./PromptBox.tsx";
```

Inside the chat-mode JSX (the `:` branch after `viewMode === "history"`), insert `<PromptBox>` directly above `<InputBox>`:

```tsx
<>
  <LiveToolCalls store={store} registry={toolRenderers} theme={theme} />
  {snap.busy.active && snap.liveThinking && (
    <ThinkingBox text={snap.liveThinking} color={theme.noticeColor} />
  )}
  {snap.busy.active && (
    <SpinnerLine
      color={theme.busyColor}
      message={snap.busy.message}
      startedAt={snap.busy.startedAt}
      deltaTokens={snap.busy.deltaTokens}
    />
  )}
  <PromptBox store={store} theme={theme} />
  <InputBox
    store={store}
    /* ... existing props ... */
  />
  <StatusBar items={snap.status} color={theme.statusBarColor} />
</>
```

- [ ] **Step 4: Branch `<InputBox>` keystrokes on `snap.prompt`**

Open `plugins/llm-tui/ui/InputBox.tsx`. Locate the existing `useInput((input, key) => { ... })` body. At the very top of the handler, add the prompt-mode branch:

```tsx
useInput((input, key) => {
  const snap = /* however the store snapshot is read here — likely already in scope */;
  const prompt = snap.prompt;
  if (prompt) {
    if (prompt.kind === "options" && !prompt.expanded) {
      if (key.upArrow) { store.moveSelection(-1); return; }
      if (key.downArrow) { store.moveSelection(1); return; }
      if (key.return) {
        store.submitPrompt({ id: prompt.request.options[prompt.selectedIndex]!.id });
        return;
      }
      if (key.tab) {
        store.tabExpand();
        return;
      }
      if (key.escape) {
        store.escapePrompt();
        return;
      }
      return; // swallow everything else
    }
    if (prompt.kind === "options" && prompt.expanded) {
      if (key.return) {
        store.submitPrompt({ id: prompt.expanded.id, text: prompt.expanded.text });
        return;
      }
      if (key.escape) {
        store.collapseExpansion();
        return;
      }
      if (key.backspace || key.delete) {
        store.setExpandedText(prompt.expanded.text.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        store.setExpandedText(prompt.expanded.text + input);
        return;
      }
      return;
    }
    if (prompt.kind === "text") {
      if (key.return) {
        store.submitPrompt(prompt.text);
        return;
      }
      if (key.escape) {
        store.submitPrompt("");
        return;
      }
      if (key.backspace || key.delete) {
        store.setStandaloneText(prompt.text.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        store.setStandaloneText(prompt.text + input);
        return;
      }
      return;
    }
  }
  // ... existing input handling continues below unchanged
});
```

The exact local variable name for the snapshot may already exist (e.g., `snap`, `state`). Use whatever the file uses. If the snapshot isn't already in scope inside `useInput`, hoist it via `const snap = useSyncExternalStore(...)` at the top of the component body and reference it inside the handler — match the pattern in `App.tsx`.

- [ ] **Step 5: Run tests**

Run: `cd plugins/llm-tui && bun test`

Expected: all pass. If `InputBox.test.tsx` exists and exercises keypress flow, verify it still passes — the prompt branch returns early on no-prompt so existing tests should be untouched.

- [ ] **Step 6: Commit**

```sh
git add plugins/llm-tui/ui/ plugins/llm-tui/integration.test.ts
git commit -m "feat(llm-tui): mount PromptBox above InputBox and gate keystrokes during prompts"
```

---

## Phase E — TUI services + fallback

### Task 11: Provide `ui:prompt` service from TUI

**Files:**
- Modify: `plugins/llm-tui/index.tsx`
- Modify: `plugins/llm-tui/public.d.ts`
- Modify: `plugins/llm-tui/index.test.ts`

- [ ] **Step 1: Write failing test**

Open `plugins/llm-tui/index.test.ts`. Search for the existing service-registration assertions (e.g., assertions on `ui:channel`, `ui:theme`). Add an analogous assertion for `ui:prompt`:

```ts
it("provides ui:prompt service", async () => {
  const ctx = makeFakeCtx();  // use whatever helper exists in this test file
  await plugin.setup(ctx);
  const promptService = ctx.useService<UiPromptService>("ui:prompt");
  expect(typeof promptService.requestOption).toBe("function");
  expect(typeof promptService.requestText).toBe("function");
});

it("ui:prompt.requestOption opens the store slice and resolves on submit", async () => {
  const ctx = makeFakeCtx();
  await plugin.setup(ctx);
  const promptService = ctx.useService<UiPromptService>("ui:prompt");
  // The store is created inside plugin.setup; the test helper should expose
  // it. If not, expose it via a getter on the fake ctx.
  const store: TuiStore = ctx._testStore;
  const pending = promptService.requestOption({
    title: "T",
    body: "B",
    options: [{ id: "ok", label: "OK" }],
  });
  expect(store.snapshot().prompt).not.toBeNull();
  store.submitPrompt({ id: "ok" });
  await expect(pending).resolves.toEqual({ id: "ok" });
});
```

If `_testStore` does not exist on the fake ctx, add it: when `setup` constructs `store`, the existing helper (or a new private hook on `ctx`) should make it reachable for tests. Look at how other store-touching tests in this file get the store; mirror that.

Import the types at the top:

```ts
import type { UiPromptService } from "llm-contracts/public";
import type { TuiStore } from "./state/store.ts";
```

- [ ] **Step 2: Verify failing**

Run: `cd plugins/llm-tui && bun test index.test.ts -t "ui:prompt"`

Expected: failure — `useService("ui:prompt")` returns undefined / throws.

- [ ] **Step 3: Implement the service in `index.tsx`**

Open `plugins/llm-tui/index.tsx`. Add to the imports:

```tsx
import type { UiPromptService } from "llm-contracts/public";
```

Inside `setup(ctx)`, after `provideService<UiToolRendererService>(...)`, add:

```tsx
const uiPrompt: UiPromptService = {
  requestOption(req) {
    return new Promise((resolve) => {
      store.openOptionsPrompt(req, resolve);
    });
  },
  requestText(req) {
    return new Promise((resolve) => {
      store.openTextPrompt(req, resolve);
    });
  },
};
ctx.provideService<UiPromptService>("ui:prompt", uiPrompt);
```

Add `"ui:prompt"` to the `provides` array in the plugin metadata:

```tsx
services: {
  provides: ["ui:channel", "ui:completion-source", "ui:status", "ui:theme", "ui:tool-renderer", "ui:prompt"],
  consumes: ["events:vocabulary"],
},
```

- [ ] **Step 4: Update `public.d.ts`**

Open `plugins/llm-tui/public.d.ts`. Add to the existing re-export block from `llm-contracts/public`:

```ts
export type {
  UiPromptService,
  UiPromptOption,
  UiPromptOptionsRequest,
  UiPromptTextRequest,
} from "llm-contracts/public";
```

- [ ] **Step 5: Verify passing**

Run: `cd plugins/llm-tui && bun test index.test.ts`

Expected: all pass.

- [ ] **Step 6: Commit**

```sh
git add plugins/llm-tui/
git commit -m "feat(llm-tui): provide ui:prompt service backed by TuiStore prompt slice"
```

---

### Task 12: Add `ui:prompt` no-op impl to fallback channel

**Files:**
- Modify: `plugins/llm-tui/fallback.ts`
- Modify: `plugins/llm-tui/fallback.test.ts`

- [ ] **Step 1: Write failing test**

Open `plugins/llm-tui/fallback.test.ts`. Append:

```ts
import type { UiPromptService } from "llm-contracts/public";
import { createFallbackPrompt } from "./fallback.ts";

describe("fallback ui:prompt", () => {
  it("requestOption resolves to cancelId if set", async () => {
    const svc: UiPromptService = createFallbackPrompt();
    const out = await svc.requestOption({
      title: "T",
      body: "B",
      options: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
      cancelId: "a",
    });
    expect(out).toEqual({ id: "a" });
  });

  it("requestOption falls back to last option when cancelId absent", async () => {
    const svc = createFallbackPrompt();
    const out = await svc.requestOption({
      title: "T",
      body: "B",
      options: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
    });
    expect(out).toEqual({ id: "b" });
  });

  it("requestText resolves to empty string", async () => {
    const svc = createFallbackPrompt();
    await expect(svc.requestText({ title: "T" })).resolves.toBe("");
  });
});
```

If `createFallbackPrompt` doesn't exist as a named export yet, that's expected — Step 3 adds it.

- [ ] **Step 2: Verify failing**

Run: `cd plugins/llm-tui && bun test fallback.test.ts`

Expected: import failure.

- [ ] **Step 3: Implement**

Open `plugins/llm-tui/fallback.ts`. Add at the end:

```ts
import type { UiPromptService } from "llm-contracts/public";

export function createFallbackPrompt(): UiPromptService {
  return {
    async requestOption(req) {
      const cancelId = req.cancelId ?? req.options.at(-1)?.id;
      if (cancelId === undefined) {
        // Empty options — caller bug; resolve with synthetic empty id.
        return { id: "" };
      }
      return { id: cancelId };
    },
    async requestText() {
      return "";
    },
  };
}
```

- [ ] **Step 4: Wire it into the fallback path**

Find where `createFallbackChannel` is called in `index.tsx` (the non-TTY branch). Where the other fallback services are provided (`ui:channel`, etc.), add:

```tsx
ctx.provideService<UiPromptService>("ui:prompt", createFallbackPrompt());
```

If `index.tsx` already branches "TTY vs no-TTY" and the TTY path is what was wired in Task 11, ensure the no-TTY branch provides the fallback impl and not the real one. Mirror exactly how the other UI services are split between TTY and fallback.

If there is no explicit no-TTY branch (the TUI mounts unconditionally), just leave the fallback function exported for future use and skip wiring; the tests in Step 1 already cover its behavior in isolation.

- [ ] **Step 5: Verify passing**

Run: `cd plugins/llm-tui && bun test`

Expected: all pass.

- [ ] **Step 6: Commit**

```sh
git add plugins/llm-tui/fallback.ts plugins/llm-tui/fallback.test.ts plugins/llm-tui/index.tsx
git commit -m "feat(llm-tui): add ui:prompt fallback that auto-resolves to cancelId/empty"
```

---

## Phase F — `llm-tool-approval` plugin: scaffold + pure logic

### Task 13: Scaffold the plugin

**Files:**
- Create: `plugins/llm-tool-approval/package.json`
- Create: `plugins/llm-tool-approval/tsconfig.json`
- Create: `plugins/llm-tool-approval/README.md`
- Create: `plugins/llm-tool-approval/CLAUDE.md`
- Create: `plugins/llm-tool-approval/defaults.json`
- Create: `plugins/llm-tool-approval/index.ts` (skeleton)

- [ ] **Step 1: Make the directory**

Run:

```sh
mkdir -p plugins/llm-tool-approval/test
```

- [ ] **Step 2: Write `package.json`**

Create `plugins/llm-tool-approval/package.json`:

```json
{
  "name": "llm-tool-approval",
  "version": "0.1.0",
  "description": "Per-tool-call approval gate. Prompts the user (Approve Once / Always / Domain Always / Deny) before any tool call runs.",
  "type": "module",
  "exports": {
    ".": "./index.ts"
  },
  "keywords": [
    "kaizen-plugin"
  ],
  "dependencies": {
    "llm-contracts": "workspace:*"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "^5.4.0"
  }
}
```

- [ ] **Step 3: Write `tsconfig.json`**

Create `plugins/llm-tool-approval/tsconfig.json` (copy from `plugins/llm-memory/tsconfig.json`):

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "lib": ["ES2022"],
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "types": ["bun"]
  },
  "include": ["**/*.ts"]
}
```

- [ ] **Step 4: Write `defaults.json`**

Create `plugins/llm-tool-approval/defaults.json`:

```json
{
  "allow": [
    "execute_typescript",
    "llm-skills:*",
    "llm-memory:get",
    "llm-memory:list",
    "llm-memory:search"
  ],
  "deny": []
}
```

- [ ] **Step 5: Write `README.md`**

Create `plugins/llm-tool-approval/README.md`:

````markdown
# llm-tool-approval

Per-tool-call approval gate for the openai-compatible harness. Subscribes to `tool:before-execute` and prompts the user with four options: Approve Once, Approve Always, Approve Domain Always, Deny. Persists allow/deny rules to project or global config, with a shipped baseline of safe defaults.

## Config

Three sources, all optional. Schema: `{ "allow": string[], "deny": string[] }`.

| Path | Role |
|---|---|
| `<plugin>/defaults.json` | Shipped baseline |
| `~/.kaizen/plugins/llm-tool-approval/config.json` | Global user-managed |
| `<cwd>/.kaizen/plugins/llm-tool-approval/config.json` | Project user-managed; prompt-driven writes go here |

### Match semantics

- Exact tool name (`fs:read_file`).
- Prefix glob (`mcp:github:*`, `fs:*`, or catch-all `*`). `*` is valid only as a trailing segment after `:`, or alone.
- Match rule: any source's `deny` cancels (no prompt); else any source's `allow` passes (no prompt); else prompt.

### Domain derivation

The "Approve Domain Always" option derives from the tool name by taking everything up to the last `:` and appending `:*`. `mcp:github:list_issues` → `mcp:github:*`. Tools with no `:` have no domain; the option is hidden.

## Slash commands

- `/approval:pause` — pause prompting for this session.
- `/approval:resume` — resume.
- `/approval:status` — print pause state, per-source rule counts, effective merged rules, write target.

## Status item

`approval: request` (active) or `approval: paused`.

## Wiring

Manifest order matters: load **after** `llm-hooks-shell` so hooks pre-empt the prompt.

```
"official/llm-hooks-shell@0.1.1",
"official/llm-tool-approval@0.1.0",
```
````

- [ ] **Step 6: Write `CLAUDE.md`**

Create `plugins/llm-tool-approval/CLAUDE.md`:

```markdown
# Working in `llm-tool-approval`

Notes for agents editing this plugin. See `README.md` for the user-facing contract.

## Module map

```
index.ts        Plugin lifecycle. Reads services, wires the subscriber + slash + status item.
                Only file that touches `ctx`.
matcher.ts      Pure: domain derivation + match logic (exact, prefix glob, catch-all).
config.ts      Pure functions + small fs surface. Loads three sources, picks write target,
                atomic write, dedupe + sort.
subscriber.ts  Pure handler. DI for ui:prompt, matcher, config, channel/notice helpers.
                Implements the tool:before-execute logic.
slash.ts       Three slash commands. Pure aside from the slash-registry registration call.
defaults.json  Shipped baseline allow-list.
```

## Invariants

- **Subscriber is `async` and the bus dispatch is sequential.** Concurrent tool calls naturally serialize through one prompt at a time.
- **Pre-emption check first.** If `payload.args === CANCEL_TOOL` on entry, return immediately. Another subscriber already cancelled this call; do not prompt.
- **Deny wins regardless of source.** Resolution is `deny → allow → prompt`. A `deny` in any source short-circuits.
- **Prompt is the only place that writes config.** Approve Once does not touch disk. "Approve Always" / "Approve Domain Always" append to project config (or global if no project).
- **Write failure ≠ approval failure.** If the persistence write fails, still resolve as approve-once and write a notice. The foreground intent is the user's decision; bookkeeping is best-effort.
- **No `useService("ui:prompt")` until `harness:start`.** Service lookup at `setup()` may race with `llm-tui`'s `provideService`. Defer to `harness:start` like `llm-tools-registry` does.

## Local deploy

```sh
PLUGIN=llm-tool-approval
VERSION=$(jq -r .version plugins/$PLUGIN/package.json)
INSTALL_DIR=~/.kaizen/marketplaces/official/plugins/${PLUGIN}@${VERSION}
(cd plugins/$PLUGIN && bun build --target=bun --outfile=dist/index.js index.ts)
mkdir -p "$INSTALL_DIR/dist"
cp plugins/$PLUGIN/dist/index.js "$INSTALL_DIR/dist/index.js"
rsync -a --exclude='node_modules' --exclude='dist' plugins/$PLUGIN/ "$INSTALL_DIR/"
```
```

- [ ] **Step 7: Write skeleton `index.ts`**

Create `plugins/llm-tool-approval/index.ts`:

```ts
import type { KaizenPlugin } from "kaizen/types";

const plugin: KaizenPlugin = {
  name: "llm-tool-approval",
  apiVersion: "3.0.0",
  permissions: { tier: "unscoped" },
  services: {
    consumes: ["ui:prompt", "ui:tool-renderer", "ui:channel", "ui:status", "slash:registry"],
  },

  async setup(_ctx) {
    // Wired in Task 18.
  },
};

export default plugin;
```

- [ ] **Step 8: Install workspace deps**

Run: `bun install` from the repo root.

Expected: bun adds `llm-tool-approval` to the workspace and links `llm-contracts` into its `node_modules`.

- [ ] **Step 9: Smoke-check the scaffold**

Run: `cd plugins/llm-tool-approval && bunx tsc --noEmit`

Expected: exit 0, no diagnostics.

- [ ] **Step 10: Commit**

```sh
git add plugins/llm-tool-approval/
git commit -m "feat(llm-tool-approval): scaffold plugin (package.json, defaults, README, CLAUDE.md, index skeleton)"
```

---

### Task 14: Implement `matcher.ts`

**Files:**
- Create: `plugins/llm-tool-approval/matcher.ts`
- Create: `plugins/llm-tool-approval/test/matcher.test.ts`

- [ ] **Step 1: Write failing tests**

Create `plugins/llm-tool-approval/test/matcher.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { matches, deriveDomain, matchesAny } from "../matcher.ts";

describe("matches", () => {
  it("exact name", () => {
    expect(matches("fs:read_file", "fs:read_file")).toBe(true);
    expect(matches("fs:read_file", "fs:read_files")).toBe(false);
    expect(matches("fs:read_file", "fs:write_file")).toBe(false);
  });

  it("prefix glob with trailing :*", () => {
    expect(matches("mcp:github:list_issues", "mcp:github:*")).toBe(true);
    expect(matches("mcp:github:create_issue", "mcp:github:*")).toBe(true);
    expect(matches("mcp:githubactions:run", "mcp:github:*")).toBe(false);
    expect(matches("mcp:github:", "mcp:github:*")).toBe(true); // empty last segment
  });

  it("multi-level prefix glob", () => {
    expect(matches("a:b:c:d", "a:b:c:*")).toBe(true);
    expect(matches("a:b:cd", "a:b:c:*")).toBe(false);
  });

  it("catch-all *", () => {
    expect(matches("anything", "*")).toBe(true);
    expect(matches("mcp:github:list", "*")).toBe(true);
  });

  it("malformed rule (no :*) does not glob", () => {
    // A rule "fs*" is not a valid glob in our model; only "*" alone or
    // "<prefix>:*" with a trailing : segment. Treat as exact.
    expect(matches("fs:read_file", "fs*")).toBe(false);
  });

  it("empty / non-string tool names match nothing", () => {
    expect(matches("", "fs:*")).toBe(false);
    expect(matches("", "*")).toBe(true);  // catch-all is universal
  });
});

describe("deriveDomain", () => {
  it("returns prefix:* for names with a colon", () => {
    expect(deriveDomain("mcp:github:list_issues")).toBe("mcp:github:*");
    expect(deriveDomain("fs:read_file")).toBe("fs:*");
    expect(deriveDomain("a:b:c:d")).toBe("a:b:c:*");
  });

  it("returns null for names without a colon", () => {
    expect(deriveDomain("execute_typescript")).toBeNull();
    expect(deriveDomain("")).toBeNull();
  });

  it("handles trailing colon", () => {
    expect(deriveDomain("fs:")).toBe("fs:*");
  });
});

describe("matchesAny", () => {
  it("returns true when any rule matches", () => {
    expect(matchesAny("fs:read_file", ["foo", "fs:*", "bar"])).toBe(true);
  });
  it("returns false when no rule matches", () => {
    expect(matchesAny("fs:read_file", ["foo", "bar"])).toBe(false);
  });
  it("returns false on empty rule list", () => {
    expect(matchesAny("fs:read_file", [])).toBe(false);
  });
});
```

- [ ] **Step 2: Verify failing**

Run: `cd plugins/llm-tool-approval && bun test test/matcher.test.ts`

Expected: import failure — `matcher.ts` doesn't exist.

- [ ] **Step 3: Implement `matcher.ts`**

Create `plugins/llm-tool-approval/matcher.ts`:

```ts
/**
 * True iff `name` matches `rule`. Rule is either an exact string, the
 * catch-all `*`, or a prefix glob of the form `<prefix>:*` where the `*` is
 * the entire final segment.
 */
export function matches(name: string, rule: string): boolean {
  if (typeof name !== "string") return false;
  if (typeof rule !== "string") return false;
  if (rule === "*") return true;
  if (rule.endsWith(":*")) {
    const prefix = rule.slice(0, -1); // keep the trailing colon: "fs:" from "fs:*"
    return name.startsWith(prefix);
  }
  return name === rule;
}

export function matchesAny(name: string, rules: ReadonlyArray<string>): boolean {
  for (const r of rules) {
    if (matches(name, r)) return true;
  }
  return false;
}

/**
 * Returns the "domain" glob for a tool name (everything up to and including
 * the last colon, then `*`). `mcp:github:list_issues` → `mcp:github:*`.
 * Returns null when the name has no `:` (no derivable domain).
 */
export function deriveDomain(name: string): string | null {
  if (typeof name !== "string" || name.length === 0) return null;
  const i = name.lastIndexOf(":");
  if (i < 0) return null;
  return name.slice(0, i + 1) + "*";
}
```

- [ ] **Step 4: Verify passing**

Run: `cd plugins/llm-tool-approval && bun test test/matcher.test.ts`

Expected: all pass.

- [ ] **Step 5: Commit**

```sh
git add plugins/llm-tool-approval/matcher.ts plugins/llm-tool-approval/test/matcher.test.ts
git commit -m "feat(llm-tool-approval): matcher (exact / prefix-glob / catch-all) and deriveDomain"
```

---

### Task 15: Implement `config.ts`

**Files:**
- Create: `plugins/llm-tool-approval/config.ts`
- Create: `plugins/llm-tool-approval/test/config.test.ts`

- [ ] **Step 1: Write failing tests**

Create `plugins/llm-tool-approval/test/config.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadSource,
  mergeRules,
  pickWriteTarget,
  appendAllowAtomic,
  ConfigFile,
} from "../config.ts";

let tmp: string;
beforeEach(() => {
  tmp = join(tmpdir(), `llm-tool-approval-test-${Date.now()}-${Math.random()}`);
  mkdirSync(tmp, { recursive: true });
});
afterEach(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

describe("loadSource", () => {
  it("returns empty lists when file missing", () => {
    const out = loadSource(join(tmp, "missing.json"));
    expect(out).toEqual({ allow: [], deny: [] });
  });

  it("parses valid JSON", () => {
    const p = join(tmp, "ok.json");
    writeFileSync(p, JSON.stringify({ allow: ["fs:*"], deny: ["fs:delete"] }));
    expect(loadSource(p)).toEqual({ allow: ["fs:*"], deny: ["fs:delete"] });
  });

  it("returns empty + logs when JSON is malformed", () => {
    const p = join(tmp, "bad.json");
    writeFileSync(p, "{not json");
    const logs: string[] = [];
    expect(loadSource(p, (m) => logs.push(m))).toEqual({ allow: [], deny: [] });
    expect(logs.length).toBeGreaterThan(0);
  });

  it("treats missing allow/deny as empty arrays", () => {
    const p = join(tmp, "partial.json");
    writeFileSync(p, JSON.stringify({ allow: ["x"] }));
    expect(loadSource(p)).toEqual({ allow: ["x"], deny: [] });
  });
});

describe("mergeRules", () => {
  it("unions all sources", () => {
    const out = mergeRules([
      { allow: ["a"], deny: ["x"] },
      { allow: ["b"], deny: [] },
      { allow: ["a"], deny: ["y"] },
    ]);
    expect(new Set(out.allow)).toEqual(new Set(["a", "b"]));
    expect(new Set(out.deny)).toEqual(new Set(["x", "y"]));
  });
});

describe("pickWriteTarget", () => {
  it("returns project path when <cwd>/.kaizen exists", () => {
    mkdirSync(join(tmp, ".kaizen"), { recursive: true });
    const t = pickWriteTarget({ cwd: tmp, home: "/home/u" });
    expect(t).toBe(join(tmp, ".kaizen", "plugins", "llm-tool-approval", "config.json"));
  });

  it("returns global path when no project context", () => {
    const t = pickWriteTarget({ cwd: tmp, home: "/home/u" });
    expect(t).toBe(join("/home/u", ".kaizen", "plugins", "llm-tool-approval", "config.json"));
  });
});

describe("appendAllowAtomic", () => {
  it("creates file if missing and writes sorted, deduped entries", () => {
    const target = join(tmp, ".kaizen", "plugins", "llm-tool-approval", "config.json");
    appendAllowAtomic(target, "fs:read_file");
    const raw = JSON.parse(readFileSync(target, "utf8"));
    expect(raw).toEqual({ allow: ["fs:read_file"], deny: [] });
  });

  it("dedupes and sorts on subsequent writes", () => {
    const target = join(tmp, "cfg.json");
    appendAllowAtomic(target, "b");
    appendAllowAtomic(target, "a");
    appendAllowAtomic(target, "a"); // duplicate
    const raw = JSON.parse(readFileSync(target, "utf8"));
    expect(raw.allow).toEqual(["a", "b"]);
  });

  it("preserves existing deny list", () => {
    const target = join(tmp, "cfg.json");
    writeFileSync(target, JSON.stringify({ allow: [], deny: ["dangerous"] }));
    appendAllowAtomic(target, "fs:read_file");
    const raw = JSON.parse(readFileSync(target, "utf8"));
    expect(raw).toEqual({ allow: ["fs:read_file"], deny: ["dangerous"] });
  });

  it("does not leave a .tmp file on success", () => {
    const target = join(tmp, "cfg.json");
    appendAllowAtomic(target, "x");
    expect(existsSync(target + ".tmp")).toBe(false);
  });
});
```

- [ ] **Step 2: Verify failing**

Run: `cd plugins/llm-tool-approval && bun test test/config.test.ts`

Expected: import failure.

- [ ] **Step 3: Implement `config.ts`**

Create `plugins/llm-tool-approval/config.ts`:

```ts
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ConfigFile {
  allow: string[];
  deny: string[];
}

const EMPTY: ConfigFile = { allow: [], deny: [] };

export function loadSource(path: string, log?: (msg: string) => void): ConfigFile {
  if (!existsSync(path)) return { allow: [], deny: [] };
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    log?.(`llm-tool-approval: failed to read ${path}: ${(err as Error).message}`);
    return { allow: [], deny: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log?.(`llm-tool-approval: malformed JSON at ${path}: ${(err as Error).message}`);
    return { allow: [], deny: [] };
  }
  const allow = Array.isArray((parsed as any)?.allow) ? ((parsed as any).allow as unknown[]).filter((x): x is string => typeof x === "string") : [];
  const deny = Array.isArray((parsed as any)?.deny) ? ((parsed as any).deny as unknown[]).filter((x): x is string => typeof x === "string") : [];
  return { allow, deny };
}

export function mergeRules(sources: ReadonlyArray<ConfigFile>): ConfigFile {
  const allow = new Set<string>();
  const deny = new Set<string>();
  for (const s of sources) {
    for (const a of s.allow) allow.add(a);
    for (const d of s.deny) deny.add(d);
  }
  return { allow: [...allow], deny: [...deny] };
}

export function pickWriteTarget(env: { cwd: string; home: string }): string {
  const projectKaizen = join(env.cwd, ".kaizen");
  if (existsSync(projectKaizen)) {
    return join(projectKaizen, "plugins", "llm-tool-approval", "config.json");
  }
  return join(env.home, ".kaizen", "plugins", "llm-tool-approval", "config.json");
}

/**
 * Appends `entry` to the `allow` list at `path`. Creates the file (and parent
 * dirs) if missing. Dedupes + sorts entries on write. Atomic via tmp+rename.
 * Throws on disk failure; the caller decides the foreground behavior.
 */
export function appendAllowAtomic(path: string, entry: string): void {
  const current = existsSync(path) ? loadSource(path) : { ...EMPTY };
  const next: ConfigFile = {
    allow: dedupeSort([...current.allow, entry]),
    deny: dedupeSort(current.deny),
  };
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

function dedupeSort(arr: string[]): string[] {
  return [...new Set(arr)].sort();
}
```

- [ ] **Step 4: Verify passing**

Run: `cd plugins/llm-tool-approval && bun test test/config.test.ts`

Expected: all pass.

- [ ] **Step 5: Commit**

```sh
git add plugins/llm-tool-approval/config.ts plugins/llm-tool-approval/test/config.test.ts
git commit -m "feat(llm-tool-approval): config layer (load/merge/pick-target/atomic-append)"
```

---

### Task 16: Implement `subscriber.ts`

**Files:**
- Create: `plugins/llm-tool-approval/subscriber.ts`
- Create: `plugins/llm-tool-approval/test/subscriber.test.ts`

- [ ] **Step 1: Write failing tests**

Create `plugins/llm-tool-approval/test/subscriber.test.ts`:

```ts
import { describe, it, expect, mock } from "bun:test";
import { CANCEL_TOOL } from "llm-events";
import type { ToolBeforeExecutePayload } from "llm-contracts/public";
import { makeSubscriber, type SubscriberDeps } from "../subscriber.ts";

function makeDeps(over: Partial<SubscriberDeps> = {}): SubscriberDeps {
  return {
    isPaused: () => false,
    rules: () => ({ allow: [], deny: [] }),
    summarize: (name: string, args: unknown) => `${name}\n${JSON.stringify(args)}`,
    prompt: {
      requestOption: async () => ({ id: "approve-once" as const }),
      requestText: async () => "",
    },
    persistAllow: () => {},
    writeNotice: () => {},
    log: () => {},
    ...over,
  };
}

const mkPayload = (over: Partial<ToolBeforeExecutePayload> = {}): ToolBeforeExecutePayload => ({
  name: "fs:read_file",
  args: { path: "/tmp/x" },
  callId: "c1",
  ...over,
});

describe("subscriber — pre-emption / paused / matching", () => {
  it("returns immediately when payload is already cancelled", async () => {
    const promptSpy = mock(async () => ({ id: "approve-once" as const }));
    const sub = makeSubscriber(makeDeps({ prompt: { requestOption: promptSpy, requestText: async () => "" } }));
    const p = mkPayload({ args: CANCEL_TOOL });
    await sub(p);
    expect(promptSpy).not.toHaveBeenCalled();
    expect(p.args).toBe(CANCEL_TOOL);
  });

  it("paused → no-op (does not prompt, does not mutate args)", async () => {
    const promptSpy = mock(async () => ({ id: "approve-once" as const }));
    const sub = makeSubscriber(
      makeDeps({ isPaused: () => true, prompt: { requestOption: promptSpy, requestText: async () => "" } }),
    );
    const p = mkPayload();
    await sub(p);
    expect(promptSpy).not.toHaveBeenCalled();
    expect(p.args).toEqual({ path: "/tmp/x" });
  });

  it("deny rule short-circuits → CANCEL_TOOL with config reason", async () => {
    const noticeSpy = mock(() => {});
    const sub = makeSubscriber(makeDeps({
      rules: () => ({ allow: [], deny: ["fs:read_file"] }),
      writeNotice: noticeSpy,
    }));
    const p = mkPayload();
    await sub(p);
    expect(p.args).toBe(CANCEL_TOOL);
    expect(p.cancelReason).toBe("Denied by allow/deny config rule.");
    expect(noticeSpy).toHaveBeenCalled();
  });

  it("allow rule short-circuits → no prompt, no mutation", async () => {
    const promptSpy = mock(async () => ({ id: "approve-once" as const }));
    const sub = makeSubscriber(makeDeps({
      rules: () => ({ allow: ["fs:*"], deny: [] }),
      prompt: { requestOption: promptSpy, requestText: async () => "" },
    }));
    const p = mkPayload();
    await sub(p);
    expect(promptSpy).not.toHaveBeenCalled();
    expect(p.args).toEqual({ path: "/tmp/x" });
  });

  it("deny wins over allow within the same source", async () => {
    const sub = makeSubscriber(makeDeps({
      rules: () => ({ allow: ["fs:*"], deny: ["fs:read_file"] }),
    }));
    const p = mkPayload();
    await sub(p);
    expect(p.args).toBe(CANCEL_TOOL);
  });
});

describe("subscriber — prompt outcomes", () => {
  it("approve-once → no-op", async () => {
    const persistSpy = mock(() => {});
    const sub = makeSubscriber(makeDeps({
      prompt: { requestOption: async () => ({ id: "approve-once" }), requestText: async () => "" },
      persistAllow: persistSpy,
    }));
    const p = mkPayload();
    await sub(p);
    expect(p.args).toEqual({ path: "/tmp/x" });
    expect(persistSpy).not.toHaveBeenCalled();
  });

  it("approve-always → persists exact name to allow", async () => {
    const persisted: string[] = [];
    const sub = makeSubscriber(makeDeps({
      prompt: { requestOption: async () => ({ id: "approve-always" }), requestText: async () => "" },
      persistAllow: (entry) => { persisted.push(entry); },
    }));
    const p = mkPayload();
    await sub(p);
    expect(persisted).toEqual(["fs:read_file"]);
    expect(p.args).toEqual({ path: "/tmp/x" });
  });

  it("approve-domain-always → persists domain glob", async () => {
    const persisted: string[] = [];
    const sub = makeSubscriber(makeDeps({
      prompt: { requestOption: async () => ({ id: "approve-domain-always" }), requestText: async () => "" },
      persistAllow: (entry) => { persisted.push(entry); },
    }));
    const p = mkPayload({ name: "mcp:github:list_issues" });
    await sub(p);
    expect(persisted).toEqual(["mcp:github:*"]);
  });

  it("approve-domain-always falls through to no-op when name has no domain", async () => {
    const persisted: string[] = [];
    const logs: string[] = [];
    const sub = makeSubscriber(makeDeps({
      // The prompt only offers this option if a domain exists; if somehow a
      // caller returns it for a no-domain name, fall back to no-op (same
      // effect as approve-once) and log a warning. Test asserts no crash and
      // no persistence.
      prompt: { requestOption: async () => ({ id: "approve-domain-always" }), requestText: async () => "" },
      persistAllow: (entry) => { persisted.push(entry); },
      log: (msg) => { logs.push(msg); },
    }));
    const p = mkPayload({ name: "execute_typescript", args: { code: "x" } });
    await sub(p);
    expect(persisted).toEqual([]);
    expect(p.args).toEqual({ code: "x" }); // unchanged
    expect(logs.some((l) => l.includes("approve-domain-always"))).toBe(true);
  });

  it("deny without reason → CANCEL_TOOL with default reason", async () => {
    const sub = makeSubscriber(makeDeps({
      prompt: { requestOption: async () => ({ id: "deny" }), requestText: async () => "" },
    }));
    const p = mkPayload();
    await sub(p);
    expect(p.args).toBe(CANCEL_TOOL);
    expect(p.cancelReason).toBe("User denied this tool call.");
  });

  it("deny with reason → CANCEL_TOOL with user reason", async () => {
    const sub = makeSubscriber(makeDeps({
      prompt: { requestOption: async () => ({ id: "deny", text: "feels dangerous" }), requestText: async () => "" },
    }));
    const p = mkPayload();
    await sub(p);
    expect(p.args).toBe(CANCEL_TOOL);
    expect(p.cancelReason).toBe("feels dangerous");
  });

  it("approve-always with persistence failure → notice + approve-once outcome", async () => {
    const notices: string[] = [];
    const sub = makeSubscriber(makeDeps({
      prompt: { requestOption: async () => ({ id: "approve-always" }), requestText: async () => "" },
      persistAllow: () => { throw new Error("disk full"); },
      writeNotice: (msg) => { notices.push(msg); },
    }));
    const p = mkPayload();
    await sub(p);
    expect(p.args).toEqual({ path: "/tmp/x" });
    expect(notices.some((m) => m.includes("Failed to persist") && m.includes("disk full"))).toBe(true);
  });
});

describe("subscriber — prompt construction", () => {
  it("hides Approve Domain Always when name has no colon", async () => {
    let captured: any = null;
    const sub = makeSubscriber(makeDeps({
      prompt: {
        requestOption: async (req) => { captured = req; return { id: "approve-once" }; },
        requestText: async () => "",
      },
    }));
    await sub(mkPayload({ name: "execute_typescript" }));
    const optionIds = captured.options.map((o: any) => o.id);
    expect(optionIds).not.toContain("approve-domain-always");
    expect(optionIds).toEqual(expect.arrayContaining(["approve-once", "approve-always", "deny"]));
  });

  it("includes Approve Domain Always when name has a domain", async () => {
    let captured: any = null;
    const sub = makeSubscriber(makeDeps({
      prompt: {
        requestOption: async (req) => { captured = req; return { id: "approve-once" }; },
        requestText: async () => "",
      },
    }));
    await sub(mkPayload({ name: "mcp:github:list_issues" }));
    const optionIds = captured.options.map((o: any) => o.id);
    expect(optionIds).toContain("approve-domain-always");
    const dom = captured.options.find((o: any) => o.id === "approve-domain-always");
    expect(dom.label).toContain("mcp:github:*");
  });

  it("body is the summarize() output", async () => {
    let captured: any = null;
    const sub = makeSubscriber(makeDeps({
      summarize: () => "SUMMARY",
      prompt: {
        requestOption: async (req) => { captured = req; return { id: "approve-once" }; },
        requestText: async () => "",
      },
    }));
    await sub(mkPayload());
    expect(captured.body).toBe("SUMMARY");
  });

  it("Deny option has expandsTo for inline reason", async () => {
    let captured: any = null;
    const sub = makeSubscriber(makeDeps({
      prompt: {
        requestOption: async (req) => { captured = req; return { id: "approve-once" }; },
        requestText: async () => "",
      },
    }));
    await sub(mkPayload());
    const deny = captured.options.find((o: any) => o.id === "deny");
    expect(deny.expandsTo).toEqual({ kind: "text", placeholder: "Reason (optional)" });
  });
});
```

- [ ] **Step 2: Verify failing**

Run: `cd plugins/llm-tool-approval && bun test test/subscriber.test.ts`

Expected: import failure — `subscriber.ts` doesn't exist.

- [ ] **Step 3: Implement `subscriber.ts`**

Create `plugins/llm-tool-approval/subscriber.ts`:

```ts
import { CANCEL_TOOL } from "llm-events";
import type {
  ToolBeforeExecutePayload,
  UiPromptOptionsRequest,
  UiPromptService,
} from "llm-contracts/public";
import { deriveDomain, matchesAny } from "./matcher.ts";
import type { ConfigFile } from "./config.ts";

export interface SubscriberDeps {
  /** Returns true when the gate is paused for the session. */
  isPaused: () => boolean;
  /** Resolves the *current* effective rules (merge of all 3 sources). Called per event. */
  rules: () => ConfigFile;
  /** Human-readable summary of (name, args) for the prompt body. */
  summarize: (name: string, args: unknown) => string;
  /** ui:prompt service handle. */
  prompt: Pick<UiPromptService, "requestOption" | "requestText">;
  /**
   * Persists an entry to the `allow` list at the chosen write target.
   * Throws on disk failure; the subscriber catches and falls through to
   * approve-once with a notice.
   */
  persistAllow: (entry: string) => void;
  /** Write a notice line into the chat transcript. */
  writeNotice: (text: string) => void;
  /** Diagnostic logger (silent in tests by default). */
  log: (msg: string) => void;
}

export type Subscriber = (payload: ToolBeforeExecutePayload) => Promise<void>;

const DENY_DEFAULT_REASON = "User denied this tool call.";
const DENY_BY_RULE_REASON = "Denied by allow/deny config rule.";

export function makeSubscriber(deps: SubscriberDeps): Subscriber {
  return async (payload) => {
    // 1. Pre-emption check: another subscriber already cancelled.
    if (payload.args === CANCEL_TOOL) return;

    // 2. Paused → no-op.
    if (deps.isPaused()) return;

    // 3. Resolve current rules.
    const { allow, deny } = deps.rules();

    if (matchesAny(payload.name, deny)) {
      payload.args = CANCEL_TOOL;
      payload.cancelReason = DENY_BY_RULE_REASON;
      deps.writeNotice(`✗ approval gate: ${payload.name} denied by rule`);
      return;
    }
    if (matchesAny(payload.name, allow)) {
      return;
    }

    // 4. Prompt.
    const domain = deriveDomain(payload.name);
    const options: UiPromptOptionsRequest["options"] = [
      { id: "approve-once",  label: `Approve Once          (${payload.name})` },
      { id: "approve-always", label: `Approve Always        (${payload.name})` },
      ...(domain ? [{ id: "approve-domain-always", label: `Approve Domain Always (${domain})` }] : []),
      { id: "deny",          label: `Deny                  (Tab for reason)`, expandsTo: { kind: "text" as const, placeholder: "Reason (optional)" } },
    ];
    const req: UiPromptOptionsRequest = {
      title: "Approve tool call?",
      body: deps.summarize(payload.name, payload.args),
      options,
      defaultId: "approve-once",
      cancelId: "deny",
    };
    const result = await deps.prompt.requestOption(req);

    switch (result.id) {
      case "approve-once":
        return;
      case "approve-always":
        tryPersist(deps, payload.name);
        return;
      case "approve-domain-always": {
        if (!domain) {
          // Defensive: the prompt should not surface this option when no
          // domain exists, but if a fake returns it, fall through to no-op.
          deps.log(`approve-domain-always returned for nameless-domain tool ${payload.name}; treating as approve-once`);
          return;
        }
        tryPersist(deps, domain);
        return;
      }
      case "deny": {
        const reason = (result.text && result.text.trim()) || DENY_DEFAULT_REASON;
        payload.args = CANCEL_TOOL;
        payload.cancelReason = reason;
        const reasonSuffix = result.text && result.text.trim() ? ` (reason: ${result.text.trim()})` : "";
        deps.writeNotice(`✗ user denied ${payload.name}${reasonSuffix}`);
        return;
      }
      default:
        deps.log(`unrecognized prompt option: ${result.id}; treating as approve-once`);
        return;
    }
  };
}

function tryPersist(deps: SubscriberDeps, entry: string): void {
  try {
    deps.persistAllow(entry);
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    deps.writeNotice(`Failed to persist approval rule: ${msg}. This call was approved one-time.`);
  }
}
```

- [ ] **Step 4: Verify passing**

Run: `cd plugins/llm-tool-approval && bun test test/subscriber.test.ts`

Expected: all pass.

- [ ] **Step 5: Commit**

```sh
git add plugins/llm-tool-approval/subscriber.ts plugins/llm-tool-approval/test/subscriber.test.ts
git commit -m "feat(llm-tool-approval): subscriber handler (paused/deny/allow/prompt + outcomes)"
```

---

## Phase G — `llm-tool-approval`: slash commands + wiring

### Task 17: Implement `slash.ts`

**Files:**
- Create: `plugins/llm-tool-approval/slash.ts`
- Create: `plugins/llm-tool-approval/test/slash.test.ts`

- [ ] **Step 1: Write failing tests**

Create `plugins/llm-tool-approval/test/slash.test.ts`:

```ts
import { describe, it, expect, mock } from "bun:test";
import { registerSlashCommands, type SlashRegistryLike, type ApprovalState, type SlashDeps } from "../slash.ts";

function makeRegistry() {
  const registered: { manifest: any; handler: any }[] = [];
  const reg: SlashRegistryLike = {
    register(manifest, handler) {
      registered.push({ manifest, handler });
      return () => {
        const idx = registered.findIndex((r) => r.manifest.name === manifest.name);
        if (idx >= 0) registered.splice(idx, 1);
      };
    },
  };
  return { reg, registered };
}

function makeDeps(over: Partial<SlashDeps> = {}): SlashDeps {
  return {
    state: { paused: false },
    setStatus: () => {},
    rulesBySource: () => ({
      defaults: { allow: [], deny: [] },
      global: { allow: [], deny: [] },
      project: { allow: [], deny: [] },
    }),
    writeTarget: () => "/home/u/.kaizen/plugins/llm-tool-approval/config.json",
    ...over,
  };
}

const callHandler = async (handler: any, args = "") => {
  const printed: string[] = [];
  await handler({ args, print: async (t: string) => { printed.push(t); } });
  return printed;
};

describe("registerSlashCommands", () => {
  it("registers approval:pause, approval:resume, approval:status", () => {
    const { reg, registered } = makeRegistry();
    const deps = makeDeps();
    registerSlashCommands(reg, deps);
    const names = registered.map((r) => r.manifest.name).sort();
    expect(names).toEqual(["approval:pause", "approval:resume", "approval:status"]);
    expect(registered.every((r) => r.manifest.source === "plugin")).toBe(true);
  });

  it("approval:pause sets paused=true and updates status", async () => {
    const { reg, registered } = makeRegistry();
    const setStatus = mock(() => {});
    const deps = makeDeps({ setStatus });
    registerSlashCommands(reg, deps);
    const pause = registered.find((r) => r.manifest.name === "approval:pause")!.handler;
    const out = await callHandler(pause);
    expect(deps.state.paused).toBe(true);
    expect(setStatus).toHaveBeenCalledWith("paused");
    expect(out.join("\n")).toContain("paused");
  });

  it("approval:resume sets paused=false and updates status", async () => {
    const { reg, registered } = makeRegistry();
    const setStatus = mock(() => {});
    const deps = makeDeps({ setStatus });
    deps.state.paused = true;
    registerSlashCommands(reg, deps);
    const resume = registered.find((r) => r.manifest.name === "approval:resume")!.handler;
    const out = await callHandler(resume);
    expect(deps.state.paused).toBe(false);
    expect(setStatus).toHaveBeenCalledWith("request");
    expect(out.join("\n")).toContain("active");
  });

  it("approval:pause is idempotent (already paused → still paused)", async () => {
    const { reg, registered } = makeRegistry();
    const deps = makeDeps();
    deps.state.paused = true;
    registerSlashCommands(reg, deps);
    const pause = registered.find((r) => r.manifest.name === "approval:pause")!.handler;
    await callHandler(pause);
    expect(deps.state.paused).toBe(true);
  });

  it("approval:status prints pause state + per-source counts + merged + target", async () => {
    const { reg, registered } = makeRegistry();
    const deps = makeDeps({
      rulesBySource: () => ({
        defaults: { allow: ["x"], deny: [] },
        global:   { allow: ["y"], deny: ["bad"] },
        project:  { allow: ["x", "z"], deny: [] },
      }),
      writeTarget: () => "/proj/.kaizen/plugins/llm-tool-approval/config.json",
    });
    registerSlashCommands(reg, deps);
    const status = registered.find((r) => r.manifest.name === "approval:status")!.handler;
    const out = (await callHandler(status)).join("\n");
    expect(out).toContain("paused: false");
    expect(out).toContain("defaults: 1 allow, 0 deny");
    expect(out).toContain("global: 1 allow, 1 deny");
    expect(out).toContain("project: 2 allow, 0 deny");
    expect(out).toContain("/proj/.kaizen/plugins/llm-tool-approval/config.json");
    // Effective merged (deduped): allow=x,y,z deny=bad
    expect(out).toMatch(/effective allow.*x.*y.*z/);
    expect(out).toContain("effective deny");
  });
});
```

- [ ] **Step 2: Verify failing**

Run: `cd plugins/llm-tool-approval && bun test test/slash.test.ts`

Expected: import failure.

- [ ] **Step 3: Implement `slash.ts`**

Create `plugins/llm-tool-approval/slash.ts`:

```ts
import type { ConfigFile } from "./config.ts";

export interface SlashCommandManifestLike {
  name: string;
  description: string;
  source: "builtin" | "plugin";
  usage?: string;
}
export interface SlashCommandContextLike {
  args: string;
  print: (text: string) => Promise<void>;
}
export interface SlashRegistryLike {
  register(manifest: SlashCommandManifestLike, handler: (ctx: SlashCommandContextLike) => Promise<void>): () => void;
}

export interface ApprovalState { paused: boolean; }

export interface SlashDeps {
  state: ApprovalState;
  setStatus: (value: "request" | "paused") => void;
  rulesBySource: () => { defaults: ConfigFile; global: ConfigFile; project: ConfigFile };
  writeTarget: () => string;
}

export function registerSlashCommands(slash: SlashRegistryLike, deps: SlashDeps): Array<() => void> {
  const offs: Array<() => void> = [];

  offs.push(slash.register(
    { name: "approval:pause", description: "Pause the tool-call approval gate for this session.", source: "plugin" },
    async (ctx) => {
      deps.state.paused = true;
      deps.setStatus("paused");
      await ctx.print("Approval gate paused for this session.");
    },
  ));

  offs.push(slash.register(
    { name: "approval:resume", description: "Resume the tool-call approval gate.", source: "plugin" },
    async (ctx) => {
      deps.state.paused = false;
      deps.setStatus("request");
      await ctx.print("Approval gate active.");
    },
  ));

  offs.push(slash.register(
    { name: "approval:status", description: "Show approval-gate pause state, per-source rule counts, effective rules, and the next write target.", source: "plugin" },
    async (ctx) => {
      const src = deps.rulesBySource();
      const counts = (cfg: ConfigFile) => `${cfg.allow.length} allow, ${cfg.deny.length} deny`;
      const allow = dedupe([...src.defaults.allow, ...src.global.allow, ...src.project.allow]);
      const deny = dedupe([...src.defaults.deny, ...src.global.deny, ...src.project.deny]);
      const lines = [
        `paused: ${deps.state.paused}`,
        `sources:`,
        `  defaults: ${counts(src.defaults)}`,
        `  global: ${counts(src.global)}`,
        `  project: ${counts(src.project)}`,
        `effective allow: ${allow.join(", ") || "(none)"}`,
        `effective deny: ${deny.join(", ") || "(none)"}`,
        `next write target: ${deps.writeTarget()}`,
      ];
      await ctx.print(lines.join("\n"));
    },
  ));

  return offs;
}

function dedupe(arr: string[]): string[] {
  return [...new Set(arr)].sort();
}
```

- [ ] **Step 4: Verify passing**

Run: `cd plugins/llm-tool-approval && bun test test/slash.test.ts`

Expected: all pass.

- [ ] **Step 5: Commit**

```sh
git add plugins/llm-tool-approval/slash.ts plugins/llm-tool-approval/test/slash.test.ts
git commit -m "feat(llm-tool-approval): slash commands (approval:pause/resume/status)"
```

---

### Task 18: Wire `index.ts` (lifecycle)

**Files:**
- Modify: `plugins/llm-tool-approval/index.ts`
- Create: `plugins/llm-tool-approval/test/index.test.ts`

- [ ] **Step 1: Write failing lifecycle test**

Create `plugins/llm-tool-approval/test/index.test.ts`:

```ts
import { describe, it, expect, mock } from "bun:test";
import plugin from "../index.ts";
import type { ToolBeforeExecutePayload, UiPromptService, UiToolRendererService, UiChannelService } from "llm-contracts/public";

function makeFakeCtx(opts: { hasPrompt?: boolean; hasRenderer?: boolean; hasChannel?: boolean; hasSlash?: boolean } = {}) {
  const services = new Map<string, any>();
  const handlers: Record<string, ((p: any) => any)[]> = {};
  const emitted: { event: string; payload: any }[] = [];
  const statusEvents: any[] = [];
  const logs: string[] = [];
  const slashRegistered: any[] = [];

  if (opts.hasPrompt !== false) {
    const prompt: UiPromptService = {
      requestOption: mock(async (req: any) => ({ id: "approve-once" })),
      requestText: async () => "",
    };
    services.set("ui:prompt", prompt);
  }
  if (opts.hasRenderer !== false) {
    services.set("ui:tool-renderer", {
      register: () => () => {},
      summarize: (name: string, args: unknown) => `${name} ${JSON.stringify(args)}`,
    } satisfies UiToolRendererService);
  }
  if (opts.hasChannel !== false) {
    services.set("ui:channel", {
      writeOutput: () => {}, writeNotice: () => {}, writeUser: () => {},
      setBusy: () => {}, setBusyTiming: () => {}, updateBusyTokens: () => {}, incrementBusyTokens: () => {},
      readInput: async () => "", appendReasoning: () => {}, finalizeReasoning: () => {}, clearLiveThinking: () => {}, setInputDraft: () => {},
    } satisfies UiChannelService);
  }
  if (opts.hasSlash !== false) {
    services.set("slash:registry", {
      register(manifest: any, handler: any) {
        slashRegistered.push({ manifest, handler });
        return () => {};
      },
    });
  }

  const ctx: any = {
    consumeService: () => {},
    useService: (id: string) => {
      if (!services.has(id)) throw new Error(`no provider: ${id}`);
      return services.get(id);
    },
    on: (event: string, fn: (p: any) => any) => { (handlers[event] ??= []).push(fn); },
    emit: async (event: string, payload: any) => {
      emitted.push({ event, payload });
      for (const fn of handlers[event] ?? []) await fn(payload);
    },
    log: (msg: string) => { logs.push(msg); },
    config: {},
  };

  return { ctx, services, handlers, emitted, logs, slashRegistered, statusEvents };
}

describe("llm-tool-approval plugin", () => {
  it("has plugin metadata", () => {
    expect(plugin.name).toBe("llm-tool-approval");
    expect(plugin.services?.consumes).toEqual(expect.arrayContaining([
      "ui:prompt", "ui:tool-renderer", "ui:channel", "ui:status", "slash:registry",
    ]));
  });

  it("subscribes to tool:before-execute and prompts when no rule matches", async () => {
    const { ctx, services, handlers, emitted } = makeFakeCtx();
    await plugin.setup(ctx);
    // harness:start triggers the deferred wiring.
    await ctx.emit("harness:start", {});
    const sub = handlers["tool:before-execute"]?.[0];
    expect(sub).toBeDefined();
    const payload: ToolBeforeExecutePayload = { name: "mcp:github:list_issues", args: { state: "open" }, callId: "c1" };
    await sub(payload);
    // ui:prompt was consulted because no rule matches.
    const prompt = services.get("ui:prompt") as any;
    expect(prompt.requestOption).toHaveBeenCalled();
  });

  it("emits a status:item-update for the approval status item", async () => {
    const { ctx, emitted } = makeFakeCtx();
    await plugin.setup(ctx);
    await ctx.emit("harness:start", {});
    const statusUpdate = emitted.find((e) => e.event === "status:item-update" && e.payload?.id === "approval");
    expect(statusUpdate).toBeDefined();
    expect(statusUpdate!.payload.text).toMatch(/approval: (request|paused)/);
  });

  it("registers three slash commands", async () => {
    const { ctx, slashRegistered } = makeFakeCtx();
    await plugin.setup(ctx);
    await ctx.emit("harness:start", {});
    const names = slashRegistered.map((r: any) => r.manifest.name).sort();
    expect(names).toEqual(["approval:pause", "approval:resume", "approval:status"]);
  });

  it("auto-denies every call when ui:prompt is missing", async () => {
    const { ctx, handlers, logs } = makeFakeCtx({ hasPrompt: false });
    await plugin.setup(ctx);
    await ctx.emit("harness:start", {});
    const sub = handlers["tool:before-execute"]?.[0]!;
    const payload: ToolBeforeExecutePayload = { name: "fs:read_file", args: {}, callId: "c1" };
    await sub(payload);
    // CANCEL_TOOL is Symbol.for("kaizen.cancel"); compare via well-known symbol.
    expect(payload.args).toBe(Symbol.for("kaizen.cancel"));
    expect(payload.cancelReason).toContain("approval gate misconfigured");
    expect(logs.some((l) => l.includes("ui:prompt"))).toBe(true);
  });
});
```

- [ ] **Step 2: Verify failing**

Run: `cd plugins/llm-tool-approval && bun test test/index.test.ts`

Expected: failures — `setup` is empty; no subscriber, no slash commands, no status item.

- [ ] **Step 3: Implement `index.ts`**

Open `plugins/llm-tool-approval/index.ts` and replace contents:

```ts
import type { KaizenPlugin } from "kaizen/types";
import { CANCEL_TOOL } from "llm-events";
import type {
  ToolBeforeExecutePayload,
  UiPromptService,
  UiToolRendererService,
  UiChannelService,
} from "llm-contracts/public";
import { join } from "node:path";
import { homedir } from "node:os";
import defaultsRaw from "./defaults.json" with { type: "json" };
import {
  loadSource,
  mergeRules,
  pickWriteTarget,
  appendAllowAtomic,
  type ConfigFile,
} from "./config.ts";
import { makeSubscriber } from "./subscriber.ts";
import { registerSlashCommands, type SlashRegistryLike, type ApprovalState } from "./slash.ts";

const plugin: KaizenPlugin = {
  name: "llm-tool-approval",
  apiVersion: "3.0.0",
  permissions: { tier: "unscoped" },
  services: {
    consumes: ["ui:prompt", "ui:tool-renderer", "ui:channel", "ui:status", "slash:registry"],
  },

  async setup(ctx) {
    // Declare optional dependencies as topo hints; lookups happen at
    // harness:start so providers are guaranteed to be wired.
    ctx.consumeService("ui:prompt");
    ctx.consumeService("ui:tool-renderer");
    ctx.consumeService("ui:channel");
    ctx.consumeService("slash:registry");

    const state: ApprovalState = { paused: false };

    // Load config sources. defaults.json is bundled; the other two are
    // user-managed paths that may or may not exist.
    const home = homedir();
    const cwd = process.cwd();
    const globalPath = join(home, ".kaizen", "plugins", "llm-tool-approval", "config.json");
    const projectPath = join(cwd, ".kaizen", "plugins", "llm-tool-approval", "config.json");

    const defaultsCfg: ConfigFile = {
      allow: Array.isArray((defaultsRaw as any).allow) ? ((defaultsRaw as any).allow as string[]) : [],
      deny: Array.isArray((defaultsRaw as any).deny) ? ((defaultsRaw as any).deny as string[]) : [],
    };
    let globalCfg = loadSource(globalPath, ctx.log);
    let projectCfg = loadSource(projectPath, ctx.log);

    const reloadSources = () => {
      globalCfg = loadSource(globalPath, ctx.log);
      projectCfg = loadSource(projectPath, ctx.log);
    };

    const rulesBySource = () => ({ defaults: defaultsCfg, global: globalCfg, project: projectCfg });
    const rules = () => mergeRules([defaultsCfg, globalCfg, projectCfg]);

    const writeTarget = () => pickWriteTarget({ cwd, home });

    // Service lookups deferred to harness:start.
    let teardowns: Array<() => void> = [];

    ctx.on("harness:start", async () => {
      // ui:prompt — required. Without it, auto-deny everything.
      let uiPrompt: UiPromptService | null = null;
      try {
        uiPrompt = ctx.useService<UiPromptService>("ui:prompt");
      } catch (err) {
        ctx.log(`llm-tool-approval: ui:prompt service unavailable — every call will auto-deny. (${(err as Error).message})`);
      }

      // ui:tool-renderer — required (for summarize). Fall back to a JSON-only stringifier if absent.
      let summarize: (name: string, args: unknown) => string = (name, args) =>
        `${name}\n${safeJsonStringify(args)}`;
      try {
        const renderer = ctx.useService<UiToolRendererService>("ui:tool-renderer");
        summarize = (name, args) => renderer.summarize(name, args);
      } catch (err) {
        ctx.log(`llm-tool-approval: ui:tool-renderer missing — falling back to JSON stringify. (${(err as Error).message})`);
      }

      // ui:channel — used for writeNotice. Fall back to ctx.log if absent.
      let writeNotice: (text: string) => void = (text) => ctx.log(text);
      try {
        const channel = ctx.useService<UiChannelService>("ui:channel");
        writeNotice = (text) => channel.writeNotice(text);
      } catch { /* ignore */ }

      // Status item.
      const setStatus = (value: "request" | "paused") => {
        void ctx.emit("status:item-update", { id: "approval", text: `approval: ${value}`, priority: 50 });
      };
      setStatus("request");

      // Slash commands.
      try {
        const slash = ctx.useService<SlashRegistryLike>("slash:registry");
        const offs = registerSlashCommands(slash, { state, setStatus, rulesBySource, writeTarget });
        teardowns.push(...offs);
      } catch (err) {
        ctx.log(`llm-tool-approval: slash:registry unavailable — slash commands not registered. (${(err as Error).message})`);
      }

      // Subscriber.
      const subscriber = makeSubscriber({
        isPaused: () => state.paused,
        rules,
        summarize,
        prompt: uiPrompt ?? {
          // Stub that auto-denies. Real path replaces.
          requestOption: async (_req) => ({ id: "__missing__" }),
          requestText: async () => "",
        },
        persistAllow: (entry) => {
          appendAllowAtomic(writeTarget(), entry);
          reloadSources();
        },
        writeNotice,
        log: ctx.log,
      });

      const wrapped = uiPrompt
        ? subscriber
        : async (p: ToolBeforeExecutePayload) => {
            if (p.args === CANCEL_TOOL) return;
            p.args = CANCEL_TOOL;
            p.cancelReason = "approval gate misconfigured: no ui:prompt service";
          };

      ctx.on("tool:before-execute", wrapped);
    });

    ctx.on("harness:end", () => {
      for (const off of teardowns) { try { off(); } catch { /* ignore */ } }
      teardowns = [];
      void ctx.emit("status:item-clear", { id: "approval" });
    });
  },
};

function safeJsonStringify(v: unknown): string {
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

export default plugin;
```

- [ ] **Step 4: Verify passing**

Run: `cd plugins/llm-tool-approval && bun test`

Expected: all tests pass.

- [ ] **Step 5: Type-check the new plugin**

Run: `cd plugins/llm-tool-approval && bunx tsc --noEmit`

Expected: exit 0.

- [ ] **Step 6: Run the whole workspace test suite to confirm nothing regressed**

Run (from repo root): `bun test`

Expected: all pass.

- [ ] **Step 7: Commit**

```sh
git add plugins/llm-tool-approval/
git commit -m "feat(llm-tool-approval): wire plugin lifecycle (services, subscriber, slash, status)"
```

---

## Phase H — Harness wiring + local deploy

### Task 19: Add to harness manifest and smoke-test locally

**Files:**
- Modify: `harnesses/openai-compatible.json`

- [ ] **Step 1: Inspect current manifest order**

Read `harnesses/openai-compatible.json`. Confirm `llm-hooks-shell@0.1.1` is present.

- [ ] **Step 2: Add the new plugin entry**

Open `harnesses/openai-compatible.json`. Find the `"official/llm-hooks-shell@0.1.1"` line. Insert immediately after it:

```jsonc
"official/llm-tool-approval@0.1.0",
```

(Be mindful of JSON commas — the previous last array item now needs a trailing comma if it was the final entry; if `llm-hooks-shell` is followed by another plugin, just insert in between.)

The relevant span of the file should now read:

```jsonc
"official/llm-hooks-shell@0.1.1",
"official/llm-tool-approval@0.1.0"
```

(with whatever trailing comma the next line needs).

- [ ] **Step 3: Validate the manifest**

Run: `bunx jq . harnesses/openai-compatible.json > /dev/null`

Expected: exit 0 (valid JSON).

- [ ] **Step 4: Local-deploy the touched plugins**

For each of `llm-contracts`, `llm-tools-registry`, `llm-tui`, `llm-tool-approval`, run the local-deploy steps from that plugin's `CLAUDE.md`. The general pattern:

```sh
PLUGIN=<name>
VERSION=$(jq -r .version plugins/$PLUGIN/package.json)
INSTALL_DIR=~/.kaizen/marketplaces/official/plugins/${PLUGIN}@${VERSION}
mkdir -p "$INSTALL_DIR/dist"
# Build (entry file: index.ts or index.tsx — match what each plugin uses)
(cd plugins/$PLUGIN && bun build --target=bun --outfile=dist/index.js $(test -f index.tsx && echo index.tsx || echo index.ts))
cp plugins/$PLUGIN/dist/index.js "$INSTALL_DIR/dist/index.js"
rsync -a --exclude='node_modules' --exclude='dist' plugins/$PLUGIN/ "$INSTALL_DIR/"
```

For `llm-tool-approval`, the install dir doesn't exist yet on disk; `mkdir -p` handles it.

If the local marketplace repo (`~/.kaizen/marketplaces/official/repo/`) tracks the upstream manifest, sync the new harness file there too:

```sh
cp harnesses/openai-compatible.json ~/.kaizen/marketplaces/official/repo/harnesses/openai-compatible.json
```

(Skip if your marketplace install layout differs; the kaizen runtime will read the local `harnesses/openai-compatible.json` when invoked with `--harness ./harnesses/openai-compatible.json` regardless.)

- [ ] **Step 5: Smoke test**

Launch the harness against a real LM Studio / Ollama / OpenAI-compatible endpoint:

```sh
kaizen --harness ./harnesses/openai-compatible.json
```

Manually verify each of:

1. Status bar shows `approval: request`.
2. Ask the LLM to do something that triggers a tool call not in `defaults.json` (e.g., a file edit or a network fetch). A modal appears above the input box with the four options.
3. Up/Down navigates options. Enter resolves with the highlighted choice. The transcript echoes the choice as a notice.
4. Tab on Deny opens an inline reason field. Typing + Enter resolves with the reason. The `tool:error` message visible in the chat reflects the reason text.
5. `/approval:pause` — status bar updates to `approval: paused`; subsequent tool calls do not prompt.
6. `/approval:resume` — status bar updates back; prompting resumes.
7. `/approval:status` — prints the merged rule lists.
8. After picking "Approve Always" for a tool, verify the corresponding entry lands in `<cwd>/.kaizen/plugins/llm-tool-approval/config.json` (or the global path if no `<cwd>/.kaizen/` existed).

Stop the harness with `Ctrl+C` or `/exit`.

- [ ] **Step 6: Commit**

```sh
git add harnesses/openai-compatible.json
git commit -m "feat(harness): wire llm-tool-approval into openai-compatible (after llm-hooks-shell)"
```

---

## Done

The full feature is in. Spec coverage check:

- §1 components — all delivered (new plugin, two contract extensions, one new contract, TUI and registry behavior changes).
- §2 flow — implemented by `subscriber.ts` + `registry.ts` cancelReason support.
- §3 config — `config.ts` covers load/merge/target/atomic-write; domain derivation in `matcher.ts`.
- §4 UI — `<PromptBox>` + `TuiStore.prompt` + `<InputBox>` keystroke gating.
- §5 slash + status — `slash.ts` + `index.ts` `setStatus`.
- §6 error handling — covered in `subscriber.ts` and `index.ts` (missing-service paths).
- §7 testing — every unit identified is covered by a test file added in the corresponding task.
- §8 out-of-scope — left out as designed; documented in the spec.
