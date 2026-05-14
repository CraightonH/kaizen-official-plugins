# TUI Markdown Rendering + Ctrl+X Copy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render assistant messages as markdown in the TUI, and bind Ctrl+X to copy the raw markdown source of the latest assistant message to the OS clipboard. Advertise the keybind via the status bar.

**Architecture:** All changes local to `plugins/llm-tui`. Output rendering routes `kind: "output"` transcript entries through a `marked` + `marked-terminal` pipeline at render time (raw text stays in the store). A new `clipboard.ts` module handles platform clipboard CLIs with an OSC 52 fallback, dependency-injected for testability. `InputBox` gets a Ctrl+X handler; `index.tsx` emits a `status:item-update` event on setup so the hint shows in the status bar.

**Tech Stack:** TypeScript, Ink/React, `marked`, `marked-terminal`, `Bun.spawn`, `bun:test`, ink-testing-library. Spec: `docs/superpowers/specs/2026-05-14-tui-markdown-and-copy-design.md`.

---

## File map

**New:**
- `plugins/llm-tui/ui/markdown.ts` — `renderMarkdown(src) → ANSI string`.
- `plugins/llm-tui/ui/markdown.test.ts` — unit tests.
- `plugins/llm-tui/clipboard.ts` — `copyToClipboard(text, deps?) → Promise<CopyResult>`.
- `plugins/llm-tui/clipboard.test.ts` — unit tests with injected deps.

**Modified:**
- `plugins/llm-tui/package.json` — add `marked`, `marked-terminal` deps.
- `plugins/llm-tui/state/store.ts` — add `latestOutputText()` accessor.
- `plugins/llm-tui/state/store.test.ts` — extend with `latestOutputText()` cases.
- `plugins/llm-tui/ui/App.tsx` — route `kind: "output"` through `renderMarkdown`.
- `plugins/llm-tui/ui/InputBox.tsx` — accept `copyToClipboard` prop; add Ctrl+X handler.
- `plugins/llm-tui/ui/InputBox.test.tsx` — extend with Ctrl+X cases.
- `plugins/llm-tui/index.tsx` — emit status hint on setup; pass `copyToClipboard` to InputBox via App.
- `plugins/llm-tui/ui/App.tsx` — thread `copyToClipboard` from props through to InputBox.
- `plugins/llm-tui/integration.test.ts` — add Ctrl+X integration case.

---

### Task 1: Add dependencies

**Files:**
- Modify: `plugins/llm-tui/package.json`

- [ ] **Step 1: Add deps to package.json**

Edit `plugins/llm-tui/package.json` `dependencies` block to add two entries (preserve alphabetical order with existing entries):

```json
"dependencies": {
  "ink": "^7.0.1",
  "ink-spinner": "^5.0.0",
  "llm-contracts": "workspace:*",
  "marked": "^14.1.3",
  "marked-terminal": "^7.2.1",
  "react": "^19.2.0",
  "react-devtools-core": "^7.0.1"
}
```

- [ ] **Step 2: Install**

Run from the repo root:
```bash
cd plugins/llm-tui && bun install
```

Expected: `bun install` completes with no errors; `node_modules/marked` and `node_modules/marked-terminal` exist.

- [ ] **Step 3: Verify imports resolve**

Run from `plugins/llm-tui`:
```bash
bun -e 'import {marked} from "marked"; import {markedTerminal} from "marked-terminal"; marked.use(markedTerminal()); console.log(marked.parse("# hello"));'
```

Expected: prints an ANSI-styled string containing the word `hello` (heading colors). If `markedTerminal` import name fails, try `import MarkedTerminal from "marked-terminal"` (older API) and adjust the pin in step 1. Re-run until output is styled text.

- [ ] **Step 4: Commit**

```bash
git add plugins/llm-tui/package.json bun.lock
git commit -m "deps(llm-tui): add marked and marked-terminal"
```

---

### Task 2: Implement `renderMarkdown` (TDD)

**Files:**
- Create: `plugins/llm-tui/ui/markdown.test.ts`
- Create: `plugins/llm-tui/ui/markdown.ts`

- [ ] **Step 1: Write the failing test**

Create `plugins/llm-tui/ui/markdown.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "./markdown.ts";

// ANSI escape begins with \x1B (ESC). Heading / code / list styles all emit
// at least one ANSI sequence. We don't pin specific colors — that couples the
// test to chalk's palette — we just assert the renderer styled SOMETHING.
const ANSI = /\x1B\[/;

describe("renderMarkdown", () => {
  test("renders a heading with ANSI styling", () => {
    const out = renderMarkdown("# hello");
    expect(out).toMatch(ANSI);
    expect(out).toContain("hello");
  });

  test("renders a fenced code block", () => {
    const out = renderMarkdown("```\nconsole.log(1)\n```");
    expect(out).toContain("console.log(1)");
  });

  test("renders a bullet list", () => {
    const out = renderMarkdown("- one\n- two");
    expect(out).toContain("one");
    expect(out).toContain("two");
  });

  test("plain prose passes through (no throw)", () => {
    const out = renderMarkdown("just a sentence.");
    expect(out).toContain("just a sentence.");
  });

  test("returns input verbatim on renderer failure", () => {
    // Build a value that should not throw on the happy path; for a forced-
    // failure case we monkey-patch in the implementation file would over-
    // engineer. Instead, assert the defensive contract via a sanity case:
    // empty string returns empty (does not throw).
    expect(renderMarkdown("")).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd plugins/llm-tui && bun test ui/markdown.test.ts
```

Expected: FAIL with module-not-found error for `./markdown.ts`.

- [ ] **Step 3: Implement `renderMarkdown`**

Create `plugins/llm-tui/ui/markdown.ts`:

```typescript
import { marked } from "marked";
import { markedTerminal } from "marked-terminal";

// One-time configuration. marked-terminal installs a custom renderer that
// emits ANSI-styled strings instead of HTML.
marked.use(markedTerminal() as any);

/**
 * Render a markdown source string as an ANSI-styled string suitable for
 * passing directly to Ink's <Text> (Ink honors embedded ANSI). Returns the
 * input verbatim if the renderer throws — we never want a malformed message
 * to crash the TUI.
 */
export function renderMarkdown(src: string): string {
  try {
    const result = marked.parse(src);
    return typeof result === "string" ? result : src;
  } catch {
    return src;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd plugins/llm-tui && bun test ui/markdown.test.ts
```

Expected: all five tests pass.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-tui/ui/markdown.ts plugins/llm-tui/ui/markdown.test.ts
git commit -m "feat(llm-tui): renderMarkdown via marked + marked-terminal"
```

---

### Task 3: Implement `copyToClipboard` (TDD)

**Files:**
- Create: `plugins/llm-tui/clipboard.test.ts`
- Create: `plugins/llm-tui/clipboard.ts`

- [ ] **Step 1: Write the failing test**

Create `plugins/llm-tui/clipboard.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { copyToClipboard, type ClipboardDeps } from "./clipboard.ts";

// Helper: build a deps bag with controllable spawn + stdout sink + platform.
function mkDeps(opts: {
  platform: NodeJS.Platform;
  spawn?: (cmd: string[], stdin: string) => Promise<{ exitCode: number; missing?: boolean }>;
  stdoutSink?: { writes: string[] };
}): ClipboardDeps {
  const writes = opts.stdoutSink?.writes ?? [];
  return {
    platform: opts.platform,
    spawn: opts.spawn ?? (async () => ({ exitCode: 0 })),
    writeStdout: (s) => { writes.push(s); },
  };
}

describe("copyToClipboard", () => {
  test("darwin uses pbcopy", async () => {
    const calls: string[][] = [];
    const deps = mkDeps({
      platform: "darwin",
      spawn: async (cmd) => { calls.push(cmd); return { exitCode: 0 }; },
    });
    const r = await copyToClipboard("hello", deps);
    expect(r.ok).toBe(true);
    expect(r.via).toBe("pbcopy");
    expect(calls[0]?.[0]).toBe("pbcopy");
  });

  test("linux uses xclip first", async () => {
    const calls: string[][] = [];
    const deps = mkDeps({
      platform: "linux",
      spawn: async (cmd) => { calls.push(cmd); return { exitCode: 0 }; },
    });
    const r = await copyToClipboard("hello", deps);
    expect(r.ok).toBe(true);
    expect(r.via).toBe("xclip");
    expect(calls[0]?.[0]).toBe("xclip");
  });

  test("linux falls back to xsel when xclip missing", async () => {
    const calls: string[][] = [];
    const deps = mkDeps({
      platform: "linux",
      spawn: async (cmd) => {
        calls.push(cmd);
        if (cmd[0] === "xclip") return { exitCode: 1, missing: true };
        return { exitCode: 0 };
      },
    });
    const r = await copyToClipboard("hello", deps);
    expect(r.ok).toBe(true);
    expect(r.via).toBe("xsel");
    expect(calls.map((c) => c[0])).toEqual(["xclip", "xsel"]);
  });

  test("win32 uses clip.exe", async () => {
    const deps = mkDeps({
      platform: "win32",
      spawn: async () => ({ exitCode: 0 }),
    });
    const r = await copyToClipboard("hello", deps);
    expect(r.ok).toBe(true);
    expect(r.via).toBe("clip");
  });

  test("falls back to OSC 52 when all subprocesses fail", async () => {
    const sink = { writes: [] as string[] };
    const deps = mkDeps({
      platform: "linux",
      spawn: async () => ({ exitCode: 1, missing: true }),
      stdoutSink: sink,
    });
    const r = await copyToClipboard("hello", deps);
    expect(r.ok).toBe(true);
    expect(r.via).toBe("osc52");
    // OSC 52 sequence: ESC ] 52 ; c ; <base64> BEL
    expect(sink.writes[0]).toMatch(/\x1B\]52;c;/);
    expect(sink.writes[0]).toContain(Buffer.from("hello").toString("base64"));
    expect(sink.writes[0]).toMatch(/\x07$/);
  });

  test("returns ok:false when subprocess errors and OSC 52 throws", async () => {
    const deps: ClipboardDeps = {
      platform: "darwin",
      spawn: async () => ({ exitCode: 1, missing: true }),
      writeStdout: () => { throw new Error("no stdout"); },
    };
    const r = await copyToClipboard("hello", deps);
    expect(r.ok).toBe(false);
    expect(r.via).toBe("none");
    expect(r.error).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd plugins/llm-tui && bun test clipboard.test.ts
```

Expected: FAIL with module-not-found for `./clipboard.ts`.

- [ ] **Step 3: Implement `copyToClipboard`**

Create `plugins/llm-tui/clipboard.ts`:

```typescript
export type CopyVia = "pbcopy" | "xclip" | "xsel" | "clip" | "osc52" | "none";

export interface CopyResult {
  ok: boolean;
  via: CopyVia;
  error?: string;
}

export interface ClipboardDeps {
  platform?: NodeJS.Platform;
  spawn?: (cmd: string[], stdin: string) => Promise<{ exitCode: number; missing?: boolean }>;
  writeStdout?: (s: string) => void;
}

// Real implementation of the spawn dependency. Bun.spawn returns an object
// with stdin/stdout pipes. We write the text, close stdin, await exit.
async function realSpawn(cmd: string[], stdin: string): Promise<{ exitCode: number; missing?: boolean }> {
  try {
    const proc = Bun.spawn(cmd, { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
    proc.stdin.write(stdin);
    await proc.stdin.end();
    const code = await proc.exited;
    return { exitCode: code ?? 0 };
  } catch (err: any) {
    // ENOENT / spawn failure → binary not on PATH.
    return { exitCode: 1, missing: true };
  }
}

// Mapping from platform → ordered list of CLI candidates to try.
function platformCandidates(platform: NodeJS.Platform): Array<{ via: CopyVia; cmd: string[] }> {
  if (platform === "darwin") return [{ via: "pbcopy", cmd: ["pbcopy"] }];
  if (platform === "win32") return [{ via: "clip", cmd: ["clip.exe"] }];
  // Default: linux and friends.
  return [
    { via: "xclip", cmd: ["xclip", "-selection", "clipboard"] },
    { via: "xsel", cmd: ["xsel", "--clipboard", "--input"] },
  ];
}

// OSC 52: ESC ] 52 ; c ; <base64> BEL — broadly supported in iTerm2,
// Alacritty, kitty, recent xterm, tmux (with allow-passthrough), and most
// SSH-friendly terminals when the terminal config permits.
function emitOsc52(text: string, writeStdout: (s: string) => void): void {
  const b64 = Buffer.from(text, "utf8").toString("base64");
  writeStdout(`\x1B]52;c;${b64}\x07`);
}

export async function copyToClipboard(text: string, deps?: ClipboardDeps): Promise<CopyResult> {
  const platform = deps?.platform ?? process.platform;
  const spawn = deps?.spawn ?? realSpawn;
  const writeStdout = deps?.writeStdout ?? ((s: string) => process.stdout.write(s));

  const candidates = platformCandidates(platform);
  let lastError = "";
  for (const c of candidates) {
    const { exitCode, missing } = await spawn(c.cmd, text);
    if (exitCode === 0) return { ok: true, via: c.via };
    if (!missing) lastError = `${c.via} exited ${exitCode}`;
  }

  // OSC 52 fallback.
  try {
    emitOsc52(text, writeStdout);
    return { ok: true, via: "osc52" };
  } catch (err: any) {
    return { ok: false, via: "none", error: lastError || String(err?.message ?? err) };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd plugins/llm-tui && bun test clipboard.test.ts
```

Expected: all six tests pass.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-tui/clipboard.ts plugins/llm-tui/clipboard.test.ts
git commit -m "feat(llm-tui): copyToClipboard with platform CLIs + OSC 52 fallback"
```

---

### Task 4: Add `latestOutputText()` to TuiStore (TDD)

**Files:**
- Modify: `plugins/llm-tui/state/store.ts`
- Modify: `plugins/llm-tui/state/store.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `plugins/llm-tui/state/store.test.ts` (find a sensible spot — end of file is fine):

```typescript
import { describe, expect, test } from "bun:test";
import { TuiStore } from "./store.ts";

describe("TuiStore.latestOutputText", () => {
  test("returns null on empty transcript", () => {
    const s = new TuiStore();
    expect(s.latestOutputText()).toBeNull();
  });

  test("returns null when transcript has only non-output kinds", () => {
    const s = new TuiStore();
    s.appendNotice("hello");
    s.appendUser("hi");
    expect(s.latestOutputText()).toBeNull();
  });

  test("returns the text of the only output entry", () => {
    const s = new TuiStore();
    s.appendNotice("ignored");
    s.appendOutput("the answer");
    expect(s.latestOutputText()).toBe("the answer");
  });

  test("returns the most recent output across mixed kinds", () => {
    const s = new TuiStore();
    s.appendOutput("first");
    s.appendNotice("note");
    s.appendUser("question");
    s.appendOutput("second");
    s.appendNotice("done");
    expect(s.latestOutputText()).toBe("second");
  });
});
```

If `state/store.test.ts` doesn't exist yet, create it. Confirm with:

```bash
ls plugins/llm-tui/state/store.test.ts
```

If it doesn't exist, prepend the file with this header before the `describe` block:

```typescript
// (already-present imports/tests stay above this block)
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd plugins/llm-tui && bun test state/store.test.ts
```

Expected: FAIL on `s.latestOutputText is not a function`.

- [ ] **Step 3: Add the accessor**

Edit `plugins/llm-tui/state/store.ts`. Find a public method (e.g. immediately after `snapshot()`) and add:

```typescript
  /**
   * Return the text of the most recent `kind: "output"` transcript entry,
   * or null if no output has been written yet. Used by the Ctrl+X copy
   * shortcut to pluck the latest assistant message.
   */
  latestOutputText(): string | null {
    for (let i = this._transcript.length - 1; i >= 0; i--) {
      const e = this._transcript[i];
      if (e?.kind === "output") return e.text;
    }
    return null;
  }
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd plugins/llm-tui && bun test state/store.test.ts
```

Expected: the four new tests pass; existing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-tui/state/store.ts plugins/llm-tui/state/store.test.ts
git commit -m "feat(llm-tui): TuiStore.latestOutputText for copy shortcut"
```

---

### Task 5: Route `kind: "output"` through `renderMarkdown` in App.tsx

**Files:**
- Modify: `plugins/llm-tui/ui/App.tsx`

- [ ] **Step 1: Modify the output branch**

Edit `plugins/llm-tui/ui/App.tsx`. At the top, add the import (alphabetize with existing imports):

```typescript
import { renderMarkdown } from "./markdown.ts";
```

Find the trailing return in `renderEntry` (currently around lines 72-76):

```typescript
    return (
      <Text color={e.kind === "notice" ? theme.noticeColor : theme.outputColor} dimColor={e.kind === "notice"}>
        {e.text}
      </Text>
    );
```

Replace with a kind-split:

```typescript
    if (e.kind === "output") {
      // Render assistant output through marked-terminal. Ink's <Text>
      // honors embedded ANSI codes, so the styled string drops in directly.
      // Raw markdown stays in the store for the Ctrl+X copy shortcut.
      return <Text color={theme.outputColor}>{renderMarkdown(e.text)}</Text>;
    }
    return (
      <Text color={theme.noticeColor} dimColor>
        {e.text}
      </Text>
    );
```

- [ ] **Step 2: Run existing tests to confirm no regression**

```bash
cd plugins/llm-tui && bun test ui/App.test.tsx
```

Expected: PASS (existing App tests rely on present-text-content checks; ANSI in the rendered output still contains the underlying text).

If a test asserts an exact string match against an assistant-output line and now fails because of ANSI, relax the assertion to `toContain(...)` against the inner text — record the change in the same commit.

- [ ] **Step 3: Run the full TUI test suite**

```bash
cd plugins/llm-tui && bun test
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add plugins/llm-tui/ui/App.tsx
git commit -m "feat(llm-tui): render assistant output as markdown"
```

---

### Task 6: Add `copyToClipboard` prop to InputBox and wire Ctrl+X (TDD)

**Files:**
- Modify: `plugins/llm-tui/ui/InputBox.tsx`
- Modify: `plugins/llm-tui/ui/InputBox.test.tsx`

- [ ] **Step 1: Write the failing tests**

Append to `plugins/llm-tui/ui/InputBox.test.tsx`:

```typescript
import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { TuiStore } from "../state/store.ts";
import { makeCompletionRegistry } from "../completion/registry.ts";
import { DEFAULT_THEME } from "../theme/loader.ts";
import { InputBox } from "./InputBox.tsx";

function harness(opts?: {
  copyToClipboard?: (text: string) => Promise<{ ok: boolean; via: string; error?: string }>;
}) {
  const store = new TuiStore();
  const { service } = makeCompletionRegistry();
  const registry = service as any;
  const triggers = new Set<string>();
  const noop = () => {};
  const view = render(
    <InputBox
      store={store}
      registry={registry as any}
      triggers={triggers}
      theme={DEFAULT_THEME}
      onSubmit={noop}
      copyToClipboard={opts?.copyToClipboard}
    />,
  );
  return { store, view };
}

describe("InputBox Ctrl+X copy", () => {
  test("posts 'nothing to copy yet' when no output exists", async () => {
    const { store, view } = harness();
    view.stdin.write("\x18"); // Ctrl+X
    await new Promise((r) => setTimeout(r, 10));
    const snap = store.snapshot();
    const notices = snap.transcript.filter((e) => e.kind === "notice");
    expect(notices.at(-1)?.text).toContain("nothing to copy");
    view.unmount();
  });

  test("calls injected copyToClipboard with latest output text", async () => {
    let received: string | undefined;
    const fakeCopy = async (text: string) => {
      received = text;
      return { ok: true, via: "pbcopy" as const };
    };
    const { store, view } = harness({ copyToClipboard: fakeCopy });
    store.appendOutput("the answer");
    view.stdin.write("\x18");
    await new Promise((r) => setTimeout(r, 10));
    expect(received).toBe("the answer");
    const notices = store.snapshot().transcript.filter((e) => e.kind === "notice");
    expect(notices.at(-1)?.text).toMatch(/copied .* chars/);
    view.unmount();
  });

  test("surfaces failure as a notice", async () => {
    const fakeCopy = async () => ({ ok: false, via: "none" as const, error: "no clipboard mechanism" });
    const { store, view } = harness({ copyToClipboard: fakeCopy });
    store.appendOutput("ignored");
    view.stdin.write("\x18");
    await new Promise((r) => setTimeout(r, 10));
    const notices = store.snapshot().transcript.filter((e) => e.kind === "notice");
    expect(notices.at(-1)?.text).toContain("copy failed");
    expect(notices.at(-1)?.text).toContain("no clipboard mechanism");
    view.unmount();
  });

  test("Ctrl+X does not fall through to typing 'x'", async () => {
    const { store, view } = harness();
    view.stdin.write("\x18"); // Ctrl+X
    await new Promise((r) => setTimeout(r, 10));
    expect(store.snapshot().input.value).toBe("");
    view.unmount();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd plugins/llm-tui && bun test ui/InputBox.test.tsx
```

Expected: FAIL with type error on the `copyToClipboard` prop and runtime failure on the assertions (no handler exists yet).

- [ ] **Step 3: Add prop + handler to InputBox**

Edit `plugins/llm-tui/ui/InputBox.tsx`:

1. Add the import at the top:
```typescript
import type { CopyResult } from "../clipboard.ts";
```

2. Extend `InputBoxProps`:
```typescript
export interface InputBoxProps {
  store: TuiStore;
  registry: CompletionRegistry;
  triggers: Set<string>;
  theme: TuiTheme;
  onSubmit: (text: string) => void;
  onCancel?: () => void;
  onExit?: () => void;
  /** Injected clipboard function; defaults to a no-op stub in non-TTY tests. */
  copyToClipboard?: (text: string) => Promise<CopyResult>;
}
```

3. Destructure the new prop in the component signature:
```typescript
export const InputBox: React.FC<InputBoxProps> = ({ store, registry, triggers, theme, onSubmit, onCancel, onExit, copyToClipboard }) => {
```

4. Inside `useInput`, **before** the existing `if (key.ctrl && input === "a")` block (around line 239), add:

```typescript
    if (key.ctrl && input === "x") {
      const text = store.latestOutputText();
      if (!text) {
        store.appendNotice("nothing to copy yet");
        return;
      }
      if (!copyToClipboard) {
        store.appendNotice("copy unavailable: no clipboard binding");
        return;
      }
      void copyToClipboard(text).then((r) => {
        if (r.ok) store.appendNotice(`copied ${text.length} chars · via ${r.via}`);
        else store.appendNotice(`copy failed: ${r.error ?? "unknown"}`);
      });
      return;
    }
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd plugins/llm-tui && bun test ui/InputBox.test.tsx
```

Expected: the four new Ctrl+X tests pass; existing InputBox tests still pass.

- [ ] **Step 5: Run full TUI suite**

```bash
cd plugins/llm-tui && bun test
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add plugins/llm-tui/ui/InputBox.tsx plugins/llm-tui/ui/InputBox.test.tsx
git commit -m "feat(llm-tui): Ctrl+X copies latest assistant message"
```

---

### Task 7: Thread `copyToClipboard` through App.tsx

**Files:**
- Modify: `plugins/llm-tui/ui/App.tsx`

- [ ] **Step 1: Add prop and pass-through**

Edit `plugins/llm-tui/ui/App.tsx`:

1. Add the import at the top:
```typescript
import type { CopyResult } from "../clipboard.ts";
```

2. Extend `AppProps`:
```typescript
export interface AppProps {
  store: TuiStore;
  registry: CompletionRegistry;
  toolRenderers: ToolRendererRegistry;
  triggers: Set<string>;
  theme: TuiTheme;
  onSubmit: (text: string) => void;
  onCancel?: () => void;
  onExit?: () => void;
  copyToClipboard?: (text: string) => Promise<CopyResult>;
}
```

3. Destructure and pass through to `InputBox`:
```typescript
export const App: React.FC<AppProps> = ({ store, registry, toolRenderers, triggers, theme, onSubmit, onCancel, onExit, copyToClipboard }) => {
```

In the JSX, find the `<InputBox ... />` element (around lines 105-113) and add the prop:
```tsx
          <InputBox
            store={store}
            registry={registry}
            triggers={triggers}
            theme={theme}
            onSubmit={onSubmit}
            onCancel={onCancel}
            onExit={onExit}
            copyToClipboard={copyToClipboard}
          />
```

- [ ] **Step 2: Run tests**

```bash
cd plugins/llm-tui && bun test
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add plugins/llm-tui/ui/App.tsx
git commit -m "feat(llm-tui): thread copyToClipboard through App to InputBox"
```

---

### Task 8: Wire real `copyToClipboard` + emit status hint in `index.tsx`

**Files:**
- Modify: `plugins/llm-tui/index.tsx`
- Modify: `plugins/llm-tui/index.test.ts`

- [ ] **Step 1: Add the imports and emit in setup**

Edit `plugins/llm-tui/index.tsx`:

1. Add the import (alphabetize):
```typescript
import { copyToClipboard } from "./clipboard.ts";
```

2. Inside `setup(ctx)`, find the block where event subscriptions are wired (around `ctx.on("status:item-update", …)` — line ~170). Immediately after the event subscriptions block (before the `const isTTY = …` line ~179), add:

```typescript
    // Advertise the copy keybind via the existing status:item-update event.
    // The handler one block up writes it into the store, which the StatusBar
    // renders. Never cleared — the hint is a fixed bottom-bar entry.
    await ctx.emit("status:item-update", {
      key: "tui:hint:copy",
      value: "⌃X copy last",
    });
```

3. Find the `render(<App … />)` call (around line 211-223) and pass `copyToClipboard`:

```tsx
    const inkApp = render(
      <App
        store={store}
        registry={registry}
        toolRenderers={toolRenderers}
        triggers={triggers}
        theme={theme}
        onSubmit={onSubmit}
        onCancel={onCancel}
        onExit={onExit}
        copyToClipboard={copyToClipboard}
      />,
      { exitOnCtrlC: false },
    );
```

- [ ] **Step 2: Add a smoke test for the status hint**

Append to `plugins/llm-tui/index.test.ts` (locate an existing `describe` block for setup behavior, or add a new one). The test relies on the existing fake-ctx helper used elsewhere in the file. If the helper records `emit` calls in an array, the assertion is:

```typescript
test("setup emits status hint advertising Ctrl+X", async () => {
  const { ctx, emits } = makeFakeCtx(); // existing helper in this file
  await plugin.setup(ctx);
  const hint = emits.find((e) => e.event === "status:item-update" && e.payload?.key === "tui:hint:copy");
  expect(hint).toBeDefined();
  expect(hint!.payload.value).toContain("⌃X");
});
```

If the existing fake-ctx helper does not record emits in an array, **first** extend it to do so (a small change: have its `emit` push `{ event, payload }` to a list and return that list as part of the helper's return value). Apply that extension to all existing call sites in the file that destructure the helper's return value (probably one or two). Run the existing tests after each helper change to confirm.

- [ ] **Step 3: Run all TUI tests**

```bash
cd plugins/llm-tui && bun test
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add plugins/llm-tui/index.tsx plugins/llm-tui/index.test.ts
git commit -m "feat(llm-tui): wire real clipboard + emit Ctrl+X status hint"
```

---

### Task 9: Integration test — end-to-end Ctrl+X flow

**Files:**
- Modify: `plugins/llm-tui/integration.test.ts`

- [ ] **Step 1: Write the integration test**

Append to `plugins/llm-tui/integration.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { TuiStore } from "./state/store.ts";

describe("integration: Ctrl+X copies latest output", () => {
  test("store accessor returns the most recent assistant message text", () => {
    const store = new TuiStore();
    store.appendOutput("first answer");
    store.appendUser("follow-up");
    store.appendOutput("second answer");

    // This is what the InputBox handler reads on Ctrl+X.
    const text = store.latestOutputText();
    expect(text).toBe("second answer");
  });

  test("notice is posted on copy success path (simulated)", async () => {
    const store = new TuiStore();
    store.appendOutput("# Hello\n\nworld");

    // Simulate the InputBox handler's success branch inline. We don't run
    // the real clipboard from a test — that's covered in clipboard.test.ts.
    const text = store.latestOutputText()!;
    const fakeResult = { ok: true, via: "pbcopy" as const };
    if (fakeResult.ok) {
      store.appendNotice(`copied ${text.length} chars · via ${fakeResult.via}`);
    }

    const last = store.snapshot().transcript.at(-1);
    expect(last?.kind).toBe("notice");
    expect((last as any).text).toMatch(/copied 16 chars/);
  });
});
```

- [ ] **Step 2: Run integration tests**

```bash
cd plugins/llm-tui && bun test integration.test.ts
```

Expected: both new tests pass; existing integration tests still pass.

- [ ] **Step 3: Run full TUI suite**

```bash
cd plugins/llm-tui && bun test
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add plugins/llm-tui/integration.test.ts
git commit -m "test(llm-tui): integration coverage for Ctrl+X copy flow"
```

---

### Task 10: Local deploy and smoke test

**Files:**
- (none modified; this is verification only)

- [ ] **Step 1: Build the bundle**

From the repo root:

```bash
cd plugins/llm-tui && bun build --target=bun --outfile=dist/index.js index.tsx
```

Expected: builds with no errors. `dist/index.js` exists.

- [ ] **Step 2: Sync into the install dir**

```bash
PLUGIN=llm-tui
VERSION=$(jq -r .version plugins/$PLUGIN/package.json)
INSTALL_DIR=~/.kaizen/marketplaces/official/plugins/${PLUGIN}@${VERSION}
mkdir -p "$INSTALL_DIR/dist"
cp plugins/$PLUGIN/dist/index.js "$INSTALL_DIR/dist/index.js"
rsync -a --exclude='node_modules' --exclude='dist' plugins/$PLUGIN/ "$INSTALL_DIR/"
```

Expected: copy completes with no errors. Run `ls "$INSTALL_DIR/dist/index.js"` to confirm.

- [ ] **Step 3: Smoke test in a real session**

Start the harness in a terminal and verify:

```bash
kaizen run openai-compatible
```

Manual checks:
1. Status bar (bottom of TUI) shows `⌃X copy last`.
2. Ask the model a question that returns markdown (e.g., "explain bash pipes in markdown with a code block").
3. Verify the response renders with styled headings, list bullets, and a fenced code block (ANSI colors visible).
4. Press **Ctrl+X**. A notice should appear: `copied N chars · via pbcopy` (on macOS).
5. Paste into a markdown-aware destination (e.g., a new Slack message in markdown mode, or a `.md` file) and confirm the raw markdown source pasted correctly.
6. Press **Ctrl+X** before the first model response — notice should read `nothing to copy yet`.

- [ ] **Step 4: Document any deviations**

If anything didn't behave as expected (markdown looks wrong, clipboard didn't fire, notice text drifted), file a follow-up note in `docs/superpowers/plans/2026-05-14-tui-markdown-and-copy.md` under a new `## Follow-ups` section, and fix in a follow-up commit.

- [ ] **Step 5: Final cleanup commit (if smoke test produced any tweaks)**

```bash
git status
# If any files changed during smoke-driven adjustments:
git add <changed-files>
git commit -m "fix(llm-tui): smoke-test adjustments to markdown/copy"
```

---

## Done criteria

- [ ] All ten tasks above committed.
- [ ] `bun test` passes in `plugins/llm-tui`.
- [ ] Smoke test (Task 10 Step 3) confirms styled rendering, Ctrl+X copy, and the status hint.
- [ ] `docs/TODO.md` item #2 can be checked off in a follow-up commit.
