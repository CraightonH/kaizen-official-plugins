# Claude Code Wrapper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the existing `events`/`shell`/`driver` example plugins with a Claude Code wrapper ecosystem (4 plugins + 1 harness) targeting kaizen 0.3.0.

**Architecture:** Four kaizen plugins. `claude-events` defines the event vocabulary. `claude-tui` provides `ui:channel` (stdin reader, stdout writer, status bar renderer) and emits `turn:cancel` on Ctrl-C. `claude-status-items` emits `cwd` and `git.branch` items. `claude-driver` is the session driver — it spawns `claude -p <prompt> --output-format stream-json …` per turn, parses the NDJSON stream, fans out text deltas to `ui:channel`, and emits `llm.model` / `llm.context` status items.

**Tech Stack:** TypeScript ESM, Bun, kaizen 0.3.0 (`PLUGIN_API_VERSION = "3"`), bun:test, Node `child_process.spawn`, Node `readline`.

**Spec:** `docs/superpowers/specs/2026-04-27-claude-wrapper-design.md`

---

## File Structure

### To delete

- `plugins/events/` (entire dir)
- `plugins/shell/` (entire dir)
- `plugins/driver/` (entire dir)
- `harnesses/minimum-shell.json`
- The four matching entries in `.kaizen/marketplace.json`

### To create

```
plugins/claude-events/
  package.json
  tsconfig.json
  index.ts            # KaizenPlugin default export; defines events, provides claude-events:vocabulary
  public.d.ts         # exports VOCAB and Vocab type
  index.test.ts
  README.md
  .kaizen/.gitkeep

plugins/claude-tui/
  package.json
  tsconfig.json
  index.ts            # plugin: provides ui:channel, subscribes to status events, owns slash commands
  public.d.ts         # exports UiChannel, StatusItem types
  render.ts           # pure renderer: takes (state) → ANSI string
  input.ts            # readline wrapper, exposes readInput() with cancel/EOF handling
  index.test.ts
  render.test.ts
  README.md
  .kaizen/.gitkeep

plugins/claude-status-items/
  package.json
  tsconfig.json
  index.ts            # subscribes session:start, emits cwd and git.branch items
  index.test.ts
  README.md
  .kaizen/.gitkeep

plugins/claude-driver/
  package.json
  tsconfig.json
  index.ts            # plugin manifest; start() runs the loop
  parser.ts           # pure NDJSON event parser (testable in isolation)
  spawn.ts            # spawn helper, isolates child_process so tests can mock it
  busy-messages.ts    # array of cutesy "thinking…" strings, picked at random
  index.test.ts       # plugin-level test (metadata + setup)
  parser.test.ts      # exhaustive parser tests
  loop.test.ts        # start() loop test with stubbed spawn + ui:channel
  README.md
  .kaizen/.gitkeep

harnesses/claude-wrapper.json
```

### To modify

- `.kaizen/marketplace.json` — replace entries, bump catalog description.
- `README.md` — replace minimum-shell mention with claude-wrapper.

---

## Task 1 — Clean out the old plugins

**Files:**
- Delete: `plugins/events/`, `plugins/shell/`, `plugins/driver/`, `harnesses/minimum-shell.json`
- Modify: `.kaizen/marketplace.json` — remove all four entries

- [ ] **Step 1: Verify nothing else references the old plugins**

```bash
grep -r "minimum-shell\|plugins/shell\|plugins/driver\|plugins/events" \
  --include="*.json" --include="*.ts" --include="*.md" \
  /Users/chancock/git/kaizen-official-plugins
```

Expected: only matches in the files about to be deleted (and possibly `README.md` — note for Task 12).

- [ ] **Step 2: Delete plugin directories and harness file**

```bash
cd /Users/chancock/git/kaizen-official-plugins
rm -rf plugins/events plugins/shell plugins/driver
rm harnesses/minimum-shell.json
```

- [ ] **Step 3: Rewrite `.kaizen/marketplace.json` with empty `entries`**

Replace the file with:

```json
{
  "version": "1.0.0",
  "name": "kaizen-official",
  "description": "Official kaizen plugins and harnesses.",
  "url": "https://github.com/CraightonH/kaizen-official-plugins.git",
  "entries": []
}
```

(Tasks 7–10 will repopulate.)

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: drop minimum-shell example ecosystem"
```

---

## Task 2 — Scaffold `claude-events`

**Files:**
- Create: `plugins/claude-events/{package.json,tsconfig.json,index.ts,public.d.ts,index.test.ts,README.md,.kaizen/.gitkeep}`

- [ ] **Step 1: Write `plugins/claude-events/package.json`**

```json
{
  "name": "claude-events",
  "version": "0.1.0",
  "description": "Event vocabulary for the claude-wrapper harness",
  "type": "module",
  "exports": { ".": "./index.ts" },
  "keywords": ["kaizen-plugin"],
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "^5.4.0"
  }
}
```

- [ ] **Step 2: Write `plugins/claude-events/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true
  }
}
```

- [ ] **Step 3: Write `plugins/claude-events/public.d.ts`**

```ts
export interface Vocab {
  readonly SESSION_START: "session:start";
  readonly SESSION_END: "session:end";
  readonly SESSION_ERROR: "session:error";
  readonly TURN_BEFORE: "turn:before";
  readonly TURN_AFTER: "turn:after";
  readonly TURN_CANCEL: "turn:cancel";
  readonly STATUS_ITEM_UPDATE: "status:item-update";
  readonly STATUS_ITEM_CLEAR: "status:item-clear";
}
export type EventName = Vocab[keyof Vocab];

export interface StatusItem {
  id: string;
  content: string;
  priority?: number;
  ttlMs?: number;
}

export interface TurnAfterPayload {
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  durationMs: number;
}
```

- [ ] **Step 4: Write the failing test `plugins/claude-events/index.test.ts`**

```ts
import { describe, it, expect, mock } from "bun:test";
import plugin from "./index.ts";

function makeCtx() {
  const defined: string[] = [];
  const provided: Record<string, unknown> = {};
  return {
    defined,
    provided,
    log: mock(() => {}),
    config: {},
    defineEvent: mock((name: string) => { defined.push(name); }),
    on: mock(() => {}),
    emit: mock(async () => []),
    defineService: mock(() => {}),
    provideService: mock((name: string, impl: unknown) => { provided[name] = impl; }),
    consumeService: mock(() => {}),
    useService: mock(() => undefined),
    secrets: { get: mock(async () => undefined), refresh: mock(async () => undefined) },
  } as any;
}

describe("claude-events", () => {
  it("has correct metadata", () => {
    expect(plugin.name).toBe("claude-events");
    expect(plugin.apiVersion).toBe("3.0.0");
  });

  it("provides claude-events:vocabulary", async () => {
    const ctx = makeCtx();
    await plugin.setup(ctx);
    expect(ctx.provided["claude-events:vocabulary"]).toBeDefined();
    const vocab = ctx.provided["claude-events:vocabulary"] as Record<string, string>;
    expect(vocab.SESSION_START).toBe("session:start");
    expect(vocab.TURN_CANCEL).toBe("turn:cancel");
    expect(vocab.STATUS_ITEM_UPDATE).toBe("status:item-update");
  });

  it("defines all 8 event names", async () => {
    const ctx = makeCtx();
    await plugin.setup(ctx);
    expect(ctx.defined).toEqual([
      "session:start", "session:end", "session:error",
      "turn:before", "turn:after", "turn:cancel",
      "status:item-update", "status:item-clear",
    ]);
  });
});
```

- [ ] **Step 5: Run the test, watch it fail**

```bash
cd plugins/claude-events && bun test
```

Expected: FAIL — module `./index.ts` not found.

- [ ] **Step 6: Write `plugins/claude-events/index.ts`**

```ts
import type { KaizenPlugin } from "kaizen/types";
import type { Vocab } from "./public";

export const VOCAB: Vocab = Object.freeze({
  SESSION_START: "session:start",
  SESSION_END: "session:end",
  SESSION_ERROR: "session:error",
  TURN_BEFORE: "turn:before",
  TURN_AFTER: "turn:after",
  TURN_CANCEL: "turn:cancel",
  STATUS_ITEM_UPDATE: "status:item-update",
  STATUS_ITEM_CLEAR: "status:item-clear",
} as const);

const plugin: KaizenPlugin = {
  name: "claude-events",
  apiVersion: "3.0.0",
  permissions: { tier: "trusted" },
  services: { provides: ["claude-events:vocabulary"] },

  async setup(ctx) {
    ctx.defineService("claude-events:vocabulary", {
      description: "Event-name vocabulary for the claude-wrapper harness.",
    });
    ctx.provideService<Vocab>("claude-events:vocabulary", VOCAB);
    for (const name of Object.values(VOCAB)) ctx.defineEvent(name);
    ctx.log("claude-events ready");
  },
};

export default plugin;
```

- [ ] **Step 7: Run the test, watch it pass**

```bash
bun test
```

Expected: 3 passing.

- [ ] **Step 8: Write `plugins/claude-events/README.md`**

```md
# claude-events

Event vocabulary for the claude-wrapper harness. Pure vocab plugin: defines event names and provides them as the `claude-events:vocabulary` service.

## Events

- `session:start`, `session:end`, `session:error`
- `turn:before`, `turn:after`, `turn:cancel`
- `status:item-update`, `status:item-clear`

## Permissions

Tier: `trusted`. No I/O.

## Development

```sh
bun install
bun test
```
```

- [ ] **Step 9: Create `.kaizen/.gitkeep`**

```bash
mkdir -p plugins/claude-events/.kaizen && touch plugins/claude-events/.kaizen/.gitkeep
```

- [ ] **Step 10: Validate**

```bash
cd /Users/chancock/git/kaizen-official-plugins/plugins/claude-events && \
  bun install && bun test && kaizen plugin validate .
```

Expected: tests pass, validate exits 0.

- [ ] **Step 11: Commit**

```bash
cd /Users/chancock/git/kaizen-official-plugins
git add plugins/claude-events
git commit -m "feat(claude-events): event vocabulary plugin"
```

---

## Task 3 — `claude-tui`: types and renderer

**Files:**
- Create: `plugins/claude-tui/{package.json,tsconfig.json,public.d.ts,render.ts,render.test.ts}`

The renderer is pure — input is bar state, output is an ANSI-decorated string. Testable without any kaizen context.

- [ ] **Step 1: Write `plugins/claude-tui/package.json`**

```json
{
  "name": "claude-tui",
  "version": "0.1.0",
  "description": "Terminal UI for claude-wrapper: prompt box + status bar",
  "type": "module",
  "exports": { ".": "./index.ts" },
  "keywords": ["kaizen-plugin"],
  "devDependencies": {
    "@types/bun": "latest",
    "@types/node": "^20.0.0",
    "typescript": "^5.4.0"
  }
}
```

- [ ] **Step 2: Write `plugins/claude-tui/tsconfig.json`** (same body as claude-events tsconfig — Step 2 of Task 2).

- [ ] **Step 3: Write `plugins/claude-tui/public.d.ts`**

```ts
export interface UiChannel {
  readInput(): Promise<string>;
  writeOutput(chunk: string): void;
  writeNotice(line: string): void;
  setBusy(busy: boolean, message?: string): void;
}
```

- [ ] **Step 4: Write `plugins/claude-tui/render.test.ts`**

```ts
import { describe, it, expect } from "bun:test";
import { renderPrompt, renderStatusRow, type StatusItem } from "./render.ts";

describe("renderPrompt", () => {
  it("draws a rounded box with kaizen title and an empty caret line", () => {
    const out = renderPrompt({ width: 60, busy: false, busyMessage: undefined });
    const lines = out.split("\n");
    expect(lines[0]).toMatch(/^╭─ kaizen ─+╮$/);
    expect(lines[1]).toMatch(/^│ ❯ +│$/);
    expect(lines[2]).toMatch(/^╰─+╯$/);
  });

  it("shows busy message inside the box when busy=true", () => {
    const out = renderPrompt({ width: 60, busy: true, busyMessage: "thinking…" });
    expect(out).toContain("thinking…");
    expect(out).not.toMatch(/^│ ❯ +│$/m);
  });
});

describe("renderStatusRow", () => {
  it("orders items by priority ascending and joins with ' · '", () => {
    const items: StatusItem[] = [
      { id: "git.branch", content: "main", priority: 90 },
      { id: "llm.model", content: "opus-4.7", priority: 10 },
      { id: "cwd", content: "kaizen-official-plugins", priority: 80 },
    ];
    const out = renderStatusRow(items, 80);
    // Strip ANSI for assertion
    const plain = out.replace(/\x1b\[[0-9;]*m/g, "");
    expect(plain).toBe(" opus-4.7 · kaizen-official-plugins · main");
  });

  it("renders empty when no items", () => {
    expect(renderStatusRow([], 80)).toBe("");
  });
});
```

- [ ] **Step 5: Run, watch fail**

```bash
cd plugins/claude-tui && bun install && bun test
```

Expected: FAIL — module `./render.ts` not found.

- [ ] **Step 6: Write `plugins/claude-tui/render.ts`**

```ts
export interface StatusItem {
  id: string;
  content: string;
  priority?: number;
  ttlMs?: number;
  expiresAt?: number;
}

export interface PromptState {
  width: number;
  busy: boolean;
  busyMessage?: string;
}

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  accent: "\x1b[35m",   // magenta-ish; close enough to "kaizen purple" without truecolor.
  yellow: "\x1b[33m",
};

export function renderPrompt(state: PromptState): string {
  const w = Math.max(20, state.width);
  const titleRaw = " kaizen ";
  // top: ╭─ kaizen ─...─╮
  const dashes = w - 2 /* corners */ - 1 /* leading dash */ - titleRaw.length;
  const top = `${C.accent}╭─${titleRaw}${"─".repeat(Math.max(0, dashes))}╮${C.reset}`;
  const inner = w - 2;
  const innerContent = state.busy
    ? ` ⠙ ${C.yellow}${state.busyMessage ?? "thinking…"}${C.reset}`
    : ` ${C.accent}❯${C.reset} `;
  const visibleLen = stripAnsi(innerContent).length;
  const padded = innerContent + " ".repeat(Math.max(0, inner - visibleLen));
  const middle = `${C.accent}│${C.reset}${padded}${C.accent}│${C.reset}`;
  const bottom = `${C.accent}╰${"─".repeat(w - 2)}╯${C.reset}`;
  return `${top}\n${middle}\n${bottom}`;
}

export function renderStatusRow(items: StatusItem[], width: number): string {
  if (items.length === 0) return "";
  const sorted = [...items].sort((a, b) => (a.priority ?? 50) - (b.priority ?? 50));
  const parts = sorted.map((it) => it.content);
  const joined = ` ${parts.join(` ${C.dim}·${C.reset} `)}`;
  // Truncation: if visible length exceeds width, drop trailing items until it fits.
  if (stripAnsi(joined).length <= width) return joined;
  let take = sorted.length;
  while (take > 1) {
    take -= 1;
    const trimmed = ` ${sorted.slice(0, take).map((it) => it.content).join(` ${C.dim}·${C.reset} `)}…`;
    if (stripAnsi(trimmed).length <= width) return trimmed;
  }
  return ` ${sorted[0].content.slice(0, Math.max(0, width - 2))}…`;
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}
```

- [ ] **Step 7: Run, watch pass**

```bash
bun test
```

Expected: 4 passing.

- [ ] **Step 8: Commit**

```bash
cd /Users/chancock/git/kaizen-official-plugins
git add plugins/claude-tui/{package.json,tsconfig.json,public.d.ts,render.ts,render.test.ts}
git commit -m "feat(claude-tui): pure status bar + prompt renderer"
```

---

## Task 4 — `claude-tui`: input + plugin wiring

**Files:**
- Create: `plugins/claude-tui/{input.ts,index.ts,index.test.ts,README.md,.kaizen/.gitkeep}`

- [ ] **Step 1: Write `plugins/claude-tui/input.ts`**

```ts
import * as readline from "node:readline";

export interface InputReader {
  readLine(): Promise<string>;     // resolves on Enter; "" on EOF.
  close(): void;
}

export function createInputReader(opts?: {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  onSigInt?: () => void;
}): InputReader {
  const rl = readline.createInterface({
    input: opts?.input ?? process.stdin,
    output: opts?.output ?? process.stdout,
    terminal: true,
  });
  let pendingResolve: ((s: string) => void) | null = null;

  rl.on("line", (line) => {
    const r = pendingResolve;
    pendingResolve = null;
    r?.(line);
  });
  rl.on("close", () => {
    const r = pendingResolve;
    pendingResolve = null;
    r?.("");
  });
  if (opts?.onSigInt) {
    rl.on("SIGINT", opts.onSigInt);
  } else {
    rl.on("SIGINT", () => rl.close());
  }

  return {
    readLine() {
      return new Promise((resolve) => { pendingResolve = resolve; });
    },
    close() { rl.close(); },
  };
}
```

- [ ] **Step 2: Write the failing test `plugins/claude-tui/index.test.ts`**

```ts
import { describe, it, expect, mock } from "bun:test";
import plugin from "./index.ts";

function makeCtx() {
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

describe("claude-tui", () => {
  it("has correct metadata", () => {
    expect(plugin.name).toBe("claude-tui");
    expect(plugin.apiVersion).toBe("3.0.0");
    expect(plugin.permissions?.tier).toBe("unscoped");
  });

  it("provides ui:channel and subscribes to status events", async () => {
    const ctx = makeCtx();
    await plugin.setup(ctx);
    expect(ctx.provided["ui:channel"]).toBeDefined();
    expect(ctx.subs["status:item-update"]?.length).toBe(1);
    expect(ctx.subs["status:item-clear"]?.length).toBe(1);
  });

  it("ui.writeOutput writes the chunk verbatim", async () => {
    const ctx = makeCtx();
    const writes: string[] = [];
    process.stdout.write = ((c: string) => { writes.push(String(c)); return true; }) as any;
    await plugin.setup(ctx);
    const ui = ctx.provided["ui:channel"] as any;
    ui.writeOutput("hello");
    expect(writes.join("")).toContain("hello");
  });
});
```

(The plugin's `setup` writes nothing to stdout; tests stub `process.stdout.write` to capture the writeOutput call.)

- [ ] **Step 3: Run, watch fail**

```bash
cd plugins/claude-tui && bun test
```

Expected: FAIL — `./index.ts` not found.

- [ ] **Step 4: Write `plugins/claude-tui/index.ts`**

```ts
import type { KaizenPlugin } from "kaizen/types";
import type { UiChannel } from "./public";
import type { StatusItem } from "./render";
import { renderPrompt, renderStatusRow } from "./render.ts";
import { createInputReader } from "./input.ts";

const SLASH_COMMANDS = new Set(["/exit", "/clear"]);

const plugin: KaizenPlugin = {
  name: "claude-tui",
  apiVersion: "3.0.0",
  permissions: { tier: "unscoped" },
  services: {
    provides: ["ui:channel"],
    consumes: ["claude-events:vocabulary"],
  },

  async setup(ctx) {
    ctx.consumeService("claude-events:vocabulary");
    ctx.defineService("ui:channel", { description: "Terminal UI channel: input + output + status bar." });

    const items = new Map<string, StatusItem>();
    let busy = false;
    let busyMessage: string | undefined;

    function repaint() {
      const cols = process.stdout.columns ?? 80;
      const prompt = renderPrompt({ width: Math.min(cols, 100), busy, busyMessage });
      const status = renderStatusRow([...items.values()], cols);
      // Clear current line region, redraw. Simple approach: write CR + ANSI clear.
      process.stdout.write("\x1b[2K\r");
      process.stdout.write(prompt + "\n" + status + "\n");
    }

    const input = createInputReader({
      onSigInt: () => {
        if (busy) {
          ctx.emit("turn:cancel").catch(() => {});
        } else {
          process.exit(0);
        }
      },
    });

    ctx.on("status:item-update", async (payload: any) => {
      if (!payload?.id) return;
      items.set(payload.id, payload as StatusItem);
      if (!busy) repaint();
    });
    ctx.on("status:item-clear", async (payload: any) => {
      if (!payload?.id) return;
      items.delete(payload.id);
      if (!busy) repaint();
    });

    const ui: UiChannel = {
      async readInput() {
        repaint();
        while (true) {
          const line = await input.readLine();
          if (line === "") return ""; // EOF
          if (SLASH_COMMANDS.has(line.trim())) {
            if (line.trim() === "/exit") return "";
            if (line.trim() === "/clear") {
              process.stdout.write("\x1b[2J\x1b[H");
              repaint();
              continue;
            }
          }
          return line;
        }
      },
      writeOutput(chunk: string) {
        process.stdout.write(chunk);
      },
      writeNotice(line: string) {
        process.stdout.write(`\x1b[2m${line}\x1b[0m\n`);
      },
      setBusy(b: boolean, message?: string) {
        busy = b;
        busyMessage = message;
        repaint();
      },
    };

    ctx.provideService<UiChannel>("ui:channel", ui);
    ctx.log("claude-tui ready");
  },

  async stop() {
    // readline close happens at process exit; nothing to do.
  },
};

export default plugin;
```

- [ ] **Step 5: Run, watch pass**

```bash
bun test
```

Expected: 4 passing (3 plugin + 4 render = 7 total).

- [ ] **Step 6: Write `plugins/claude-tui/README.md`**

```md
# claude-tui

Terminal UI for the claude-wrapper harness. Provides `ui:channel` (input/output/notices/setBusy) and renders a rounded "kaizen"-titled prompt box plus a status bar that subscribes to `status:item-update` events.

## Slash commands

- `/exit` — ends the session (equivalent to Ctrl-D).
- `/clear` — clears the terminal and re-renders.

## Permissions

Tier: `unscoped`. Reason: needs raw `process.stdin` and `process.stdout`.

## Development

```sh
bun install
bun test
```
```

- [ ] **Step 7: gitkeep + validate + commit**

```bash
mkdir -p plugins/claude-tui/.kaizen && touch plugins/claude-tui/.kaizen/.gitkeep
cd plugins/claude-tui && kaizen plugin validate .
cd /Users/chancock/git/kaizen-official-plugins
git add plugins/claude-tui
git commit -m "feat(claude-tui): plugin wiring + input reader"
```

---

## Task 5 — `claude-status-items`

**Files:**
- Create: `plugins/claude-status-items/{package.json,tsconfig.json,index.ts,index.test.ts,README.md,.kaizen/.gitkeep}`

- [ ] **Step 1: Write `package.json`** (same shape as Task 2 with `name: "claude-status-items"`, description: `"Default cwd + git.branch status items"`).

- [ ] **Step 2: Write `tsconfig.json`** (same as prior tasks).

- [ ] **Step 3: Write the failing test `index.test.ts`**

```ts
import { describe, it, expect, mock } from "bun:test";
import plugin from "./index.ts";

function makeCtx(execImpl?: (bin: string, args: string[]) => Promise<any>) {
  const subs: Record<string, Function[]> = {};
  const emitted: Array<{ event: string; payload: any }> = [];
  return {
    subs,
    emitted,
    log: mock(() => {}),
    config: {},
    defineEvent: mock(() => {}),
    on: mock((event: string, h: Function) => { (subs[event] ??= []).push(h); }),
    emit: mock(async (event: string, payload?: any) => {
      emitted.push({ event, payload });
      return [];
    }),
    defineService: mock(() => {}),
    provideService: mock(() => {}),
    consumeService: mock(() => {}),
    useService: mock(() => undefined),
    secrets: { get: mock(async () => undefined), refresh: mock(async () => undefined) },
    exec: { run: mock(execImpl ?? (async () => ({ stdout: "main\n", stderr: "", exitCode: 0 }))) },
  } as any;
}

describe("claude-status-items", () => {
  it("has correct metadata + scoped tier with git", () => {
    expect(plugin.name).toBe("claude-status-items");
    expect(plugin.apiVersion).toBe("3.0.0");
    expect(plugin.permissions?.tier).toBe("scoped");
    expect(plugin.permissions?.exec?.binaries).toContain("git");
  });

  it("emits cwd and git.branch on session:start", async () => {
    const ctx = makeCtx();
    await plugin.setup(ctx);
    const handler = ctx.subs["session:start"]?.[0];
    expect(handler).toBeDefined();
    await handler!();
    const ids = ctx.emitted.filter((e) => e.event === "status:item-update").map((e) => e.payload.id);
    expect(ids).toContain("cwd");
    expect(ids).toContain("git.branch");
  });

  it("omits git.branch when not in a repo", async () => {
    const ctx = makeCtx(async () => ({ stdout: "", stderr: "fatal: not a git repository", exitCode: 128 }));
    await plugin.setup(ctx);
    await ctx.subs["session:start"]![0]!();
    const ids = ctx.emitted.filter((e) => e.event === "status:item-update").map((e) => e.payload.id);
    expect(ids).toContain("cwd");
    expect(ids).not.toContain("git.branch");
  });
});
```

- [ ] **Step 4: Run, watch fail**

```bash
cd plugins/claude-status-items && bun install && bun test
```

Expected: FAIL — `./index.ts` not found.

- [ ] **Step 5: Write `index.ts`**

```ts
import type { KaizenPlugin } from "kaizen/types";
import { basename } from "node:path";

const plugin: KaizenPlugin = {
  name: "claude-status-items",
  apiVersion: "3.0.0",
  permissions: { tier: "scoped", exec: { binaries: ["git"] } },
  services: { consumes: ["claude-events:vocabulary"] },

  async setup(ctx) {
    ctx.consumeService("claude-events:vocabulary");

    async function emitItems() {
      const cwd = process.cwd();
      await ctx.emit("status:item-update", {
        id: "cwd",
        content: basename(cwd) || cwd,
        priority: 80,
      });

      try {
        const r = await ctx.exec.run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeoutMs: 1000 });
        if (r.exitCode === 0) {
          const branch = r.stdout.trim();
          if (branch) {
            await ctx.emit("status:item-update", { id: "git.branch", content: branch, priority: 90 });
          }
        }
      } catch {
        // Not a repo, or git missing. Silent.
      }
    }

    ctx.on("session:start", emitItems);
    ctx.log("claude-status-items ready");
  },
};

export default plugin;
```

- [ ] **Step 6: Run, watch pass**

```bash
bun test
```

Expected: 3 passing.

- [ ] **Step 7: README + gitkeep + validate + commit**

```bash
# README mirrors prior plugins; describe cwd + git.branch items, scoped tier.
mkdir -p plugins/claude-status-items/.kaizen && touch plugins/claude-status-items/.kaizen/.gitkeep
cd plugins/claude-status-items && kaizen plugin validate .
cd /Users/chancock/git/kaizen-official-plugins
git add plugins/claude-status-items
git commit -m "feat(claude-status-items): cwd + git.branch items"
```

---

## Task 6 — `claude-driver`: pure parser

**Files:**
- Create: `plugins/claude-driver/{package.json,tsconfig.json,parser.ts,parser.test.ts,busy-messages.ts}`

The parser is a pure function: given a stream-json line, emit one of: `text-delta`, `model`, `result`, `retry`, `unknown`. Driver code calls it from a side-effecting loop.

- [ ] **Step 1: Write `package.json`** (`name: "claude-driver"`, description: `"Session driver: spawns claude CLI, streams output, emits status"`).

- [ ] **Step 2: Write `tsconfig.json`**.

- [ ] **Step 3: Write `plugins/claude-driver/parser.test.ts`**

```ts
import { describe, it, expect } from "bun:test";
import { parseStreamJsonLine } from "./parser.ts";

describe("parseStreamJsonLine", () => {
  it("returns null on empty/whitespace lines", () => {
    expect(parseStreamJsonLine("")).toBeNull();
    expect(parseStreamJsonLine("   ")).toBeNull();
  });

  it("returns 'malformed' on bad JSON", () => {
    const r = parseStreamJsonLine("{not json");
    expect(r?.kind).toBe("malformed");
  });

  it("extracts model from system/init", () => {
    const r = parseStreamJsonLine(JSON.stringify({
      type: "system", subtype: "init", model: "claude-opus-4-7", session_id: "abc",
    }));
    expect(r).toEqual({ kind: "init", model: "claude-opus-4-7", sessionId: "abc" });
  });

  it("extracts text deltas from stream_event", () => {
    const r = parseStreamJsonLine(JSON.stringify({
      type: "stream_event", event: { delta: { type: "text_delta", text: "Hi" } },
    }));
    expect(r).toEqual({ kind: "text-delta", text: "Hi" });
  });

  it("extracts tokens + session id from result", () => {
    const r = parseStreamJsonLine(JSON.stringify({
      type: "result", session_id: "abc", duration_ms: 1234,
      usage: {
        input_tokens: 100, output_tokens: 50,
        cache_read_input_tokens: 10, cache_creation_input_tokens: 5,
      },
    }));
    expect(r).toEqual({
      kind: "result",
      sessionId: "abc",
      durationMs: 1234,
      tokensIn: 100,
      tokensOut: 50,
      cacheReadTokens: 10,
      cacheCreationTokens: 5,
    });
  });

  it("returns 'retry' for system/api_retry", () => {
    const r = parseStreamJsonLine(JSON.stringify({
      type: "system", subtype: "api_retry",
      attempt: 2, max_retries: 5, retry_delay_ms: 1000, error: "rate_limit",
    }));
    expect(r?.kind).toBe("retry");
  });

  it("returns 'unknown' for events we don't care about", () => {
    expect(parseStreamJsonLine(JSON.stringify({ type: "assistant", message: {} }))?.kind).toBe("unknown");
  });
});
```

- [ ] **Step 4: Write `plugins/claude-driver/parser.ts`**

```ts
export type ParsedEvent =
  | { kind: "init"; model: string; sessionId: string }
  | { kind: "text-delta"; text: string }
  | { kind: "result"; sessionId: string; durationMs: number; tokensIn: number; tokensOut: number; cacheReadTokens?: number; cacheCreationTokens?: number }
  | { kind: "retry"; attempt: number; maxRetries: number; retryDelayMs: number; error: string }
  | { kind: "unknown" }
  | { kind: "malformed"; raw: string };

export function parseStreamJsonLine(line: string): ParsedEvent | null {
  if (!line.trim()) return null;
  let obj: any;
  try { obj = JSON.parse(line); } catch { return { kind: "malformed", raw: line }; }
  if (obj?.type === "system" && obj.subtype === "init") {
    return { kind: "init", model: String(obj.model ?? ""), sessionId: String(obj.session_id ?? "") };
  }
  if (obj?.type === "stream_event" && obj.event?.delta?.type === "text_delta") {
    return { kind: "text-delta", text: String(obj.event.delta.text ?? "") };
  }
  if (obj?.type === "result") {
    const u = obj.usage ?? {};
    return {
      kind: "result",
      sessionId: String(obj.session_id ?? ""),
      durationMs: Number(obj.duration_ms ?? 0),
      tokensIn: Number(u.input_tokens ?? 0),
      tokensOut: Number(u.output_tokens ?? 0),
      cacheReadTokens: u.cache_read_input_tokens != null ? Number(u.cache_read_input_tokens) : undefined,
      cacheCreationTokens: u.cache_creation_input_tokens != null ? Number(u.cache_creation_input_tokens) : undefined,
    };
  }
  if (obj?.type === "system" && obj.subtype === "api_retry") {
    return {
      kind: "retry",
      attempt: Number(obj.attempt ?? 0),
      maxRetries: Number(obj.max_retries ?? 0),
      retryDelayMs: Number(obj.retry_delay_ms ?? 0),
      error: String(obj.error ?? "unknown"),
    };
  }
  return { kind: "unknown" };
}
```

- [ ] **Step 5: Run, watch pass**

```bash
cd plugins/claude-driver && bun install && bun test
```

Expected: 7 passing.

- [ ] **Step 6: Write `plugins/claude-driver/busy-messages.ts`**

```ts
const MESSAGES = [
  "thinking…",
  "consulting the oracle…",
  "brewing tokens…",
  "kneading bytes…",
  "pondering the orb…",
  "shuffling electrons…",
];
export function pickBusyMessage(): string {
  return MESSAGES[Math.floor(Math.random() * MESSAGES.length)]!;
}
```

- [ ] **Step 7: Commit**

```bash
cd /Users/chancock/git/kaizen-official-plugins
git add plugins/claude-driver/{package.json,tsconfig.json,parser.ts,parser.test.ts,busy-messages.ts}
git commit -m "feat(claude-driver): pure stream-json parser"
```

---

## Task 7 — `claude-driver`: spawn helper + loop

**Files:**
- Create: `plugins/claude-driver/{spawn.ts,index.ts,index.test.ts,loop.test.ts,README.md,.kaizen/.gitkeep}`

The spawn helper is the side-effecting boundary. The loop function takes the spawn helper as a dependency, so tests inject a fake.

- [ ] **Step 1: Write `plugins/claude-driver/spawn.ts`**

```ts
import { spawn, type ChildProcess } from "node:child_process";

export interface ClaudeChild {
  stdout: AsyncIterable<string>;     // line-by-line
  stderr: () => string;              // accumulated stderr at any point
  kill(signal: NodeJS.Signals): void;
  wait(): Promise<number>;           // exit code
  isAlive(): boolean;
}

export type ClaudeSpawner = (args: string[]) => ClaudeChild;

export const realSpawner: ClaudeSpawner = (args) => {
  const child = spawn("claude", args, { stdio: ["ignore", "pipe", "pipe"] });
  let alive = true;
  let stderrBuf = "";
  child.stderr?.on("data", (d) => { stderrBuf += String(d); });
  child.on("exit", () => { alive = false; });

  async function* lines(): AsyncIterable<string> {
    let buf = "";
    for await (const chunk of child.stdout!) {
      buf += String(chunk);
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        yield line;
      }
    }
    if (buf) yield buf;
  }

  return {
    stdout: lines(),
    stderr: () => stderrBuf,
    kill: (sig) => { try { child.kill(sig); } catch {} },
    wait: () => new Promise<number>((resolve) => {
      if (!alive) return resolve(child.exitCode ?? 0);
      child.on("exit", (code) => resolve(code ?? 0));
    }),
    isAlive: () => alive,
  };
};
```

- [ ] **Step 2: Write the failing test `plugins/claude-driver/loop.test.ts`**

```ts
import { describe, it, expect, mock } from "bun:test";
import { runTurn, buildArgs } from "./loop.ts";
import type { ClaudeSpawner } from "./spawn.ts";

function fakeSpawner(lines: string[], opts?: { hangAfterResult?: boolean }): ClaudeSpawner {
  return () => {
    let alive = true;
    return {
      stdout: (async function* () { for (const l of lines) yield l; })(),
      stderr: () => "",
      kill: () => { alive = false; },
      wait: async () => 0,
      isAlive: () => alive,
    };
  };
}

describe("buildArgs", () => {
  it("omits --continue on first turn, includes it after", () => {
    expect(buildArgs("hi", false)).not.toContain("--continue");
    expect(buildArgs("hi", true)).toContain("--continue");
  });
  it("always includes stream-json flags", () => {
    const args = buildArgs("hi", false);
    expect(args).toEqual(expect.arrayContaining([
      "-p", "hi", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    ]));
  });
});

describe("runTurn", () => {
  const lines = [
    JSON.stringify({ type: "system", subtype: "init", model: "opus-4.7", session_id: "s1" }),
    JSON.stringify({ type: "stream_event", event: { delta: { type: "text_delta", text: "Hello" } } }),
    JSON.stringify({ type: "stream_event", event: { delta: { type: "text_delta", text: " world" } } }),
    JSON.stringify({
      type: "result", session_id: "s1", duration_ms: 100,
      usage: { input_tokens: 10, output_tokens: 5 },
    }),
  ];

  it("streams text deltas and emits init/result", async () => {
    const writes: string[] = [];
    const emitted: Array<{ ev: string; p: any }> = [];
    const result = await runTurn({
      prompt: "hi",
      hasSession: false,
      spawner: fakeSpawner(lines),
      writeOutput: (c) => writes.push(c),
      emit: async (ev, p) => { emitted.push({ ev, p }); },
      log: () => {},
    });
    expect(writes.join("")).toBe("Hello world");
    expect(emitted.find((e) => e.ev === "status:item-update" && e.p.id === "llm.model")?.p.content).toBe("opus-4.7");
    expect(emitted.find((e) => e.ev === "status:item-update" && e.p.id === "llm.context")?.p.content).toMatch(/10.*5/);
    expect(result.sessionId).toBe("s1");
  });

  it("drops malformed lines silently", async () => {
    const withGarbage = [...lines.slice(0, 2), "{not json", ...lines.slice(2)];
    const writes: string[] = [];
    await runTurn({
      prompt: "hi", hasSession: false, spawner: fakeSpawner(withGarbage),
      writeOutput: (c) => writes.push(c),
      emit: async () => {},
      log: () => {},
    });
    expect(writes.join("")).toBe("Hello world");
  });

  it("kills child if it stays alive after result (hang bug guard)", async () => {
    let killed: NodeJS.Signals | null = null;
    const spawner: ClaudeSpawner = () => ({
      stdout: (async function* () { for (const l of lines) yield l; })(),
      stderr: () => "",
      kill: (sig) => { killed = sig; },
      wait: async () => 0,
      isAlive: () => true,  // never dies
    });
    await runTurn({
      prompt: "hi", hasSession: false, spawner,
      writeOutput: () => {}, emit: async () => {}, log: () => {},
      graceMs: 10,
    });
    expect(killed).toBe("SIGTERM");
  });
});
```

- [ ] **Step 3: Run, watch fail**

```bash
cd plugins/claude-driver && bun test
```

Expected: FAIL — `./loop.ts` not found.

- [ ] **Step 4: Write `plugins/claude-driver/loop.ts`**

```ts
import { parseStreamJsonLine } from "./parser.ts";
import type { ClaudeSpawner } from "./spawn.ts";

export function buildArgs(prompt: string, hasSession: boolean): string[] {
  const args = [
    "-p", prompt,
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
  ];
  if (hasSession) args.push("--continue");
  return args;
}

export interface RunTurnOpts {
  prompt: string;
  hasSession: boolean;
  spawner: ClaudeSpawner;
  writeOutput: (chunk: string) => void;
  emit: (event: string, payload?: any) => Promise<void>;
  log: (msg: string) => void;
  graceMs?: number;            // grace before SIGTERM after result; default 2000
  cancelSignal?: AbortSignal;  // emits SIGINT to child if aborted
}

export interface TurnResult {
  sessionId: string | null;
  exitCode: number;
  cancelled: boolean;
}

export async function runTurn(opts: RunTurnOpts): Promise<TurnResult> {
  const { prompt, hasSession, spawner, writeOutput, emit, log } = opts;
  const grace = opts.graceMs ?? 2000;
  const child = spawner(buildArgs(prompt, hasSession));

  let sessionId: string | null = null;
  let cancelled = false;
  const onCancel = () => { cancelled = true; child.kill("SIGINT"); };
  opts.cancelSignal?.addEventListener("abort", onCancel);

  try {
    let sawResult = false;
    let resultSummary: string | null = null;

    for await (const line of child.stdout) {
      const ev = parseStreamJsonLine(line);
      if (!ev) continue;
      switch (ev.kind) {
        case "init":
          await emit("status:item-update", { id: "llm.model", content: ev.model, priority: 10 });
          if (ev.sessionId) sessionId = ev.sessionId;
          break;
        case "text-delta":
          writeOutput(ev.text);
          break;
        case "result": {
          sawResult = true;
          if (ev.sessionId) sessionId = ev.sessionId;
          const inK = formatTokens(ev.tokensIn);
          const outK = formatTokens(ev.tokensOut);
          await emit("status:item-update", {
            id: "llm.context",
            content: `${inK} in · ${outK} out`,
            priority: 20,
          });
          await emit("turn:after", {
            tokensIn: ev.tokensIn,
            tokensOut: ev.tokensOut,
            cacheReadTokens: ev.cacheReadTokens,
            cacheCreationTokens: ev.cacheCreationTokens,
            durationMs: ev.durationMs,
          });
          resultSummary = `tokens:${ev.tokensIn}/${ev.tokensOut}`;
          break;
        }
        case "retry":
          // Caller renders via writeNotice; we forward via log.
          log(`api retry attempt ${ev.attempt}/${ev.maxRetries} after ${ev.retryDelayMs}ms (${ev.error})`);
          break;
        case "malformed":
          log(`dropped malformed stream-json line: ${ev.raw.slice(0, 80)}`);
          break;
        case "unknown":
          break;
      }
    }

    if (sawResult && child.isAlive()) {
      await sleep(grace);
      if (child.isAlive()) {
        child.kill("SIGTERM");
        await sleep(grace);
        if (child.isAlive()) child.kill("SIGKILL");
      }
    }

    const exitCode = await child.wait();
    if (resultSummary) log(resultSummary);
    return { sessionId, exitCode, cancelled };
  } finally {
    opts.cancelSignal?.removeEventListener("abort", onCancel);
  }
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
```

- [ ] **Step 5: Run, watch pass**

```bash
bun test
```

Expected: 7 parser + 5 loop = 12 passing.

- [ ] **Step 6: Write the plugin manifest test `plugins/claude-driver/index.test.ts`**

```ts
import { describe, it, expect, mock } from "bun:test";
import plugin from "./index.ts";

function makeCtx() {
  return {
    log: mock(() => {}),
    config: {},
    defineEvent: mock(() => {}),
    on: mock(() => {}),
    emit: mock(async () => []),
    defineService: mock(() => {}),
    provideService: mock(() => {}),
    consumeService: mock(() => {}),
    useService: mock(() => undefined),
    secrets: { get: mock(async () => undefined), refresh: mock(async () => undefined) },
  } as any;
}

describe("claude-driver", () => {
  it("has correct metadata", () => {
    expect(plugin.name).toBe("claude-driver");
    expect(plugin.apiVersion).toBe("3.0.0");
    expect(plugin.driver).toBe(true);
    expect(plugin.permissions?.tier).toBe("unscoped");
  });

  it("setup declares consumes for events vocab and ui:channel", async () => {
    const ctx = makeCtx();
    await plugin.setup(ctx);
    expect(ctx.consumeService).toHaveBeenCalledWith("claude-events:vocabulary");
    expect(ctx.consumeService).toHaveBeenCalledWith("ui:channel");
  });
});
```

- [ ] **Step 7: Write `plugins/claude-driver/index.ts`**

```ts
import type { KaizenPlugin } from "kaizen/types";
import type { UiChannel } from "../claude-tui/public";
import { runTurn } from "./loop.ts";
import { realSpawner } from "./spawn.ts";
import { pickBusyMessage } from "./busy-messages.ts";

const plugin: KaizenPlugin = {
  name: "claude-driver",
  apiVersion: "3.0.0",
  driver: true,
  permissions: { tier: "unscoped" },
  services: { consumes: ["claude-events:vocabulary", "ui:channel"] },

  async setup(ctx) {
    ctx.consumeService("claude-events:vocabulary");
    ctx.consumeService("ui:channel");
    ctx.log("claude-driver setup complete");
  },

  async start(ctx) {
    const ui = ctx.useService<UiChannel>("ui:channel");
    let sessionId: string | null = null;
    const cancelController = { current: null as AbortController | null };

    ctx.on("turn:cancel", async () => {
      cancelController.current?.abort();
    });

    await ctx.emit("session:start");
    try {
      while (true) {
        const line = await ui.readInput();
        if (line === "") break;

        await ctx.emit("turn:before", { prompt: line });
        ui.setBusy(true, pickBusyMessage());
        const ac = new AbortController();
        cancelController.current = ac;
        try {
          const r = await runTurn({
            prompt: line,
            hasSession: sessionId !== null,
            spawner: realSpawner,
            writeOutput: (chunk) => ui.writeOutput(chunk),
            emit: ctx.emit.bind(ctx),
            log: ctx.log.bind(ctx),
            cancelSignal: ac.signal,
          });
          if (r.cancelled) {
            ui.writeNotice("↯ cancelled");
            sessionId = null; // start fresh next turn
          } else if (r.exitCode !== 0) {
            await ctx.emit("session:error", { message: `claude exited ${r.exitCode}` });
            sessionId = null;
          } else if (r.sessionId) {
            sessionId = r.sessionId;
          }
        } catch (err) {
          await ctx.emit("session:error", { message: (err as Error).message });
          sessionId = null;
        } finally {
          cancelController.current = null;
          ui.setBusy(false);
        }
      }
    } finally {
      await ctx.emit("session:end");
    }
  },
};

export default plugin;
```

- [ ] **Step 8: Run all tests**

```bash
bun test
```

Expected: 14 passing (7 parser + 5 loop + 2 plugin).

- [ ] **Step 9: README + gitkeep + validate + commit**

```bash
mkdir -p plugins/claude-driver/.kaizen && touch plugins/claude-driver/.kaizen/.gitkeep
# README documents: claude binary requirement, --continue behavior, 4 events emitted, status items emitted, error modes.
cd plugins/claude-driver && kaizen plugin validate .
cd /Users/chancock/git/kaizen-official-plugins
git add plugins/claude-driver
git commit -m "feat(claude-driver): session loop with claude CLI"
```

---

## Task 8 — Marketplace catalog + harness

**Files:**
- Create: `harnesses/claude-wrapper.json`
- Modify: `.kaizen/marketplace.json`

- [ ] **Step 1: Write `harnesses/claude-wrapper.json`**

```json
{
  "plugins": [
    "official/claude-events@0.1.0",
    "official/claude-tui@0.1.0",
    "official/claude-status-items@0.1.0",
    "official/claude-driver@0.1.0"
  ]
}
```

- [ ] **Step 2: Rewrite `.kaizen/marketplace.json`**

```json
{
  "version": "1.0.0",
  "name": "kaizen-official",
  "description": "Official kaizen plugins and harnesses.",
  "url": "https://github.com/CraightonH/kaizen-official-plugins.git",
  "entries": [
    {
      "kind": "plugin",
      "name": "claude-events",
      "description": "Event vocabulary for the claude-wrapper harness.",
      "categories": ["events"],
      "versions": [{ "version": "0.1.0", "source": { "type": "file", "path": "plugins/claude-events" } }]
    },
    {
      "kind": "plugin",
      "name": "claude-tui",
      "description": "Terminal UI: rounded prompt box + status bar. Provides ui:channel.",
      "categories": ["ui", "terminal"],
      "versions": [{ "version": "0.1.0", "source": { "type": "file", "path": "plugins/claude-tui" } }]
    },
    {
      "kind": "plugin",
      "name": "claude-status-items",
      "description": "Default cwd + git.branch status items.",
      "categories": ["status"],
      "versions": [{ "version": "0.1.0", "source": { "type": "file", "path": "plugins/claude-status-items" } }]
    },
    {
      "kind": "plugin",
      "name": "claude-driver",
      "description": "Session driver: spawns claude CLI, streams output, emits llm.* status items.",
      "categories": ["driver", "claude"],
      "versions": [{ "version": "0.1.0", "source": { "type": "file", "path": "plugins/claude-driver" } }]
    },
    {
      "kind": "harness",
      "name": "claude-wrapper",
      "description": "Claude Code wrapper: distinctive prompt + extensible status bar over `claude -p`.",
      "categories": ["harness", "claude"],
      "versions": [{ "version": "0.1.0", "path": "harnesses/claude-wrapper.json" }]
    }
  ]
}
```

- [ ] **Step 3: Commit**

```bash
git add .kaizen/marketplace.json harnesses/claude-wrapper.json
git commit -m "feat: register claude-wrapper plugins + harness"
```

---

## Task 9 — Top-level repo housekeeping

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Replace `README.md`** with a short description naming the four plugins and the harness, removing minimum-shell references. Confirm `bun install` and `bun test` at the workspace root run all plugin tests.

```md
# kaizen-official-plugins

Official kaizen plugin marketplace. Hosts plugins and harnesses for kaizen 0.3+.

## Plugins

- **claude-events** — event vocabulary for the claude-wrapper harness.
- **claude-tui** — terminal UI: rounded "kaizen" prompt box + status bar.
- **claude-status-items** — emits `cwd` and `git.branch` status items.
- **claude-driver** — session driver; wraps the local `claude` CLI in headless stream-json mode.

## Harnesses

- **claude-wrapper** — Claude Code wrapper UI over `claude -p`. Requires the `claude` binary on `$PATH`.

## Usage

```sh
kaizen --harness official/claude-wrapper@0.1.0
```

## Development

```sh
bun install
bun test
```
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: describe claude-wrapper ecosystem in root README"
```

---

## Task 10 — End-to-end validation

- [ ] **Step 1: Run all plugin validators**

```bash
cd /Users/chancock/git/kaizen-official-plugins
for p in plugins/*/; do
  echo "=== $p ==="
  (cd "$p" && kaizen plugin validate .) || exit 1
done
```

Expected: all four exit 0.

- [ ] **Step 2: Run all tests from the workspace root**

```bash
bun test
```

Expected: 14 (driver) + 4 (tui plugin) + 4 (tui render) + 3 (status-items) + 3 (events) = 28 passing.

- [ ] **Step 3: Smoke test the harness manually** (only if `claude` is installed and the user is logged in)

```bash
kaizen --harness ./harnesses/claude-wrapper.json
```

Expected: rounded box appears, typing a prompt streams claude's response above the box, `Ctrl-D` exits cleanly.

- [ ] **Step 4: If any validation fails, revert to a clean state and re-run the failing task.** Otherwise commit any housekeeping fixes.

---

## Task 11 — File doc-gap issues against kaizen

**Files:**
- None in this repo.

- [ ] **Step 1: Confirm GitHub remote for kaizen and use `gh` to file issues**

```bash
gh issue list --repo CraightonH/kaizen --limit 5 || gh issue list --repo anthropics/kaizen --limit 5
```

(Use whichever `kaizen` repo the user owns. The local checkout is at `~/git/kaizen` — `git -C ~/git/kaizen remote -v` to confirm.)

- [ ] **Step 2: File three issues, each titled and bodied as below**

**Issue A — `docs: how to read stdin in apiVersion 3 drivers`**

> The 0.2.0 sample driver imports `readStdinLine` from `kaizen/types`, but `docs/reference/host-api.md` says the only runtime export of `kaizen/types` is `PLUGIN_API_VERSION`. Either the helper still exists and is undocumented, or it was removed and the example is broken. Plugin authors writing input-reading drivers (e.g. terminal UIs) have no documented path forward. Suggest adding a "Reading user input" subsection to `host-api.md` showing the canonical pattern for apiVersion 3.

**Issue B — `docs: which Node globals are available on scoped tier?`**

> `plugin-authoring.md` enumerates banned imports (`node:fs`, `node:child_process`, etc.) but doesn't document which Node globals (`process.cwd`, `process.env`, `process.kill`, etc.) are filtered for non-`unscoped` plugins. Adding a "What's available without grants" table to `plugin-authoring.md` (or `plugin-standards.md`) would close the gap. Specific case that surfaced this: `process.cwd()` from a `tier: "scoped"` plugin.

**Issue C — `docs: clarify apiVersion format vs PLUGIN_API_VERSION`**

> `plugin-authoring.md` example shows `apiVersion: "3.0.0"`, the existing official plugins ship `"2.0.0"`, and `PLUGIN_API_VERSION` is `"3"` (a single major number, not semver). The validator description says the field must be "semver", but the constant doesn't satisfy semver. Recommend documenting the relationship: is `"3"`, `"3.0.0"`, `"3.0"` all OK? Which one is canonical?

- [ ] **Step 3: Once filed, link the issue numbers in `docs/superpowers/specs/2026-04-27-claude-wrapper-design.md` under the "Documentation gaps to file against kaizen" section, and commit.**

```bash
git add docs/superpowers/specs/2026-04-27-claude-wrapper-design.md
git commit -m "docs: link kaizen doc-gap issues from spec"
```

---

## Self-review

**Spec coverage:**

| Spec section | Covered by |
|---|---|
| Plugin lineup (4) | Tasks 2, 3, 4, 5, 6, 7 |
| `ui:channel` shape | Task 3 (public.d.ts) + Task 4 (impl) |
| Events (8) | Task 2 |
| Status item conventions | Task 5 (cwd/git) + Task 7 (llm.*) |
| Visual design (option B) | Task 3 (renderer) |
| Per-turn data flow | Task 7 (loop.ts + runTurn tests) |
| First turn vs subsequent | Task 7 (`buildArgs`) |
| Error handling table | Task 7 (claude exit non-zero, stuck process, cancel, EOF, malformed JSON) |
| Permissions | Each plugin manifest |
| Testing | Each plugin's test files |
| Marketplace + harness changes (delete + add) | Tasks 1, 8 |
| Doc-gap issues | Task 11 |

**Placeholder scan:** No "TBD"/"TODO" left. README templates show actual content. The `claude-driver/README.md` is described in prose in Task 7 step 9 — fine, it's a one-paragraph doc following the same template as the other READMEs.

**Type consistency:** `UiChannel.setBusy(busy, message?)` matches across spec, public.d.ts, and renderer's `PromptState`. Status item ID strings (`llm.model`, `llm.context`, `cwd`, `git.branch`) match across spec, parser tests, loop, and status-items plugin. Event names (`turn:cancel`, `turn:before`, `turn:after`, `status:item-update`, `status:item-clear`, `session:*`) match across `claude-events/public.d.ts`, every emitter, and every subscriber.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-27-claude-wrapper.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
