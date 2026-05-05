# claude-tui Ink Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite `plugins/claude-tui/` on Ink so the input cursor lives inside the rounded box, scrollback flows above it, and the status line sits below — matching Claude Code's TUI behavior — while keeping the public `UiChannel` interface unchanged.

**Architecture:** Ink + React 19 view layer over a small event-emitter store. `UiChannel` methods delegate to the store; store changes drive React re-renders via `useSyncExternalStore`. `<Static>` holds scrollback, an ephemeral `<SpinnerLine>` shows busy state, `<InputBox>` owns the prompt and `useInput`, `<StatusBar>` renders below. Slash commands intercepted pre-submit: `/clear` handled locally, everything else forwarded.

**Tech Stack:** Bun, TypeScript, Ink 7, React 19, ink-testing-library, ink-spinner.

**Spec:** `docs/superpowers/specs/2026-04-28-claude-tui-ink-design.md`

---

## File Map

**Create:**
- `plugins/claude-tui/state/store.ts` — TuiStore class (state + emitter)
- `plugins/claude-tui/state/store.test.ts` — store unit tests
- `plugins/claude-tui/slash.ts` — slash command interceptor
- `plugins/claude-tui/slash.test.ts` — slash unit tests
- `plugins/claude-tui/ui/SpinnerLine.tsx` — busy indicator component
- `plugins/claude-tui/ui/StatusBar.tsx` — status bar component
- `plugins/claude-tui/ui/InputBox.tsx` — rounded box + useInput
- `plugins/claude-tui/ui/App.tsx` — top-level layout
- `plugins/claude-tui/ui/App.test.tsx` — ink-testing-library behavior tests
- `plugins/claude-tui/fallback.ts` — non-TTY readline-based UiChannel

**Modify:**
- `plugins/claude-tui/index.ts` — mount Ink, expose UiChannel via store
- `plugins/claude-tui/index.test.ts` — drop stdout-monkey test, add store-based contract tests
- `plugins/claude-tui/package.json` — add ink, react, ink-spinner; devDeps ink-testing-library, @types/react; bump to 0.2.0
- `plugins/claude-tui/tsconfig.json` — add `"jsx": "react-jsx"`
- `.kaizen/marketplace.json` — bump claude-tui to 0.2.0

**Delete:**
- `plugins/claude-tui/render.ts`
- `plugins/claude-tui/render.test.ts`
- `plugins/claude-tui/input.ts`

---

## Task 1: Add dependencies and TypeScript JSX support

**Files:**
- Modify: `plugins/claude-tui/package.json`
- Modify: `plugins/claude-tui/tsconfig.json`

- [ ] **Step 1: Update `package.json`**

Replace contents with:

```json
{
  "name": "claude-tui",
  "version": "0.2.0",
  "description": "Terminal UI for claude-wrapper: prompt box + status bar (Ink)",
  "type": "module",
  "exports": { ".": "./index.ts" },
  "keywords": ["kaizen-plugin"],
  "dependencies": {
    "ink": "^7.0.1",
    "ink-spinner": "^5.0.0",
    "react": "^19.2.0"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "@types/node": "^20.0.0",
    "@types/react": "^19.0.0",
    "ink-testing-library": "^4.0.0",
    "typescript": "^5.4.0"
  }
}
```

- [ ] **Step 2: Update `tsconfig.json` for JSX**

Replace contents with:

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true
  }
}
```

- [ ] **Step 3: Install**

Run: `cd plugins/claude-tui && bun install`
Expected: lockfile updates, ink/react/ink-spinner/ink-testing-library/@types/react installed, exit 0.

- [ ] **Step 4: Smoke-check the install**

Run from `plugins/claude-tui/`:
```bash
bun -e 'import("ink").then(m => console.log(typeof m.render))'
```
Expected: `function`

- [ ] **Step 5: Commit**

```bash
git add plugins/claude-tui/package.json plugins/claude-tui/tsconfig.json plugins/claude-tui/bun.lock
git commit -m "chore(claude-tui): add ink/react deps for 0.2.0 rework"
```

---

## Task 2: TuiStore — state and emitter (TDD)

**Files:**
- Create: `plugins/claude-tui/state/store.ts`
- Create: `plugins/claude-tui/state/store.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `plugins/claude-tui/state/store.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { TuiStore } from "./store.ts";

describe("TuiStore", () => {
  it("appendOutput adds an entry and notifies subscribers", () => {
    const s = new TuiStore();
    let count = 0;
    s.subscribe(() => { count++; });
    s.appendOutput("hello");
    expect(s.snapshot().log.length).toBe(1);
    expect(s.snapshot().log[0]!.text).toBe("hello");
    expect(count).toBe(1);
  });

  it("appendNotice records a dim-styled notice line", () => {
    const s = new TuiStore();
    s.appendNotice("setup ok");
    const last = s.snapshot().log.at(-1)!;
    expect(last.text).toBe("setup ok");
    expect(last.tone).toBe("notice");
  });

  it("setBusy toggles busy with optional message", () => {
    const s = new TuiStore();
    s.setBusy(true, "thinking…");
    expect(s.snapshot().busy).toEqual({ on: true, msg: "thinking…" });
    s.setBusy(false);
    expect(s.snapshot().busy.on).toBe(false);
  });

  it("upsertStatus and clearStatus manage the status map", () => {
    const s = new TuiStore();
    s.upsertStatus({ id: "git", text: "main" });
    s.upsertStatus({ id: "git", text: "feat/x" });
    expect(s.snapshot().status.get("git")?.text).toBe("feat/x");
    s.clearStatus("git");
    expect(s.snapshot().status.has("git")).toBe(false);
  });

  it("clearLog empties the log without touching status", () => {
    const s = new TuiStore();
    s.appendOutput("a");
    s.upsertStatus({ id: "git", text: "main" });
    s.clearLog();
    expect(s.snapshot().log.length).toBe(0);
    expect(s.snapshot().status.size).toBe(1);
  });

  it("awaitInput resolves on next submit and pushes to history", async () => {
    const s = new TuiStore();
    const p = s.awaitInput();
    s.submit("hello");
    expect(await p).toBe("hello");
    expect(s.snapshot().history).toEqual(["hello"]);
  });

  it("submit without pending awaitInput is a no-op for resolution but still records history", () => {
    const s = new TuiStore();
    s.submit("orphan");
    expect(s.snapshot().history).toEqual(["orphan"]);
  });

  it("unsubscribe stops further notifications", () => {
    const s = new TuiStore();
    let count = 0;
    const off = s.subscribe(() => { count++; });
    s.appendOutput("a");
    off();
    s.appendOutput("b");
    expect(count).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd plugins/claude-tui && bun test state/store.test.ts`
Expected: failures — module not found.

- [ ] **Step 3: Implement the store**

Create `plugins/claude-tui/state/store.ts`:

```ts
export type LogTone = "output" | "notice";
export interface LogEntry { id: number; text: string; tone: LogTone; }
export interface StatusItem { id: string; text: string; tone?: "info" | "warn" | "err"; priority?: number; }
export interface BusyState { on: boolean; msg?: string; }

export interface TuiSnapshot {
  log: LogEntry[];
  status: Map<string, StatusItem>;
  busy: BusyState;
  history: string[];
}

export class TuiStore {
  private _log: LogEntry[] = [];
  private _status = new Map<string, StatusItem>();
  private _busy: BusyState = { on: false };
  private _history: string[] = [];
  private _pending: ((line: string) => void) | null = null;
  private _listeners = new Set<() => void>();
  private _seq = 0;
  private _snapshot: TuiSnapshot = this._build();

  subscribe(fn: () => void): () => void {
    this._listeners.add(fn);
    return () => { this._listeners.delete(fn); };
  }

  snapshot(): TuiSnapshot { return this._snapshot; }

  appendOutput(text: string): void {
    this._log = [...this._log, { id: ++this._seq, text, tone: "output" }];
    this._emit();
  }

  appendNotice(text: string): void {
    this._log = [...this._log, { id: ++this._seq, text, tone: "notice" }];
    this._emit();
  }

  clearLog(): void {
    this._log = [];
    this._emit();
  }

  setBusy(on: boolean, msg?: string): void {
    this._busy = { on, msg };
    this._emit();
  }

  upsertStatus(item: StatusItem): void {
    const next = new Map(this._status);
    next.set(item.id, item);
    this._status = next;
    this._emit();
  }

  clearStatus(id: string): void {
    if (!this._status.has(id)) return;
    const next = new Map(this._status);
    next.delete(id);
    this._status = next;
    this._emit();
  }

  awaitInput(): Promise<string> {
    return new Promise((resolve) => { this._pending = resolve; });
  }

  submit(line: string): void {
    this._history = [...this._history, line];
    const r = this._pending;
    this._pending = null;
    this._emit();
    r?.(line);
  }

  private _build(): TuiSnapshot {
    return { log: this._log, status: this._status, busy: this._busy, history: this._history };
  }

  private _emit(): void {
    this._snapshot = this._build();
    for (const fn of this._listeners) fn();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd plugins/claude-tui && bun test state/store.test.ts`
Expected: 8 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add plugins/claude-tui/state/
git commit -m "feat(claude-tui): TuiStore for Ink view layer"
```

---

## Task 3: Slash command interceptor (TDD)

**Files:**
- Create: `plugins/claude-tui/slash.ts`
- Create: `plugins/claude-tui/slash.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `plugins/claude-tui/slash.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { handleSlash } from "./slash.ts";
import { TuiStore } from "./state/store.ts";

describe("handleSlash", () => {
  it("returns 'forward' for non-slash input", () => {
    const s = new TuiStore();
    expect(handleSlash("hello", s)).toBe("forward");
  });

  it("returns 'forward' for /exit (caller decides)", () => {
    const s = new TuiStore();
    expect(handleSlash("/exit", s)).toBe("forward");
  });

  it("returns 'forward' for unknown slash commands", () => {
    const s = new TuiStore();
    expect(handleSlash("/unknown", s)).toBe("forward");
  });

  it("clears log and returns 'swallow' for /clear", () => {
    const s = new TuiStore();
    s.appendOutput("noise");
    expect(handleSlash("/clear", s)).toBe("swallow");
    expect(s.snapshot().log.length).toBe(0);
  });

  it("trims whitespace before matching", () => {
    const s = new TuiStore();
    s.appendOutput("noise");
    expect(handleSlash("  /clear  ", s)).toBe("swallow");
    expect(s.snapshot().log.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd plugins/claude-tui && bun test slash.test.ts`
Expected: failures — module not found.

- [ ] **Step 3: Implement**

Create `plugins/claude-tui/slash.ts`:

```ts
import type { TuiStore } from "./state/store.ts";

export type SlashResult = "swallow" | "forward";

export function handleSlash(line: string, store: TuiStore): SlashResult {
  const t = line.trim();
  if (t === "/clear") {
    store.clearLog();
    return "swallow";
  }
  return "forward";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd plugins/claude-tui && bun test slash.test.ts`
Expected: 5 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add plugins/claude-tui/slash.ts plugins/claude-tui/slash.test.ts
git commit -m "feat(claude-tui): slash interceptor (/clear local, rest forwarded)"
```

---

## Task 4: SpinnerLine and StatusBar components

**Files:**
- Create: `plugins/claude-tui/ui/SpinnerLine.tsx`
- Create: `plugins/claude-tui/ui/StatusBar.tsx`

- [ ] **Step 1: Write SpinnerLine**

Create `plugins/claude-tui/ui/SpinnerLine.tsx`:

```tsx
import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";

export const SpinnerLine: React.FC<{ msg?: string }> = ({ msg }) => (
  <Box>
    <Text color="yellow">
      <Spinner type="dots" />
    </Text>
    <Text color="yellow">{` ${msg ?? "thinking…"}`}</Text>
  </Box>
);
```

- [ ] **Step 2: Write StatusBar**

Create `plugins/claude-tui/ui/StatusBar.tsx`:

```tsx
import React from "react";
import { Box, Text } from "ink";
import type { StatusItem } from "../state/store.ts";

const toneColor = (tone?: StatusItem["tone"]): string | undefined => {
  if (tone === "warn") return "yellow";
  if (tone === "err") return "red";
  return undefined;
};

export const StatusBar: React.FC<{ items: Map<string, StatusItem> }> = ({ items }) => {
  if (items.size === 0) return null;
  const sorted = [...items.values()].sort((a, b) => (a.priority ?? 50) - (b.priority ?? 50));
  return (
    <Box>
      {sorted.map((it, i) => (
        <Box key={it.id}>
          {i > 0 && <Text dimColor> | </Text>}
          <Text color={toneColor(it.tone)} dimColor={!it.tone}>{it.text}</Text>
        </Box>
      ))}
    </Box>
  );
};
```

- [ ] **Step 3: Type-check**

Run: `cd plugins/claude-tui && bunx tsc --noEmit`
Expected: exit 0, no errors.

- [ ] **Step 4: Commit**

```bash
git add plugins/claude-tui/ui/SpinnerLine.tsx plugins/claude-tui/ui/StatusBar.tsx
git commit -m "feat(claude-tui): SpinnerLine and StatusBar components"
```

---

## Task 5: InputBox component

**Files:**
- Create: `plugins/claude-tui/ui/InputBox.tsx`

- [ ] **Step 1: Write InputBox**

Create `plugins/claude-tui/ui/InputBox.tsx`:

```tsx
import React, { useState, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import type { TuiStore } from "../state/store.ts";
import { handleSlash } from "../slash.ts";

export interface InputBoxProps {
  store: TuiStore;
  history: string[];
  onCtrlC?: () => void;
}

export const InputBox: React.FC<InputBoxProps> = ({ store, history, onCtrlC }) => {
  const [buffer, setBuffer] = useState("");
  const [cursor, setCursor] = useState(0);
  const [histIdx, setHistIdx] = useState<number | null>(null);

  const submit = useCallback(() => {
    const line = buffer;
    setBuffer("");
    setCursor(0);
    setHistIdx(null);
    if (handleSlash(line, store) === "swallow") return;
    store.submit(line);
  }, [buffer, store]);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      onCtrlC?.();
      return;
    }
    if (key.return && !key.shift) {
      submit();
      return;
    }
    if (key.return && key.shift) {
      setBuffer((b) => b.slice(0, cursor) + "\n" + b.slice(cursor));
      setCursor((c) => c + 1);
      return;
    }
    if (key.backspace || key.delete) {
      if (cursor === 0) return;
      setBuffer((b) => b.slice(0, cursor - 1) + b.slice(cursor));
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.leftArrow) {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.rightArrow) {
      setCursor((c) => Math.min(buffer.length, c + 1));
      return;
    }
    if (key.upArrow) {
      if (history.length === 0) return;
      const next = histIdx === null ? history.length - 1 : Math.max(0, histIdx - 1);
      setHistIdx(next);
      setBuffer(history[next] ?? "");
      setCursor((history[next] ?? "").length);
      return;
    }
    if (key.downArrow) {
      if (histIdx === null) return;
      const next = histIdx + 1;
      if (next >= history.length) {
        setHistIdx(null);
        setBuffer("");
        setCursor(0);
      } else {
        setHistIdx(next);
        setBuffer(history[next] ?? "");
        setCursor((history[next] ?? "").length);
      }
      return;
    }
    if (input && input.length > 0) {
      setBuffer((b) => b.slice(0, cursor) + input + b.slice(cursor));
      setCursor((c) => c + input.length);
    }
  });

  return (
    <Box borderStyle="round" borderColor="magenta" paddingX={1}>
      <Text color="magenta">❯ </Text>
      <Text>{buffer || " "}</Text>
    </Box>
  );
};
```

- [ ] **Step 2: Type-check**

Run: `cd plugins/claude-tui && bunx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add plugins/claude-tui/ui/InputBox.tsx
git commit -m "feat(claude-tui): InputBox with multi-line, history, slash routing"
```

---

## Task 6: App composition

**Files:**
- Create: `plugins/claude-tui/ui/App.tsx`

- [ ] **Step 1: Write App**

Create `plugins/claude-tui/ui/App.tsx`:

```tsx
import React, { useSyncExternalStore } from "react";
import { Box, Static, Text } from "ink";
import type { TuiStore, LogEntry } from "../state/store.ts";
import { SpinnerLine } from "./SpinnerLine.tsx";
import { StatusBar } from "./StatusBar.tsx";
import { InputBox } from "./InputBox.tsx";

export interface AppProps {
  store: TuiStore;
  onCtrlC?: () => void;
}

export const App: React.FC<AppProps> = ({ store, onCtrlC }) => {
  const snap = useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => store.snapshot(),
  );

  return (
    <Box flexDirection="column">
      <Static items={snap.log}>
        {(e: LogEntry) => (
          <Text key={e.id} dimColor={e.tone === "notice"}>
            {e.text}
          </Text>
        )}
      </Static>
      {snap.busy.on && <SpinnerLine msg={snap.busy.msg} />}
      <InputBox store={store} history={snap.history} onCtrlC={onCtrlC} />
      <StatusBar items={snap.status} />
    </Box>
  );
};
```

- [ ] **Step 2: Type-check**

Run: `cd plugins/claude-tui && bunx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add plugins/claude-tui/ui/App.tsx
git commit -m "feat(claude-tui): App composition (Static log + Spinner + InputBox + StatusBar)"
```

---

## Task 7: Non-TTY fallback

**Files:**
- Create: `plugins/claude-tui/fallback.ts`

- [ ] **Step 1: Write the fallback**

Create `plugins/claude-tui/fallback.ts`:

```ts
import * as readline from "node:readline";
import type { UiChannel } from "./public.d.ts";

export function createFallbackChannel(): UiChannel {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  let pending: ((s: string) => void) | null = null;
  rl.on("line", (line) => { const r = pending; pending = null; r?.(line); });
  rl.on("close", () => { const r = pending; pending = null; r?.(""); });

  return {
    readInput() {
      return new Promise((resolve) => { pending = resolve; });
    },
    writeOutput(chunk: string) { process.stdout.write(chunk); },
    writeNotice(line: string) { process.stdout.write(`\x1b[2m${line}\x1b[0m\n`); },
    setBusy() { /* no-op in non-TTY mode */ },
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add plugins/claude-tui/fallback.ts
git commit -m "feat(claude-tui): non-TTY readline fallback channel"
```

---

## Task 8: Wire index.ts (mount Ink, expose UiChannel)

**Files:**
- Modify: `plugins/claude-tui/index.ts` (full replacement)

- [ ] **Step 1: Replace `index.ts`**

Replace contents with:

```tsx
import React from "react";
import { render } from "ink";
import type { KaizenPlugin } from "kaizen/types";
import type { UiChannel } from "./public.d.ts";
import { TuiStore } from "./state/store.ts";
import { App } from "./ui/App.tsx";
import { createFallbackChannel } from "./fallback.ts";

const plugin: KaizenPlugin = {
  name: "claude-tui",
  apiVersion: "3.0.0",
  permissions: { tier: "unscoped" },
  services: {
    provides: ["claude-tui:channel"],
    consumes: ["claude-events:vocabulary"],
  },

  async setup(ctx) {
    ctx.consumeService("claude-events:vocabulary");
    ctx.defineService("claude-tui:channel", { description: "Terminal UI channel: input + output + status bar." });

    const isTTY = !!(process.stdout.isTTY && process.stdin.isTTY);

    if (!isTTY) {
      const channel = createFallbackChannel();
      ctx.provideService<UiChannel>("claude-tui:channel", channel);
      ctx.on("status:item-update", async () => {});
      ctx.on("status:item-clear", async () => {});
      return;
    }

    const store = new TuiStore();

    const onCtrlC = () => {
      if (store.snapshot().busy.on) {
        ctx.emit("turn:cancel").catch(() => {});
      } else {
        process.exit(0);
      }
    };

    const inkApp = render(<App store={store} onCtrlC={onCtrlC} />);

    ctx.on("status:item-update", async (payload: any) => {
      if (!payload?.id) return;
      store.upsertStatus({
        id: payload.id,
        text: payload.content ?? "",
        tone: payload.tone,
        priority: payload.priority,
      });
    });
    ctx.on("status:item-clear", async (payload: any) => {
      if (!payload?.id) return;
      store.clearStatus(payload.id);
    });

    const channel: UiChannel = {
      readInput: () => store.awaitInput(),
      writeOutput: (chunk: string) => store.appendOutput(chunk),
      writeNotice: (line: string) => store.appendNotice(line),
      setBusy: (busy: boolean, message?: string) => store.setBusy(busy, message),
    };

    ctx.provideService<UiChannel>("claude-tui:channel", channel);

    (plugin as any).__ink = inkApp;
  },

  async stop() {
    const inkApp = (plugin as any).__ink;
    if (inkApp) {
      try { inkApp.unmount(); } catch { /* ignore */ }
    }
  },
};

export default plugin;
```

- [ ] **Step 2: Type-check**

Run: `cd plugins/claude-tui && bunx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add plugins/claude-tui/index.ts
git commit -m "feat(claude-tui): mount Ink app, bridge UiChannel to TuiStore"
```

---

## Task 9: App behavior tests (ink-testing-library)

**Files:**
- Create: `plugins/claude-tui/ui/App.test.tsx`

- [ ] **Step 1: Write the tests**

Create `plugins/claude-tui/ui/App.test.tsx`:

```tsx
import React from "react";
import { describe, it, expect } from "bun:test";
import { render } from "ink-testing-library";
import { App } from "./App.tsx";
import { TuiStore } from "../state/store.ts";

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

describe("App", () => {
  it("renders the rounded prompt with ❯", async () => {
    const store = new TuiStore();
    const { lastFrame } = render(<App store={store} />);
    await tick();
    expect(lastFrame()).toContain("❯");
    expect(lastFrame()).toMatch(/[╭╮╯╰]/);
  });

  it("shows typed characters inside the box", async () => {
    const store = new TuiStore();
    const { stdin, lastFrame } = render(<App store={store} />);
    await tick();
    stdin.write("hello");
    await tick();
    expect(lastFrame()).toContain("❯ hello");
  });

  it("Enter resolves pending readInput with the typed line", async () => {
    const store = new TuiStore();
    const { stdin } = render(<App store={store} />);
    await tick();
    const p = store.awaitInput();
    stdin.write("ping");
    await tick();
    stdin.write("\r");
    expect(await p).toBe("ping");
  });

  it("/clear empties the log and does NOT resolve readInput", async () => {
    const store = new TuiStore();
    store.appendOutput("noise-1");
    store.appendOutput("noise-2");
    const { stdin } = render(<App store={store} />);
    await tick();
    let resolved = false;
    store.awaitInput().then(() => { resolved = true; });
    stdin.write("/clear");
    await tick();
    stdin.write("\r");
    await tick();
    expect(store.snapshot().log.length).toBe(0);
    expect(resolved).toBe(false);
  });

  it("up-arrow recalls last submitted line", async () => {
    const store = new TuiStore();
    const { stdin, lastFrame } = render(<App store={store} />);
    await tick();
    store.awaitInput();
    stdin.write("first");
    await tick();
    stdin.write("\r");
    await tick();
    stdin.write("[A"); // up arrow
    await tick();
    expect(lastFrame()).toContain("❯ first");
  });

  it("setBusy(true,msg) renders SpinnerLine; setBusy(false) removes it", async () => {
    const store = new TuiStore();
    const { lastFrame } = render(<App store={store} />);
    await tick();
    store.setBusy(true, "thinking…");
    await tick();
    expect(lastFrame()).toContain("thinking…");
    store.setBusy(false);
    await tick();
    expect(lastFrame()).not.toContain("thinking…");
  });

  it("upsertStatus renders an item in the status bar", async () => {
    const store = new TuiStore();
    const { lastFrame } = render(<App store={store} />);
    await tick();
    store.upsertStatus({ id: "branch", text: "main" });
    await tick();
    expect(lastFrame()).toContain("main");
  });

});
```

Note: shift+Enter multi-line behavior is verified manually in Task 12 — `ink-testing-library` cannot reliably simulate shift modifiers on Enter.

- [ ] **Step 2: Run the tests**

Run: `cd plugins/claude-tui && bun test ui/App.test.tsx`
Expected: 7 pass, 0 fail.

If any fail, the most likely cause is a too-short `tick()` — bump the ms and retry. Do not change component behavior to suit a flaky test without first confirming the behavior is wrong with a manual run.

- [ ] **Step 3: Commit**

```bash
git add plugins/claude-tui/ui/App.test.tsx
git commit -m "test(claude-tui): App behavior tests via ink-testing-library"
```

---

## Task 10: Update index.test.ts (drop stdout-monkey patch)

**Files:**
- Modify: `plugins/claude-tui/index.test.ts` (full replacement)

- [ ] **Step 1: Replace `index.test.ts`**

Replace contents with:

```ts
import { describe, it, expect, mock } from "bun:test";
import plugin from "./index.ts";

function makeCtx(opts?: { isTTY?: boolean }) {
  const provided: Record<string, unknown> = {};
  const subs: Record<string, Function[]> = {};
  return {
    provided,
    subs,
    log: mock(() => {}),
    config: {},
    defineEvent: mock(() => {}),
    on: mock((event: string, h: Function) => {
      (subs[event] ??= []).push(h);
    }),
    emit: mock(async () => []),
    defineService: mock(() => {}),
    provideService: mock((name: string, impl: unknown) => { provided[name] = impl; }),
    consumeService: mock(() => {}),
    useService: mock(() => undefined),
    secrets: { get: mock(async () => undefined), refresh: mock(async () => undefined) },
  } as any;
}

describe("claude-tui plugin (non-TTY mode)", () => {
  // Tests run in `bun test` — stdin/stdout are not TTYs, so the plugin
  // takes the fallback path. This keeps the test deterministic without
  // mounting Ink during unit tests.

  it("has correct metadata", () => {
    expect(plugin.name).toBe("claude-tui");
    expect(plugin.apiVersion).toBe("3.0.0");
    expect(plugin.permissions?.tier).toBe("unscoped");
  });

  it("provides claude-tui:channel and registers status handlers", async () => {
    const ctx = makeCtx();
    await plugin.setup(ctx);
    expect(ctx.provided["claude-tui:channel"]).toBeDefined();
    expect(ctx.subs["status:item-update"]?.length).toBe(1);
    expect(ctx.subs["status:item-clear"]?.length).toBe(1);
  });

  it("channel exposes UiChannel methods", async () => {
    const ctx = makeCtx();
    await plugin.setup(ctx);
    const ui = ctx.provided["claude-tui:channel"] as any;
    expect(typeof ui.readInput).toBe("function");
    expect(typeof ui.writeOutput).toBe("function");
    expect(typeof ui.writeNotice).toBe("function");
    expect(typeof ui.setBusy).toBe("function");
  });
});
```

- [ ] **Step 2: Run tests**

Run: `cd plugins/claude-tui && bun test index.test.ts`
Expected: 3 pass, 0 fail.

- [ ] **Step 3: Commit**

```bash
git add plugins/claude-tui/index.test.ts
git commit -m "test(claude-tui): replace stdout-patch test with non-TTY contract tests"
```

---

## Task 11: Delete obsolete files

**Files:**
- Delete: `plugins/claude-tui/render.ts`
- Delete: `plugins/claude-tui/render.test.ts`
- Delete: `plugins/claude-tui/input.ts`

- [ ] **Step 1: Delete the files**

```bash
rm plugins/claude-tui/render.ts plugins/claude-tui/render.test.ts plugins/claude-tui/input.ts
```

- [ ] **Step 2: Verify no remaining imports**

Run: `grep -rn "from \"\./render" plugins/claude-tui/ ; grep -rn "from \"\./input" plugins/claude-tui/`
Expected: no output (no remaining references).

- [ ] **Step 3: Run full plugin test suite**

Run: `cd plugins/claude-tui && bun test`
Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add -A plugins/claude-tui/
git commit -m "chore(claude-tui): remove obsolete render.ts/input.ts and their tests"
```

---

## Task 12: Bump marketplace version and run a real-terminal smoke

**Files:**
- Modify: `.kaizen/marketplace.json:19`

- [ ] **Step 1: Bump marketplace entry**

In `.kaizen/marketplace.json`, change the claude-tui entry's version from `0.1.2` to `0.2.0`:

```json
"versions": [{ "version": "0.2.0", "source": { "type": "file", "path": "plugins/claude-tui" } }]
```

- [ ] **Step 2: Manual smoke test in a real TTY**

This task cannot be automated — it requires a real terminal.

Instructions for the operator:
1. From the repo root, run the kaizen harness with the wrapper that consumes `claude-tui:channel` (e.g. `claude-wrapper`). Use whatever entry point the harness exposes today (consult `claude-wrapper`'s README).
2. Confirm visually:
   - Cursor blinks **inside** the magenta rounded box.
   - Typing characters appears inside the box, not on a line below.
   - Pressing Enter submits and the input clears.
   - Pressing Up arrow recalls the previous prompt.
   - When the assistant streams output, text appears **above** the input box and the box stays anchored.
   - Status items render on the line below the box.
   - `setBusy(true)` shows `✻ thinking…` above the box; clears when done.
   - `/clear` clears the scrollback.
   - `/exit` exits cleanly.

If any of the above fails, do **not** mark the task complete. File findings against the spec's Risks section.

- [ ] **Step 3: Commit the marketplace bump**

```bash
git add .kaizen/marketplace.json
git commit -m "chore: bump claude-tui to 0.2.0 in marketplace"
```

---

## Task 13: Final verification and PR

- [ ] **Step 1: Full test sweep**

Run: `cd plugins/claude-tui && bun test`
Expected: all tests pass.

Run: `cd plugins/claude-tui && bunx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 2: Confirm version bumps**

```bash
grep version plugins/claude-tui/package.json
grep -A2 '"name": "claude-tui"' .kaizen/marketplace.json
```
Expected: both show `0.2.0`.

- [ ] **Step 3: Push and open PR**

```bash
git push -u origin HEAD
gh pr create --title "feat(claude-tui): rework on Ink for in-box input + scrollback (0.2.0)" --body "$(cat <<'EOF'
## Summary
- Rewrites `plugins/claude-tui/` on Ink so the cursor lives inside the rounded box, scrollback flows above, and the status line sits below.
- Public `UiChannel` interface unchanged; `claude-driver` and `claude-wrapper` untouched.
- Adds multi-line input, in-memory history, and a non-TTY fallback channel.
- Bumps claude-tui to 0.2.0.

Closes #5.

## Test plan
- [ ] `bun test` in `plugins/claude-tui/` — all green
- [ ] `bunx tsc --noEmit` — clean
- [ ] Manual TTY smoke (Task 12): typed input inside the box, history, `/clear`, `/exit`, status bar, spinner

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: Confirm PR URL is reported back**

Done.
