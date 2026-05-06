# `llm-session-manager` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move conversation persistence out of `llm-driver` into a new `llm-session-manager` plugin. Persist sessions to disk namespaced by harness, support sub-agent sessions with caller-supplied ids, and capture a meta-harness-grade execution trace.

**Architecture:** New plugin owns canonical `ChatMessage[]` + append-only `events.jsonl` per session. Driver becomes stateless re: messages and holds only `activeSessionId`. `runConversation` gains discriminated-union input (existing-turn for driver path, owned-turn for agent path). Tool dispatch strategies thread `turnId`/`sessionId` through every `registry.invoke()` and emitted event payload. Vocab change: REPL events `session:*` rename to `harness:*`; new `session:*` events scope to record lifecycle.

**Tech Stack:** Bun, TypeScript, kaizen plugin runtime, JSONL on disk, atomic-rename for snapshots.

**Spec:** `docs/superpowers/specs/2026-05-06-llm-session-manager-design.md` is authoritative. When this plan and the spec diverge, the spec wins — fix the plan.

---

## Conventions used in this plan

- **TDD strict:** every behavior task is "write failing test" → "run, see fail" → "implement minimal" → "run, see pass" → "commit." Some pure-data refactors collapse the cycle into one test+impl step where the test alone is meaningless without the impl.
- **Bun-test only.** No external mocking framework. Hand-roll fakes per the existing `test/` patterns in each plugin.
- **Local deploy after each plugin's tasks are done.** Per each plugin's CLAUDE.md, copy source to install dir + `bun build` dist/index.js. Add a final task per plugin doing this.
- **Commit per task.** Frequent commits, scoped to the task. Commit messages match the existing repo style (lowercase prefix `feat(plugin-name):`, `refactor(plugin-name):`, `test(plugin-name):`, `docs(plugin-name):`).
- **No `Co-Authored-By` lines** (per user preference).
- **Every code block is the actual code** — no placeholders, no "similar to above," no "TBD."
- **Test counts:** I do not pin "expect N tests pass" because new tests are added throughout. Each task asserts a specific test name passes; the executor verifies that.

---

## File structure / decomposition map

### Plugins modified

| Plugin | Responsibility |
|---|---|
| `llm-events` | Vocab additions: `harness:*` (rename), `session:created`, `session:resumed`, `session:deleted`, `session:active-changed`. Removals: `session:start/end/error/exit-requested`. |
| `llm-tools-registry` | `ToolExecutionContext.sessionId?: string` field added; registry propagates `turnId`/`sessionId` into emitted `tool:*` events when present. |
| `llm-native-dispatch` | `handleResponse()` accepts `turnId`/`sessionId` in input; threads both into `registry.invoke()` ctx. |
| `llm-codemode-dispatch` | Same as native: `handleResponse()` accepts and threads `turnId`/`sessionId`; codemode events get those fields. |
| `llm-driver` | Drops `state.messages`, gains `activeSessionId`. Consumes `sessions:store`. New `runConversation` discriminated-union input. Emits `harness:*` and `session:active-changed`. |
| `llm-agents` | Consumes `sessions:store`. `dispatch_agent` schema gains `session_id`. Handler reads `ctx.sessionId`/`turnId`, creates/loads sub-session, calls `runConversation` in owned-turn mode. |
| `llm-slash-commands` | Adds `/session:new`, `/session:list`, `/session:resume`, `/session:delete`. `/clear` archives by creating new top-level session. |
| `llm-status-items` | Renames listeners on `session:start/end/error/exit-requested` to `harness:*`. |

### New plugin: `llm-session-manager`

```
plugins/llm-session-manager/
├── CLAUDE.md                Working notes for future agents.
├── README.md                User-facing contract.
├── package.json
├── tsconfig.json
├── public.d.ts              Re-exports SessionsStoreService, SessionRecord, TurnHandle, EventLogEntry, HarnessIdentity-aware harnessKey.
├── index.ts                 Plugin lifecycle (only file that touches ctx). Wires harness key, paths, store, event subscriber.
├── harness-key.ts           Pure: harnessKey(HarnessIdentity) → string. Validates and rejects local* refs.
├── paths.ts                 Pure: session paths from harness key + session id. Path traversal guards.
├── validation.ts            Pure: id validation regexes, parse "<parent>/<child>", reject ".." / empty / separator-in-child.
├── snapshot.ts              I/O via injected deps: read snapshot, atomic write (tmp + rename), schema v1.
├── events-log.ts            I/O via injected deps: append a line, recover partial trailing line on open, fsync, monotonic offsets.
├── index-jsonl.ts           I/O via injected deps: append index ops, read index for in-memory map, rebuild from disk walk.
├── store.ts                 Pure orchestration: makeStore({ deps, harnessKey, log, emit }) → SessionsStoreService. In-memory cache, single-writer per session, TurnHandle factory, validation chokepoint.
├── trace-subscriber.ts      Pure factory: subscribes to turn:*/llm:*/tool:*/codemode:* and writes to the owning session's events.jsonl. Routes by turnId via an in-memory map populated on turn:start, cleared on turn:end.
└── test/
    ├── harness-key.test.ts
    ├── paths.test.ts
    ├── validation.test.ts
    ├── snapshot.test.ts
    ├── events-log.test.ts
    ├── index-jsonl.test.ts
    ├── store.test.ts
    ├── trace-subscriber.test.ts
    ├── integration.test.ts
    └── crash-safety.test.ts
```

Boundaries — only `index.ts` imports `kaizen/types` or sees `ctx`. Everything else takes deps via factory args.

### Harness manifest

`harnesses/openai-compatible.json` adds `llm-session-manager` to the plugin list.

---

## Phase ordering and atomicity

Phases 1 and 2 can ship and test independently. Phases 3–6 are an **atomic group** — they share the new `runConversation` shape and `ToolExecutionContext.sessionId`. Don't ship one without the others. Phase 7 piggy-backs on the atomic group. Phase 8 is patch-level cleanup. Phase 9 wires it all into the harness for end-to-end smoke testing.

| Phase | Plugin(s) | Independently shippable? |
|---|---|---|
| 1 | `llm-events` | yes (additive + rename only) |
| 2 | `llm-session-manager` | yes (new plugin, no consumers yet) |
| 3 | `llm-tools-registry` | only with phase 4 |
| 4 | `llm-native-dispatch`, `llm-codemode-dispatch` | only with 3, 5 |
| 5 | `llm-driver` | only with 3, 4, 6 |
| 6 | `llm-agents` | only with 3, 4, 5 |
| 7 | `llm-slash-commands` | only with 5 |
| 8 | `llm-status-items` (and any other `session:*` listener) | yes after phase 1 |
| 9 | harness manifest + end-to-end smoke | last |

---

# Phase 1: `llm-events` vocab change

Goal: rename REPL `session:*` events to `harness:*`; add new `session:*` record events. No payload type changes (the spec adds `turnId`/`sessionId` to existing trace events at the *consumer* contract layer; `llm-events` just owns the name strings).

### Task 1.1: Update `VOCAB` literal

**Files:**
- Modify: `plugins/llm-events/index.ts` (the `VOCAB` declaration)

- [ ] **Step 1: Update the failing test first**

Modify the assertions in `plugins/llm-events/index.test.ts` for the existing "VOCAB contains every Spec 0 event name" check. Remove `session:start`, `session:end`, `session:error`, `session:exit-requested` from the expected set. Add `harness:start`, `harness:end`, `harness:error`, `harness:exit-requested`, `session:created`, `session:resumed`, `session:deleted`, `session:active-changed`.

Concrete edit (locate the `expected` Set in `index.test.ts`):

```ts
// remove these from the set:
"session:start",
"session:end",
"session:error",
"session:exit-requested",

// add these:
"harness:start",
"harness:end",
"harness:error",
"harness:exit-requested",
"session:created",
"session:resumed",
"session:deleted",
"session:active-changed",
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd plugins/llm-events && bun test
```

Expected: FAIL on the VOCAB-set assertion.

- [ ] **Step 3: Update `VOCAB` in `index.ts`**

Open `plugins/llm-events/index.ts`. Replace the four `SESSION_*` keys with `HARNESS_*` and add four new `SESSION_*` keys for the record lifecycle:

```ts
export const VOCAB = Object.freeze({
  // (was) SESSION_START / END / ERROR / EXIT_REQUESTED — renamed:
  HARNESS_START: "harness:start",
  HARNESS_END: "harness:end",
  HARNESS_ERROR: "harness:error",
  HARNESS_EXIT_REQUESTED: "harness:exit-requested",
  // new — session-record lifecycle:
  SESSION_CREATED: "session:created",
  SESSION_RESUMED: "session:resumed",
  SESSION_DELETED: "session:deleted",
  SESSION_ACTIVE_CHANGED: "session:active-changed",
  // (rest unchanged)
  INPUT_SUBMIT: "input:submit",
  INPUT_HANDLED: "input:handled",
  CONVERSATION_USER_MESSAGE: "conversation:user-message",
  CONVERSATION_ASSISTANT_MESSAGE: "conversation:assistant-message",
  CONVERSATION_SYSTEM_MESSAGE: "conversation:system-message",
  CONVERSATION_CLEARED: "conversation:cleared",
  TURN_START: "turn:start",
  TURN_END: "turn:end",
  TURN_CANCEL: "turn:cancel",
  TURN_ERROR: "turn:error",
  LLM_BEFORE_CALL: "llm:before-call",
  LLM_REQUEST: "llm:request",
  LLM_TOKEN: "llm:token",
  LLM_REASONING: "llm:reasoning",
  LLM_TOOL_CALL: "llm:tool-call",
  LLM_DONE: "llm:done",
  LLM_ERROR: "llm:error",
  TOOL_BEFORE_EXECUTE: "tool:before-execute",
  TOOL_EXECUTE: "tool:execute",
  TOOL_RESULT: "tool:result",
  TOOL_ERROR: "tool:error",
  CODEMODE_CODE_EMITTED: "codemode:code-emitted",
  CODEMODE_BEFORE_EXECUTE: "codemode:before-execute",
  CODEMODE_RESULT: "codemode:result",
  CODEMODE_ERROR: "codemode:error",
  SKILL_LOADED: "skill:loaded",
  SKILL_AVAILABLE_CHANGED: "skill:available-changed",
  STATUS_ITEM_UPDATE: "status:item-update",
  STATUS_ITEM_CLEAR: "status:item-clear",
  PROMPT_REBUILT: "prompt:rebuilt",
  PROMPT_RELOAD: "prompt:reload",
  TOOLS_REGISTERED: "tools:registered",
  TOOLS_UNREGISTERED: "tools:unregistered",
  MCP_REGISTRATION_CONFLICT: "mcp:registration-conflict",
}) as const;
```

- [ ] **Step 4: Update `Vocab` interface in `public.d.ts`**

Replace the four `SESSION_*` lines and add the new `HARNESS_*`/`SESSION_*` lines. The interface keys must match `VOCAB`'s keys exactly:

```ts
export interface Vocab {
  readonly HARNESS_START: "harness:start";
  readonly HARNESS_END: "harness:end";
  readonly HARNESS_ERROR: "harness:error";
  readonly HARNESS_EXIT_REQUESTED: "harness:exit-requested";
  readonly SESSION_CREATED: "session:created";
  readonly SESSION_RESUMED: "session:resumed";
  readonly SESSION_DELETED: "session:deleted";
  readonly SESSION_ACTIVE_CHANGED: "session:active-changed";
  // …rest unchanged
  readonly INPUT_SUBMIT: "input:submit";
  // …
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd plugins/llm-events && bun test
```

Expected: PASS. If a structural-probe test fails because something else references `SESSION_*`, fix that test alongside.

- [ ] **Step 6: Commit**

```bash
git add plugins/llm-events/
git commit -m "feat(llm-events): rename session:* REPL events to harness:*; add session record-lifecycle events"
```

### Task 1.2: Bump `llm-events` package version

**Files:**
- Modify: `plugins/llm-events/package.json`

- [ ] **Step 1: Bump version**

This is a public-surface (vocab) change — major bump per the harness's pre-1.0 minor-as-major convention.

Read `plugins/llm-events/package.json`, increment the minor (e.g. `0.2.0` → `0.3.0`). Pre-1.0 bumps the minor for breaking changes per the existing harness convention.

- [ ] **Step 2: Commit**

```bash
git add plugins/llm-events/package.json
git commit -m "chore(llm-events): bump version for harness:*/session:* vocab change"
```

### Task 1.3: Local deploy `llm-events`

- [ ] **Step 1: Run the deploy script per CLAUDE.md**

Read the new version from the just-bumped `package.json` (call it `<NEW_VERSION>`).

```bash
mkdir -p ~/.kaizen/marketplaces/official/plugins/llm-events@<NEW_VERSION>
cp -R plugins/llm-events/. ~/.kaizen/marketplaces/official/plugins/llm-events@<NEW_VERSION>/
(cd ~/.kaizen/marketplaces/official/plugins/llm-events@<NEW_VERSION> \
  && bun build --target=bun --outfile=dist/index.js index.ts)
```

Verify `dist/index.js` exists and `package.json` reports the new version.

(No commit — local deploy artifacts live outside the repo.)

---

# Phase 2: `llm-session-manager` (new plugin)

Goal: build the new plugin with all pure modules under TDD, then wire the lifecycle. No consumer wiring yet — that comes in phases 3–6.

### Task 2.1: Scaffold the new plugin

**Files:**
- Create: `plugins/llm-session-manager/package.json`
- Create: `plugins/llm-session-manager/tsconfig.json`
- Create: `plugins/llm-session-manager/public.d.ts` (placeholder)
- Create: `plugins/llm-session-manager/index.ts` (placeholder)
- Create: `plugins/llm-session-manager/test/.gitkeep` (or first test file)

- [ ] **Step 1: Create `package.json`**

Match the shape used by `llm-driver/package.json`. Read that file as the template, then create:

```json
{
  "name": "llm-session-manager",
  "version": "0.1.0",
  "module": "index.ts",
  "main": "index.ts",
  "types": "public.d.ts",
  "type": "module",
  "scripts": {
    "test": "bun test"
  },
  "dependencies": {
    "llm-events": "workspace:*"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "kaizen": "workspace:*",
    "typescript": "latest"
  }
}
```

If `llm-driver/package.json` has different conventions (peer deps, exports field), align — read it first and mirror.

- [ ] **Step 2: Create `tsconfig.json`**

Mirror `plugins/llm-driver/tsconfig.json` — the harness uses one consistent shape across plugins. Read the driver's tsconfig and copy.

- [ ] **Step 3: Stub `index.ts` and `public.d.ts`**

`plugins/llm-session-manager/index.ts`:

```ts
import type { KaizenPlugin } from "kaizen/types";

const plugin: KaizenPlugin = {
  name: "llm-session-manager",
  apiVersion: "3.0.0",
  permissions: { tier: "scoped", fs: { read: ["~/.kaizen/sessions/**"], write: ["~/.kaizen/sessions/**"] } },
  services: {
    consumes: ["llm-events:vocabulary"],
    provides: ["sessions:store"],
  },
  async setup(_ctx) {
    throw new Error("not implemented");
  },
};

export default plugin;
```

`plugins/llm-session-manager/public.d.ts`:

```ts
// Filled in by Task 2.10 once all internal types are pinned.
export {};
```

- [ ] **Step 4: Verify the workspace picks up the new plugin**

```bash
cd /Users/chancock/git/kaizen-official-plugins && bun install
```

Expected: no errors. The new package appears under `node_modules/`.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-session-manager/
git commit -m "feat(llm-session-manager): scaffold new plugin"
```

### Task 2.2: `harness-key.ts` — TDD

**Files:**
- Create: `plugins/llm-session-manager/harness-key.ts`
- Create: `plugins/llm-session-manager/test/harness-key.test.ts`

- [ ] **Step 1: Write the failing test**

`plugins/llm-session-manager/test/harness-key.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { harnessKey } from "../harness-key";

describe("harnessKey", () => {
  test("ref with version: strips trailing @version", () => {
    expect(harnessKey({ ref: "official/openai-compatible@0.1.0" })).toBe("official_openai-compatible");
  });

  test("ref without version: passes through sanitized", () => {
    expect(harnessKey({ ref: "official/openai-compatible" })).toBe("official_openai-compatible");
  });

  test("ref with scoped npm-style id: only strips trailing version segment", () => {
    expect(harnessKey({ ref: "@scope/name@1.2.3" })).toBe("_scope_name");
  });

  test("file path single-file json: derives local_<name>", () => {
    expect(harnessKey({ jsonPath: "/repo/harnesses/openai-compatible.json" })).toBe("local_openai-compatible");
  });

  test("file path directory-style kaizen.json: derives local_<dirname>", () => {
    expect(harnessKey({ jsonPath: "/repo/.kaizen/harnesses/openai-compatible/kaizen.json" })).toBe("local_openai-compatible");
  });

  test("missing both: returns 'default'", () => {
    expect(harnessKey({})).toBe("default");
  });

  test("rejects ref derived to 'local'", () => {
    expect(() => harnessKey({ ref: "local" })).toThrow(/reserved/i);
    expect(() => harnessKey({ ref: "local@1.0.0" })).toThrow(/reserved/i);
  });

  test("rejects ref derived to 'local_*'", () => {
    expect(() => harnessKey({ ref: "local/foo" })).toThrow(/reserved/i);
    expect(() => harnessKey({ ref: "local_foo/bar" })).toThrow(/reserved/i);
    expect(() => harnessKey({ ref: "local-foo" })).not.toThrow();
  });

  test("ref takes precedence over jsonPath", () => {
    expect(
      harnessKey({ ref: "official/foo", jsonPath: "/etc/junk/whatever.json" }),
    ).toBe("official_foo");
  });
});
```

- [ ] **Step 2: Run, see fail**

```bash
cd plugins/llm-session-manager && bun test test/harness-key.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`plugins/llm-session-manager/harness-key.ts`:

```ts
import { basename, dirname } from "node:path";
import type { HarnessIdentity } from "kaizen/types";

export function harnessKey(h: HarnessIdentity): string {
  const sanitize = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, "_");

  if (h.ref) {
    const withoutVersion = h.ref.replace(/@[^/@]+$/, "");
    const derived = sanitize(withoutVersion.replace(/\//g, "_"));
    if (derived === "local" || derived.startsWith("local_")) {
      throw new Error(
        `Harness ref '${h.ref}' derives to a session key starting with 'local' / 'local_', ` +
          `which is reserved for path-derived session keys. Rename the harness source.`,
      );
    }
    return derived;
  }

  if (h.jsonPath) {
    const base = basename(h.jsonPath);
    const name = base === "kaizen.json"
      ? basename(dirname(h.jsonPath))
      : base.replace(/\.json$/, "");
    return `local_${sanitize(name)}`;
  }

  return "default";
}
```

- [ ] **Step 4: Run, see pass**

```bash
cd plugins/llm-session-manager && bun test test/harness-key.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-session-manager/harness-key.ts plugins/llm-session-manager/test/harness-key.test.ts
git commit -m "feat(llm-session-manager): harnessKey derivation with local-namespace reservation"
```

### Task 2.3: `validation.ts` — TDD

**Files:**
- Create: `plugins/llm-session-manager/validation.ts`
- Create: `plugins/llm-session-manager/test/validation.test.ts`

- [ ] **Step 1: Write the failing test**

`plugins/llm-session-manager/test/validation.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { isValidChildId, parseSessionId, validateFullSessionId } from "../validation";

describe("isValidChildId", () => {
  test("accepts alnum/underscore/dot/dash", () => {
    expect(isValidChildId("oneshot-abc123")).toBe(true);
    expect(isValidChildId("a.b_c-d")).toBe(true);
  });
  test("rejects empty, slash, ..", () => {
    expect(isValidChildId("")).toBe(false);
    expect(isValidChildId("a/b")).toBe(false);
    expect(isValidChildId("..")).toBe(false);
    expect(isValidChildId("a..b")).toBe(true); // dots OK inside
    expect(isValidChildId(" leading-space")).toBe(false);
  });
});

describe("parseSessionId", () => {
  test("top-level UUID-shape: returns { topLevelId, childPath: [] }", () => {
    expect(parseSessionId("7f3e1234-89ab-cdef-0123-456789abcdef")).toEqual({
      topLevelId: "7f3e1234-89ab-cdef-0123-456789abcdef",
      childPath: [],
    });
  });
  test("parent/child: returns { topLevelId, childPath: [child] }", () => {
    const parsed = parseSessionId("7f3e1234-89ab-cdef-0123-456789abcdef/reviewer-fileA");
    expect(parsed.topLevelId).toBe("7f3e1234-89ab-cdef-0123-456789abcdef");
    expect(parsed.childPath).toEqual(["reviewer-fileA"]);
  });
  test("nested grandchild", () => {
    const parsed = parseSessionId("7f3e1234-89ab-cdef-0123-456789abcdef/orchestrator/worker-1");
    expect(parsed.childPath).toEqual(["orchestrator", "worker-1"]);
  });
});

describe("validateFullSessionId", () => {
  test("valid top-level passes", () => {
    expect(() =>
      validateFullSessionId("7f3e1234-89ab-cdef-0123-456789abcdef"),
    ).not.toThrow();
  });
  test("valid parent/child passes", () => {
    expect(() =>
      validateFullSessionId("7f3e1234-89ab-cdef-0123-456789abcdef/reviewer-fileA"),
    ).not.toThrow();
  });
  test("rejects empty segment", () => {
    expect(() => validateFullSessionId("uuid//child")).toThrow(/empty/i);
    expect(() => validateFullSessionId("uuid/")).toThrow(/empty/i);
  });
  test("rejects '..' anywhere", () => {
    expect(() => validateFullSessionId("uuid/../escape")).toThrow();
    expect(() => validateFullSessionId("..")).toThrow();
  });
  test("rejects path separators inside child segment", () => {
    expect(() => validateFullSessionId("uuid/foo\\bar")).toThrow();
  });
  test("rejects malformed UUID-shape top-level", () => {
    expect(() => validateFullSessionId("not-a-uuid")).toThrow(/top-level/i);
    expect(() => validateFullSessionId("not-a-uuid/child")).toThrow(/top-level/i);
  });
});
```

- [ ] **Step 2: Run, see fail**

```bash
cd plugins/llm-session-manager && bun test test/validation.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement**

`plugins/llm-session-manager/validation.ts`:

```ts
const CHILD_RE = /^[A-Za-z0-9_.-]+$/;
// Standard UUID v4-shape (lower hex, with dashes). Manager only mints this shape; rejecting
// other top-level forms is a defense-in-depth check at the public API boundary.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isValidChildId(s: string): boolean {
  return CHILD_RE.test(s);
}

export interface ParsedSessionId {
  topLevelId: string;
  childPath: string[];
}

export function parseSessionId(id: string): ParsedSessionId {
  const parts = id.split("/");
  return { topLevelId: parts[0]!, childPath: parts.slice(1) };
}

export function validateFullSessionId(id: string): void {
  if (id.length === 0) throw new Error("session id is empty");
  if (id === "..") throw new Error("invalid session id: '..'");
  const segments = id.split("/");
  for (const seg of segments) {
    if (seg.length === 0) throw new Error("invalid session id: empty segment");
    if (seg === "..") throw new Error("invalid session id: '..' segment");
  }
  const [top, ...children] = segments;
  if (!UUID_RE.test(top!)) {
    throw new Error(`invalid session id: top-level '${top}' is not a manager-minted UUID`);
  }
  for (const c of children) {
    if (!CHILD_RE.test(c)) {
      throw new Error(`invalid session id: child segment '${c}' must match ${CHILD_RE.source}`);
    }
  }
}
```

- [ ] **Step 4: Run, see pass**

```bash
cd plugins/llm-session-manager && bun test test/validation.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-session-manager/validation.ts plugins/llm-session-manager/test/validation.test.ts
git commit -m "feat(llm-session-manager): full session id validation (childId, parse, validate)"
```

### Task 2.4: `paths.ts` — TDD

**Files:**
- Create: `plugins/llm-session-manager/paths.ts`
- Create: `plugins/llm-session-manager/test/paths.test.ts`

- [ ] **Step 1: Write the failing test**

`plugins/llm-session-manager/test/paths.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { sessionPaths, harnessRoot } from "../paths";

describe("harnessRoot", () => {
  test("joins base with harness key", () => {
    expect(harnessRoot("/home/u/.kaizen/sessions", "official_openai-compatible"))
      .toBe("/home/u/.kaizen/sessions/official_openai-compatible");
  });
});

describe("sessionPaths", () => {
  test("top-level session", () => {
    const p = sessionPaths(
      "/home/u/.kaizen/sessions/official_openai-compatible",
      "7f3e1234-89ab-cdef-0123-456789abcdef",
    );
    expect(p.dir).toBe("/home/u/.kaizen/sessions/official_openai-compatible/7f3e1234-89ab-cdef-0123-456789abcdef");
    expect(p.snapshot).toBe(`${p.dir}/snapshot.json`);
    expect(p.snapshotTmp).toBe(`${p.dir}/snapshot.json.tmp`);
    expect(p.events).toBe(`${p.dir}/events.jsonl`);
  });
  test("nested session: dirs nest", () => {
    const p = sessionPaths(
      "/home/u/.kaizen/sessions/official_openai-compatible",
      "7f3e1234-89ab-cdef-0123-456789abcdef/reviewer-fileA",
    );
    expect(p.dir).toBe("/home/u/.kaizen/sessions/official_openai-compatible/7f3e1234-89ab-cdef-0123-456789abcdef/reviewer-fileA");
  });
  test("indexFile", () => {
    expect(harnessRoot("/base", "k") + "/index.jsonl").toBe("/base/k/index.jsonl");
  });
});
```

- [ ] **Step 2: Run, see fail**

```bash
cd plugins/llm-session-manager && bun test test/paths.test.ts
```

- [ ] **Step 3: Implement**

`plugins/llm-session-manager/paths.ts`:

```ts
import { join } from "node:path";

export function harnessRoot(sessionsBase: string, harnessKey: string): string {
  return join(sessionsBase, harnessKey);
}

export interface SessionPaths {
  dir: string;
  snapshot: string;
  snapshotTmp: string;
  events: string;
}

export function sessionPaths(harnessDir: string, sessionId: string): SessionPaths {
  // sessionId may contain '/' for sub-sessions. join() preserves that as a real subdirectory.
  const dir = join(harnessDir, sessionId);
  return {
    dir,
    snapshot: join(dir, "snapshot.json"),
    snapshotTmp: join(dir, "snapshot.json.tmp"),
    events: join(dir, "events.jsonl"),
  };
}

export function indexFile(harnessDir: string): string {
  return join(harnessDir, "index.jsonl");
}
```

- [ ] **Step 4: Run, see pass + commit**

```bash
cd plugins/llm-session-manager && bun test test/paths.test.ts
git add plugins/llm-session-manager/paths.ts plugins/llm-session-manager/test/paths.test.ts
git commit -m "feat(llm-session-manager): pure path resolution"
```

### Task 2.5: `snapshot.ts` — TDD

**Files:**
- Create: `plugins/llm-session-manager/snapshot.ts`
- Create: `plugins/llm-session-manager/test/snapshot.test.ts`

- [ ] **Step 1: Write the failing test**

`plugins/llm-session-manager/test/snapshot.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSnapshot, writeSnapshotAtomic, type Snapshot } from "../snapshot";

function tmp() {
  return mkdtempSync(join(tmpdir(), "smtest-"));
}

const sample: Snapshot = {
  schemaVersion: 1,
  id: "7f3e1234-89ab-cdef-0123-456789abcdef",
  harness: "official_openai-compatible",
  parentSessionId: undefined,
  alias: undefined,
  agentName: undefined,
  model: undefined,
  metadata: {},
  createdAt: 1715000000000,
  lastTurnAt: undefined,
  pluginFingerprint: ["llm-driver@0.1.0"],
  messages: [],
};

describe("readSnapshot/writeSnapshotAtomic", () => {
  test("write then read round-trips", async () => {
    const dir = tmp();
    const path = join(dir, "snapshot.json");
    const tmpPath = join(dir, "snapshot.json.tmp");
    await writeSnapshotAtomic(path, tmpPath, sample);
    const loaded = await readSnapshot(path);
    expect(loaded).toEqual(sample);
  });

  test("atomic rename: tmp file is gone after write", async () => {
    const dir = tmp();
    const path = join(dir, "snapshot.json");
    const tmpPath = join(dir, "snapshot.json.tmp");
    await writeSnapshotAtomic(path, tmpPath, sample);
    expect(existsSync(tmpPath)).toBe(false);
    expect(existsSync(path)).toBe(true);
  });

  test("readSnapshot throws on missing file", async () => {
    const dir = tmp();
    expect(() => readSnapshot(join(dir, "nope.json"))).toThrow();
  });

  test("readSnapshot throws on invalid JSON", async () => {
    const dir = tmp();
    const path = join(dir, "bad.json");
    writeFileSync(path, "{ not json");
    expect(() => readSnapshot(path)).toThrow();
  });

  test("readSnapshot throws on schema version mismatch", async () => {
    const dir = tmp();
    const path = join(dir, "schema.json");
    writeFileSync(path, JSON.stringify({ ...sample, schemaVersion: 99 }));
    expect(() => readSnapshot(path)).toThrow(/schema/i);
  });

  test("writeSnapshotAtomic ignores stale tmp from a prior crash", async () => {
    const dir = tmp();
    const path = join(dir, "snapshot.json");
    const tmpPath = join(dir, "snapshot.json.tmp");
    writeFileSync(tmpPath, "{ corrupted half-write");
    await writeSnapshotAtomic(path, tmpPath, sample);
    const loaded = await readSnapshot(path);
    expect(loaded).toEqual(sample);
    expect(existsSync(tmpPath)).toBe(false);
  });
});
```

- [ ] **Step 2: Run, see fail**

```bash
cd plugins/llm-session-manager && bun test test/snapshot.test.ts
```

- [ ] **Step 3: Implement**

`plugins/llm-session-manager/snapshot.ts`:

```ts
import { mkdirSync, openSync, fsyncSync, closeSync, writeFileSync, renameSync, readFileSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import type { ChatMessage } from "llm-events/public";

export interface Snapshot {
  schemaVersion: 1;
  id: string;
  harness: string;
  parentSessionId?: string;
  alias?: string;
  agentName?: string;
  model?: string;
  metadata: Record<string, unknown>;
  createdAt: number;
  lastTurnAt?: number;
  pluginFingerprint: string[];
  messages: ChatMessage[];
}

export async function writeSnapshotAtomic(path: string, tmpPath: string, snap: Snapshot): Promise<void> {
  if (snap.schemaVersion !== 1) {
    throw new Error(`writeSnapshotAtomic: unsupported schemaVersion ${snap.schemaVersion}`);
  }
  mkdirSync(dirname(path), { recursive: true });
  // Best-effort cleanup of any stale tmp from a crashed prior write — a stale
  // tmp on disk is not load-bearing because we always overwrite via O_TRUNC.
  try { unlinkSync(tmpPath); } catch { /* not present, fine */ }
  const json = JSON.stringify(snap);
  // Open with O_TRUNC|O_WRONLY|O_CREAT, write, fsync, close, rename.
  const fd = openSync(tmpPath, "w");
  try {
    writeFileSync(fd, json);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, path);
}

export function readSnapshot(path: string): Snapshot {
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as Snapshot;
  if (parsed.schemaVersion !== 1) {
    throw new Error(`readSnapshot: unsupported schemaVersion ${parsed.schemaVersion}`);
  }
  return parsed;
}
```

- [ ] **Step 4: Run, see pass + commit**

```bash
cd plugins/llm-session-manager && bun test test/snapshot.test.ts
git add plugins/llm-session-manager/snapshot.ts plugins/llm-session-manager/test/snapshot.test.ts
git commit -m "feat(llm-session-manager): atomic snapshot write/read"
```

### Task 2.6: `events-log.ts` — TDD

**Files:**
- Create: `plugins/llm-session-manager/events-log.ts`
- Create: `plugins/llm-session-manager/test/events-log.test.ts`

- [ ] **Step 1: Write the failing test**

`plugins/llm-session-manager/test/events-log.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openEventsLog, type EventLogEntry } from "../events-log";

function tmp() { return mkdtempSync(join(tmpdir(), "evtest-")); }

describe("events-log", () => {
  test("first open: starts at offset 0", async () => {
    const dir = tmp();
    const log = openEventsLog(join(dir, "events.jsonl"));
    expect(log.nextOffset()).toBe(0);
  });

  test("flush is a no-op before the first append", async () => {
    const dir = tmp();
    const log = openEventsLog(join(dir, "events.jsonl"));
    await expect(log.flush()).resolves.toBeUndefined();
  });

  test("append: monotonic offsets, persisted to disk", async () => {
    const dir = tmp();
    const path = join(dir, "events.jsonl");
    const log = openEventsLog(path);
    await log.append({ ts: 1, event: "turn:start", payload: { turnId: "t1" } });
    await log.append({ ts: 2, event: "llm:request", payload: { turnId: "t1" } });
    await log.flush();
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed[0].offset).toBe(0);
    expect(parsed[1].offset).toBe(1);
    expect(parsed[0].event).toBe("turn:start");
  });

  test("reopen after flush: continues offsets", async () => {
    const dir = tmp();
    const path = join(dir, "events.jsonl");
    const log1 = openEventsLog(path);
    await log1.append({ ts: 1, event: "turn:start", payload: {} });
    await log1.flush();
    const log2 = openEventsLog(path);
    expect(log2.nextOffset()).toBe(1);
    await log2.append({ ts: 2, event: "turn:end", payload: {} });
    await log2.flush();
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!).offset).toBe(1);
  });

  test("recovery: partial trailing line is truncated", async () => {
    const dir = tmp();
    const path = join(dir, "events.jsonl");
    writeFileSync(
      path,
      `{"offset":0,"ts":1,"event":"turn:start","payload":{}}\n{"offset":1,"ts":2,"event":"llm:re`,
    );
    const log = openEventsLog(path);
    expect(log.nextOffset()).toBe(1);
    const after = readFileSync(path, "utf8");
    expect(after.endsWith("\n")).toBe(true);
    expect(after.split("\n").filter(Boolean)).toHaveLength(1);
  });

  test("readEvents: streams entries with fromOffset/limit", async () => {
    const dir = tmp();
    const path = join(dir, "events.jsonl");
    const log = openEventsLog(path);
    for (let i = 0; i < 5; i++) {
      await log.append({ ts: i, event: "turn:start", payload: { i } });
    }
    await log.flush();
    const out: EventLogEntry[] = [];
    for await (const e of log.readEvents({ fromOffset: 2, limit: 2 })) {
      out.push(e);
    }
    expect(out).toHaveLength(2);
    expect(out[0]!.offset).toBe(2);
    expect(out[1]!.offset).toBe(3);
  });
});
```

- [ ] **Step 2: Run, see fail**

```bash
cd plugins/llm-session-manager && bun test test/events-log.test.ts
```

- [ ] **Step 3: Implement**

`plugins/llm-session-manager/events-log.ts`:

```ts
import {
  appendFileSync, openSync, fsyncSync, closeSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync,
} from "node:fs";
import { dirname } from "node:path";

export interface EventLogEntry {
  offset: number;
  ts: number;
  event: string;
  payload: { turnId?: string; sessionId?: string } & Record<string, unknown>;
}

export interface EventsLog {
  nextOffset(): number;
  append(entry: Omit<EventLogEntry, "offset">): Promise<EventLogEntry>;
  flush(): Promise<void>;
  readEvents(opts?: { fromOffset?: number; limit?: number }): AsyncIterable<EventLogEntry>;
  close(): void;
}

/**
 * Open (or create) an events.jsonl file. Recovers a partial trailing line if
 * present (no terminating newline).
 */
export function openEventsLog(path: string): EventsLog {
  mkdirSync(dirname(path), { recursive: true });
  let nextOffset = 0;

  if (existsSync(path)) {
    const raw = readFileSync(path, "utf8");
    let lastNewline = raw.lastIndexOf("\n");
    if (lastNewline < raw.length - 1) {
      // Partial trailing line — truncate to last \n (or empty if there's no \n).
      writeFileSync(path, lastNewline >= 0 ? raw.slice(0, lastNewline + 1) : "");
    }
    const cleaned = readFileSync(path, "utf8");
    if (cleaned.length > 0) {
      const lines = cleaned.split("\n").filter(Boolean);
      const last = lines[lines.length - 1]!;
      try {
        const parsed = JSON.parse(last) as EventLogEntry;
        nextOffset = parsed.offset + 1;
      } catch {
        // Recovery already truncated; treat as empty.
        nextOffset = 0;
      }
    }
  }

  return {
    nextOffset() { return nextOffset; },

    async append(entry) {
      const full: EventLogEntry = { offset: nextOffset++, ts: entry.ts, event: entry.event, payload: entry.payload };
      const line = JSON.stringify(full) + "\n";
      // O_APPEND-equivalent.
      appendFileSync(path, line);
      return full;
    },

    async flush() {
      // fsync the file so events are durable across crashes.
      if (!existsSync(path)) return;
      const fd = openSync(path, "r");
      try { fsyncSync(fd); } finally { closeSync(fd); }
    },

    async *readEvents(opts) {
      if (!existsSync(path)) return;
      const stat = statSync(path);
      if (stat.size === 0) return;
      const raw = readFileSync(path, "utf8");
      const fromOffset = opts?.fromOffset ?? 0;
      const limit = opts?.limit ?? Number.POSITIVE_INFINITY;
      let yielded = 0;
      for (const line of raw.split("\n")) {
        if (!line) continue;
        let parsed: EventLogEntry;
        try { parsed = JSON.parse(line); } catch { continue; }
        if (parsed.offset < fromOffset) continue;
        yield parsed;
        if (++yielded >= limit) return;
      }
    },

    close() { /* no fd held for append path; included for symmetry */ },
  };
}
```

- [ ] **Step 4: Run, see pass + commit**

```bash
cd plugins/llm-session-manager && bun test test/events-log.test.ts
git add plugins/llm-session-manager/events-log.ts plugins/llm-session-manager/test/events-log.test.ts
git commit -m "feat(llm-session-manager): append-only events.jsonl with partial-line recovery"
```

### Task 2.7: `index-jsonl.ts` — TDD

**Files:**
- Create: `plugins/llm-session-manager/index-jsonl.ts`
- Create: `plugins/llm-session-manager/test/index-jsonl.test.ts`

- [ ] **Step 1: Write the failing test**

`plugins/llm-session-manager/test/index-jsonl.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openIndex, type IndexEntry, rebuildIndexFromDisk } from "../index-jsonl";

function tmp() { return mkdtempSync(join(tmpdir(), "idxtest-")); }

describe("index-jsonl", () => {
  test("appendCreate then list returns the entry", async () => {
    const dir = tmp();
    const idx = openIndex(join(dir, "index.jsonl"));
    await idx.appendCreate({ id: "u1", harness: "h", parentSessionId: undefined, alias: "a", createdAt: 1 });
    expect(idx.list()).toHaveLength(1);
    expect(idx.list()[0]!.id).toBe("u1");
  });

  test("appendDelete removes from in-memory list", async () => {
    const dir = tmp();
    const idx = openIndex(join(dir, "index.jsonl"));
    await idx.appendCreate({ id: "u1", harness: "h", createdAt: 1 });
    await idx.appendCreate({ id: "u2", harness: "h", createdAt: 2 });
    await idx.appendDelete({ id: "u1", cascade: false });
    expect(idx.list().map((e) => e.id)).toEqual(["u2"]);
  });

  test("appendUpdate updates lastTurnAt in memory", async () => {
    const dir = tmp();
    const idx = openIndex(join(dir, "index.jsonl"));
    await idx.appendCreate({ id: "u1", harness: "h", createdAt: 1 });
    await idx.appendUpdate({ id: "u1", lastTurnAt: 99 });
    expect(idx.list()[0]!.lastTurnAt).toBe(99);
  });

  test("reopen replays ops to reconstruct state", async () => {
    const dir = tmp();
    const file = join(dir, "index.jsonl");
    const idx1 = openIndex(file);
    await idx1.appendCreate({ id: "u1", harness: "h", createdAt: 1 });
    await idx1.appendCreate({ id: "u2", harness: "h", createdAt: 2 });
    await idx1.appendDelete({ id: "u1", cascade: false });
    const idx2 = openIndex(file);
    expect(idx2.list().map((e) => e.id)).toEqual(["u2"]);
  });

  test("rebuildIndexFromDisk: walks nested snapshot.json files", async () => {
    const dir = tmp();
    const harnessDir = join(dir, "h");
    // Top-level
    mkdirSync(join(harnessDir, "uuid-a"), { recursive: true });
    writeFileSync(
      join(harnessDir, "uuid-a", "snapshot.json"),
      JSON.stringify({ schemaVersion: 1, id: "uuid-a", harness: "h", metadata: {}, createdAt: 1, pluginFingerprint: [], messages: [] }),
    );
    // Sub-session
    mkdirSync(join(harnessDir, "uuid-a", "child-x"), { recursive: true });
    writeFileSync(
      join(harnessDir, "uuid-a", "child-x", "snapshot.json"),
      JSON.stringify({ schemaVersion: 1, id: "uuid-a/child-x", harness: "h", parentSessionId: "uuid-a", metadata: {}, createdAt: 2, pluginFingerprint: [], messages: [] }),
    );
    const entries = rebuildIndexFromDisk(harnessDir);
    expect(entries.map((e) => e.id).sort()).toEqual(["uuid-a", "uuid-a/child-x"]);
  });

  test("openIndex falls back to disk walk when index missing", async () => {
    const dir = tmp();
    const harnessDir = join(dir, "h");
    mkdirSync(join(harnessDir, "uuid-a"), { recursive: true });
    writeFileSync(
      join(harnessDir, "uuid-a", "snapshot.json"),
      JSON.stringify({ schemaVersion: 1, id: "uuid-a", harness: "h", metadata: {}, createdAt: 1, pluginFingerprint: [], messages: [] }),
    );
    const idx = openIndex(join(harnessDir, "index.jsonl"), { harnessDir });
    expect(idx.list().map((e) => e.id)).toEqual(["uuid-a"]);
  });
});
```

- [ ] **Step 2: Run, see fail**

```bash
cd plugins/llm-session-manager && bun test test/index-jsonl.test.ts
```

- [ ] **Step 3: Implement**

`plugins/llm-session-manager/index-jsonl.ts`:

```ts
import { appendFileSync, readFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { readSnapshot } from "./snapshot";

export interface IndexEntry {
  id: string;
  harness: string;
  parentSessionId?: string;
  alias?: string;
  agentName?: string;
  createdAt: number;
  lastTurnAt?: number;
}

type Op =
  | { op: "create"; entry: IndexEntry }
  | { op: "update"; id: string; lastTurnAt: number }
  | { op: "delete"; id: string; cascade: boolean };

export interface Index {
  list(): IndexEntry[];
  get(id: string): IndexEntry | undefined;
  appendCreate(e: IndexEntry): Promise<void>;
  appendUpdate(u: { id: string; lastTurnAt: number }): Promise<void>;
  appendDelete(d: { id: string; cascade: boolean }): Promise<void>;
}

export function openIndex(file: string, opts?: { harnessDir?: string }): Index {
  mkdirSync(dirname(file), { recursive: true });
  const map = new Map<string, IndexEntry>();

  if (existsSync(file)) {
    const raw = readFileSync(file, "utf8");
    for (const line of raw.split("\n")) {
      if (!line) continue;
      let op: any;
      try { op = JSON.parse(line); } catch { continue; }
      applyOp(map, op);
    }
  } else if (opts?.harnessDir && existsSync(opts.harnessDir)) {
    for (const e of rebuildIndexFromDisk(opts.harnessDir)) {
      map.set(e.id, e);
    }
  }

  return {
    list: () => Array.from(map.values()).sort((a, b) => a.createdAt - b.createdAt),
    get: (id) => map.get(id),
    async appendCreate(e) {
      const op = { op: "create" as const, ...e };
      appendFileSync(file, JSON.stringify(op) + "\n");
      map.set(e.id, e);
    },
    async appendUpdate(u) {
      const op = { op: "update" as const, ...u };
      appendFileSync(file, JSON.stringify(op) + "\n");
      const cur = map.get(u.id);
      if (cur) map.set(u.id, { ...cur, lastTurnAt: u.lastTurnAt });
    },
    async appendDelete(d) {
      const op = { op: "delete" as const, ...d };
      appendFileSync(file, JSON.stringify(op) + "\n");
      map.delete(d.id);
      if (d.cascade) {
        for (const k of Array.from(map.keys())) {
          if (k.startsWith(d.id + "/")) map.delete(k);
        }
      }
    },
  };
}

function applyOp(map: Map<string, IndexEntry>, op: any): void {
  switch (op.op) {
    case "create": {
      const { op: _, ...rest } = op;
      map.set(rest.id, rest as IndexEntry);
      break;
    }
    case "update": {
      const cur = map.get(op.id);
      if (cur) map.set(op.id, { ...cur, lastTurnAt: op.lastTurnAt });
      break;
    }
    case "delete": {
      map.delete(op.id);
      if (op.cascade) {
        for (const k of Array.from(map.keys())) {
          if (k.startsWith(op.id + "/")) map.delete(k);
        }
      }
      break;
    }
  }
}

/** Recursively walk harnessDir for snapshot.json files; reconstruct IndexEntry per snapshot. */
export function rebuildIndexFromDisk(harnessDir: string): IndexEntry[] {
  const out: IndexEntry[] = [];
  function walk(dir: string) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile() && ent.name === "snapshot.json") {
        try {
          const snap = readSnapshot(p);
          out.push({
            id: snap.id,
            harness: snap.harness,
            parentSessionId: snap.parentSessionId,
            alias: snap.alias,
            agentName: snap.agentName,
            createdAt: snap.createdAt,
            lastTurnAt: snap.lastTurnAt,
          });
        } catch {
          // Corrupt snapshot — skip; the recovery path is best-effort.
        }
      }
    }
  }
  walk(harnessDir);
  return out;
}
```

- [ ] **Step 4: Run, see pass + commit**

```bash
cd plugins/llm-session-manager && bun test test/index-jsonl.test.ts
git add plugins/llm-session-manager/index-jsonl.ts plugins/llm-session-manager/test/index-jsonl.test.ts
git commit -m "feat(llm-session-manager): index.jsonl op log + disk-walk fallback"
```

### Task 2.8: `store.ts` — the orchestrator

This task is bigger than the previous ones because it's where the contract semantics land (TurnHandle, validation chokepoint, in-memory cache, alias collisions, single-writer rule, getMessages-during-turn read-your-writes).

**Files:**
- Create: `plugins/llm-session-manager/store.ts`
- Create: `plugins/llm-session-manager/test/store.test.ts`

- [ ] **Step 1: Write the failing test**

`plugins/llm-session-manager/test/store.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeStore } from "../store";

function setup() {
  const base = mkdtempSync(join(tmpdir(), "store-"));
  const store = makeStore({
    sessionsBase: base,
    harnessKey: "h",
    pluginFingerprint: ["llm-driver@0.1.0"],
    now: () => 1715000000000,
    newUuid: (() => {
      let n = 0;
      return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
    })(),
    log: () => {},
    emit: async () => [],
  });
  return { base, store };
}

describe("store: create / load / list / delete", () => {
  test("create top-level: returns a SessionRecord with UUID id", async () => {
    const { store } = setup();
    const r = await store.create({});
    expect(r.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.parentSessionId).toBeUndefined();
    expect(r.harness).toBe("h");
  });

  test("create sub-session requires parent + childId", async () => {
    const { store } = setup();
    const parent = await store.create({});
    await expect(store.create({ parentSessionId: parent.id })).rejects.toThrow(/childId/);
    const child = await store.create({ parentSessionId: parent.id, childId: "review-A" });
    expect(child.id).toBe(`${parent.id}/review-A`);
  });

  test("create sub-session with invalid childId throws", async () => {
    const { store } = setup();
    const parent = await store.create({});
    await expect(store.create({ parentSessionId: parent.id, childId: "a/b" })).rejects.toThrow();
    await expect(store.create({ parentSessionId: parent.id, childId: ".." })).rejects.toThrow();
    await expect(store.create({ parentSessionId: parent.id, childId: "" })).rejects.toThrow();
  });

  test("alias collision under same parent throws", async () => {
    const { store } = setup();
    await store.create({ alias: "main" });
    await expect(store.create({ alias: "main" })).rejects.toThrow(/alias/i);
  });

  test("load: returns SessionRecord without messages", async () => {
    const { store } = setup();
    const r = await store.create({});
    const loaded = await store.load(r.id);
    expect(loaded.id).toBe(r.id);
    expect((loaded as any).messages).toBeUndefined();
  });

  test("load missing throws", async () => {
    const { store } = setup();
    await expect(store.load("00000000-0000-4000-8000-000000000999")).rejects.toThrow();
  });

  test("list: top-level only by default", async () => {
    const { store } = setup();
    const a = await store.create({ alias: "a" });
    await store.create({ parentSessionId: a.id, childId: "child1" });
    const top = await store.list();
    expect(top.map((r) => r.id)).toEqual([a.id]);
  });

  test("list({ includeChildren: true }) includes sub-sessions", async () => {
    const { store } = setup();
    const a = await store.create({});
    await store.create({ parentSessionId: a.id, childId: "child1" });
    const all = await store.list({ includeChildren: true });
    expect(all.length).toBe(2);
  });

  test("delete throws if children exist and not cascade", async () => {
    const { store } = setup();
    const a = await store.create({});
    await store.create({ parentSessionId: a.id, childId: "child1" });
    await expect(store.delete(a.id)).rejects.toThrow(/children/i);
  });

  test("delete cascade removes descendants", async () => {
    const { store } = setup();
    const a = await store.create({});
    await store.create({ parentSessionId: a.id, childId: "child1" });
    await store.delete(a.id, { cascade: true });
    expect(await store.list({ includeChildren: true })).toHaveLength(0);
  });

  test("validates malformed full session ids on public API", async () => {
    const { store } = setup();
    await expect(store.load("not-a-uuid")).rejects.toThrow();
    await expect(store.load("00000000-0000-4000-8000-000000000001/..")).rejects.toThrow();
  });
});

describe("store: turn handle", () => {
  test("beginTurn → append → commit persists to snapshot", async () => {
    const { store } = setup();
    const r = await store.create({});
    const handle = store.beginTurn(r.id, "t-abc");
    handle.append({ role: "user", content: "hi" });
    await handle.commit();
    const msgs = await store.getMessages(r.id);
    expect(msgs).toEqual([{ role: "user", content: "hi" }]);
  });

  test("beginTurn → append → rollback discards appends", async () => {
    const { store } = setup();
    const r = await store.create({});
    const handle = store.beginTurn(r.id, "t-abc");
    handle.append({ role: "user", content: "hi" });
    await handle.rollback();
    const msgs = await store.getMessages(r.id);
    expect(msgs).toEqual([]);
  });

  test("beginTurn while another turn is open throws", () => {
    const { store } = setup();
    return store.create({}).then((r) => {
      store.beginTurn(r.id, "t-1");
      expect(() => store.beginTurn(r.id, "t-2")).toThrow(/already/i);
    });
  });

  test("beginTurn on different sessions concurrently is OK", async () => {
    const { store } = setup();
    const a = await store.create({});
    const b = await store.create({});
    const ha = store.beginTurn(a.id, "t-a");
    const hb = store.beginTurn(b.id, "t-b");
    expect(ha.turnId).toBe("t-a");
    expect(hb.turnId).toBe("t-b");
  });

  test("getMessages during open turn includes buffered appends", async () => {
    const { store } = setup();
    const r = await store.create({});
    const h = store.beginTurn(r.id, "t");
    h.append({ role: "user", content: "u" });
    h.append({ role: "assistant", content: "a" });
    expect(await store.getMessages(r.id)).toEqual([
      { role: "user", content: "u" },
      { role: "assistant", content: "a" },
    ]);
  });

  test("commit then beginTurn again proceeds", async () => {
    const { store } = setup();
    const r = await store.create({});
    const h1 = store.beginTurn(r.id, "t1");
    h1.append({ role: "user", content: "first" });
    await h1.commit();
    const h2 = store.beginTurn(r.id, "t2");
    h2.append({ role: "user", content: "second" });
    await h2.commit();
    expect(await store.getMessages(r.id)).toHaveLength(2);
  });

  test("rollback is idempotent and a no-op after commit", async () => {
    const { store } = setup();
    const r = await store.create({});
    const h = store.beginTurn(r.id, "t");
    h.append({ role: "user", content: "x" });
    await h.commit();
    await h.rollback(); // should not throw, should not delete
    expect(await store.getMessages(r.id)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run, see fail**

```bash
cd plugins/llm-session-manager && bun test test/store.test.ts
```

- [ ] **Step 3: Implement**

`plugins/llm-session-manager/store.ts`:

```ts
import type { ChatMessage } from "llm-events/public";
import { harnessRoot, sessionPaths, indexFile } from "./paths";
import { readSnapshot, writeSnapshotAtomic, type Snapshot } from "./snapshot";
import { openEventsLog, type EventLogEntry, type EventsLog } from "./events-log";
import { openIndex, type Index, type IndexEntry } from "./index-jsonl";
import { isValidChildId, validateFullSessionId, parseSessionId } from "./validation";
import { mkdirSync, rmSync } from "node:fs";

export interface SessionRecord {
  id: string;
  harness: string;
  parentSessionId?: string;
  alias?: string;
  agentName?: string;
  model?: string;
  metadata: Record<string, unknown>;
  createdAt: number;
  lastTurnAt?: number;
  pluginFingerprint: string[];
}

export interface TurnHandle {
  readonly turnId: string;
  append(msg: ChatMessage): void;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface SessionsStoreService {
  create(opts: {
    parentSessionId?: string;
    childId?: string;
    alias?: string;
    agentName?: string;
    model?: string;
    metadata?: Record<string, unknown>;
  }): Promise<SessionRecord>;
  load(id: string): Promise<SessionRecord>;
  exists(id: string): Promise<boolean>;
  getMessages(id: string): Promise<ChatMessage[]>;
  beginTurn(id: string, turnId: string): TurnHandle;
  list(opts?: { parentSessionId?: string | null; includeChildren?: boolean; limit?: number }): Promise<SessionRecord[]>;
  delete(id: string, opts?: { cascade?: boolean }): Promise<void>;
  readEvents(id: string, opts?: { fromOffset?: number; limit?: number }): AsyncIterable<EventLogEntry>;
  // Internal escape hatch used by the trace subscriber to write events tagged with a turnId.
  // (Kept on the public type so the subscriber doesn't need to import internals; consumers ignore.)
  internalAppendEvent?(sessionId: string, ts: number, event: string, payload: any): Promise<void>;
}

interface OpenSession {
  record: SessionRecord;
  snapshot: Snapshot;
  events: EventsLog;
  openTurn?: { handle: TurnHandle; bufferedMessages: ChatMessage[] };
}

export interface StoreDeps {
  sessionsBase: string;
  harnessKey: string;
  pluginFingerprint: string[];
  now: () => number;
  newUuid: () => string;
  log: (msg: string) => void;
  emit: (event: string, payload: unknown) => Promise<unknown[]>;
}

export function makeStore(deps: StoreDeps): SessionsStoreService {
  const root = harnessRoot(deps.sessionsBase, deps.harnessKey);
  mkdirSync(root, { recursive: true });
  const index = openIndex(indexFile(root), { harnessDir: root });
  const open = new Map<string, OpenSession>();

  function loadIntoCache(id: string): OpenSession {
    const cached = open.get(id);
    if (cached) return cached;
    const paths = sessionPaths(root, id);
    const snapshot = readSnapshot(paths.snapshot);
    const events = openEventsLog(paths.events);
    const sess: OpenSession = { record: recordFromSnapshot(snapshot), snapshot, events };
    open.set(id, sess);
    return sess;
  }

  function recordFromSnapshot(s: Snapshot): SessionRecord {
    return {
      id: s.id,
      harness: s.harness,
      parentSessionId: s.parentSessionId,
      alias: s.alias,
      agentName: s.agentName,
      model: s.model,
      metadata: s.metadata,
      createdAt: s.createdAt,
      lastTurnAt: s.lastTurnAt,
      pluginFingerprint: s.pluginFingerprint,
    };
  }

  async function create(opts: Parameters<SessionsStoreService["create"]>[0]): Promise<SessionRecord> {
    const parentId = opts.parentSessionId;
    let id: string;
    if (parentId) {
      if (!opts.childId) throw new Error("create: childId is required for sub-sessions");
      if (!isValidChildId(opts.childId)) {
        throw new Error(`create: childId '${opts.childId}' must match ^[A-Za-z0-9_.-]+$`);
      }
      // Parent must exist.
      if (!index.get(parentId)) throw new Error(`create: parent session '${parentId}' does not exist`);
      id = `${parentId}/${opts.childId}`;
      if (index.get(id)) throw new Error(`create: session '${id}' already exists`);
    } else {
      id = deps.newUuid();
    }
    if (opts.alias) {
      const collision = index.list().find((e) => e.alias === opts.alias && e.parentSessionId === parentId);
      if (collision) throw new Error(`create: alias '${opts.alias}' already in use under same parent`);
    }
    const now = deps.now();
    const snap: Snapshot = {
      schemaVersion: 1,
      id,
      harness: deps.harnessKey,
      parentSessionId: parentId,
      alias: opts.alias,
      agentName: opts.agentName,
      model: opts.model,
      metadata: opts.metadata ?? {},
      createdAt: now,
      lastTurnAt: undefined,
      pluginFingerprint: deps.pluginFingerprint.slice().sort(),
      messages: [],
    };
    const paths = sessionPaths(root, id);
    mkdirSync(paths.dir, { recursive: true });
    await writeSnapshotAtomic(paths.snapshot, paths.snapshotTmp, snap);
    const record = recordFromSnapshot(snap);
    await index.appendCreate({
      id, harness: snap.harness, parentSessionId: parentId, alias: opts.alias, agentName: opts.agentName, createdAt: now,
    });
    open.set(id, { record, snapshot: snap, events: openEventsLog(paths.events) });
    await deps.emit("session:created", {
      id, harness: snap.harness, parentSessionId: parentId, alias: opts.alias, agentName: opts.agentName,
    });
    return record;
  }

  async function load(id: string): Promise<SessionRecord> {
    validateFullSessionId(id);
    if (!index.get(id)) throw new Error(`load: session '${id}' not found`);
    return loadIntoCache(id).record;
  }

  async function exists(id: string): Promise<boolean> {
    try { validateFullSessionId(id); } catch { return false; }
    return Boolean(index.get(id));
  }

  async function getMessages(id: string): Promise<ChatMessage[]> {
    validateFullSessionId(id);
    const sess = loadIntoCache(id);
    const base = sess.snapshot.messages;
    if (sess.openTurn) return [...base, ...sess.openTurn.bufferedMessages];
    return base.slice();
  }

  function beginTurn(id: string, turnId: string): TurnHandle {
    validateFullSessionId(id);
    const sess = loadIntoCache(id);
    if (sess.openTurn) throw new Error(`beginTurn: session '${id}' already has an open turn`);
    const buffered: ChatMessage[] = [];
    let closed = false;
    const handle: TurnHandle = {
      turnId,
      append(msg) {
        if (closed) throw new Error("turnHandle: append after commit/rollback");
        buffered.push(msg);
      },
      async commit() {
        if (closed) return;
        const newMessages = [...sess.snapshot.messages, ...buffered];
        const next: Snapshot = { ...sess.snapshot, messages: newMessages, lastTurnAt: deps.now() };
        const paths = sessionPaths(root, id);
        // Flush the event-log tail before snapshot write. After snapshot write
        // succeeds, no required operation below is allowed to throw; otherwise
        // a commit failure would leave a newer snapshot while the driver tries
        // to roll back the turn.
        await sess.events.flush();
        await writeSnapshotAtomic(paths.snapshot, paths.snapshotTmp, next);
        closed = true;
        sess.snapshot = next;
        sess.record = recordFromSnapshot(next);
        sess.openTurn = undefined;
        try {
          await index.appendUpdate({ id, lastTurnAt: next.lastTurnAt! });
        } catch (err) {
          // index.jsonl is a derived view; startup rebuild can recover from
          // stale/missing updates. Do not convert a successful snapshot commit
          // into a turn failure because the index append lagged.
          deps.log(`sessions: index update failed for ${id}: ${String((err as any)?.message ?? err)}`);
        }
      },
      async rollback() {
        if (closed) return; // post-commit rollback is a no-op
        closed = true;
        sess.openTurn = undefined;
      },
    };
    sess.openTurn = { handle, bufferedMessages: buffered };
    return handle;
  }

  async function list(opts?: { parentSessionId?: string | null; includeChildren?: boolean; limit?: number }): Promise<SessionRecord[]> {
    const all = index.list();
    const filtered = all.filter((e) => {
      if (opts?.includeChildren) return true;
      if (opts?.parentSessionId === undefined || opts?.parentSessionId === null) {
        return e.parentSessionId === undefined;
      }
      return e.parentSessionId === opts.parentSessionId;
    });
    const limited = opts?.limit ? filtered.slice(0, opts.limit) : filtered;
    return limited.map((e) => loadIntoCache(e.id).record);
  }

  async function deleteSession(id: string, opts?: { cascade?: boolean }): Promise<void> {
    validateFullSessionId(id);
    if (!index.get(id)) throw new Error(`delete: session '${id}' not found`);
    const children = index.list().filter((e) => e.parentSessionId === id || (e.id.startsWith(id + "/")));
    if (children.length > 0 && !opts?.cascade) {
      throw new Error(`delete: session '${id}' has children; pass cascade: true`);
    }
    const paths = sessionPaths(root, id);
    rmSync(paths.dir, { recursive: true, force: true });
    if (opts?.cascade) {
      // children are inside paths.dir, so already gone
    }
    open.delete(id);
    if (opts?.cascade) {
      for (const k of Array.from(open.keys())) if (k.startsWith(id + "/")) open.delete(k);
    }
    await index.appendDelete({ id, cascade: !!opts?.cascade });
    await deps.emit("session:deleted", { id, cascade: !!opts?.cascade });
  }

  async function* readEvents(id: string, opts?: { fromOffset?: number; limit?: number }): AsyncIterable<EventLogEntry> {
    validateFullSessionId(id);
    const sess = loadIntoCache(id);
    yield* sess.events.readEvents(opts);
  }

  async function internalAppendEvent(sessionId: string, ts: number, event: string, payload: any): Promise<void> {
    if (!index.get(sessionId)) return;
    const sess = loadIntoCache(sessionId);
    await sess.events.append({ ts, event, payload });
    if (event === "turn:end") await sess.events.flush();
  }

  return {
    create, load, exists, getMessages, beginTurn, list,
    delete: deleteSession,
    readEvents,
    internalAppendEvent,
  };
}
```

- [ ] **Step 4: Run, see pass + commit**

```bash
cd plugins/llm-session-manager && bun test test/store.test.ts
git add plugins/llm-session-manager/store.ts plugins/llm-session-manager/test/store.test.ts
git commit -m "feat(llm-session-manager): SessionsStoreService with turn handles, validation, alias rules"
```

### Task 2.9: `trace-subscriber.ts` — TDD

**Files:**
- Create: `plugins/llm-session-manager/trace-subscriber.ts`
- Create: `plugins/llm-session-manager/test/trace-subscriber.test.ts`

The trace subscriber receives events emitted on the bus and routes turn-scoped events to the owning session's `events.jsonl`. It maintains a `turnId → sessionId` map populated on `turn:start` and cleared after `turn:end`.

- [ ] **Step 1: Write the failing test**

`plugins/llm-session-manager/test/trace-subscriber.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { makeTraceSubscriber } from "../trace-subscriber";

interface AppendCall {
  sessionId: string;
  ts: number;
  event: string;
  payload: any;
}

function makeFakeStore() {
  const calls: AppendCall[] = [];
  return {
    calls,
    internalAppendEvent: async (sessionId: string, ts: number, event: string, payload: any) => {
      calls.push({ sessionId, ts, event, payload });
    },
  };
}

describe("trace-subscriber", () => {
  const noopLog = (_msg: string) => {};

  test("turn:start: registers turnId→sessionId, writes turn:start to log", async () => {
    const fake = makeFakeStore();
    const sub = makeTraceSubscriber({ store: fake as any, now: () => 100, log: noopLog });
    await sub.handle("turn:start", { turnId: "t1", sessionId: "s1", trigger: "user" });
    expect(fake.calls).toEqual([
      { sessionId: "s1", ts: 100, event: "turn:start", payload: { turnId: "t1", sessionId: "s1", trigger: "user" } },
    ]);
  });

  test("llm:request etc routed by turnId", async () => {
    const fake = makeFakeStore();
    const sub = makeTraceSubscriber({ store: fake as any, now: () => 100, log: noopLog });
    await sub.handle("turn:start", { turnId: "t1", sessionId: "s1" });
    await sub.handle("llm:request", { turnId: "t1", request: { model: "m" } });
    expect(fake.calls.map((c) => c.event)).toEqual(["turn:start", "llm:request"]);
    expect(fake.calls[1]!.sessionId).toBe("s1");
  });

  test("event payload missing turnId is ignored", async () => {
    const fake = makeFakeStore();
    const sub = makeTraceSubscriber({ store: fake as any, now: () => 100, log: noopLog });
    await sub.handle("llm:request", { /* no turnId */ });
    expect(fake.calls).toEqual([]);
  });

  test("turn:end clears mapping AFTER writing turn:end", async () => {
    const fake = makeFakeStore();
    const sub = makeTraceSubscriber({ store: fake as any, now: () => 100, log: noopLog });
    await sub.handle("turn:start", { turnId: "t1", sessionId: "s1" });
    await sub.handle("turn:end", { turnId: "t1", reason: "complete" });
    // turn:end was written; now an event with the same turnId should be ignored.
    await sub.handle("llm:done", { turnId: "t1", response: {} });
    expect(fake.calls.map((c) => c.event)).toEqual(["turn:start", "turn:end"]);
  });

  test("llm:before-call is NOT logged (per spec)", async () => {
    const fake = makeFakeStore();
    const sub = makeTraceSubscriber({ store: fake as any, now: () => 100, log: noopLog });
    await sub.handle("turn:start", { turnId: "t1", sessionId: "s1" });
    await sub.handle("llm:before-call", { turnId: "t1", request: {} });
    expect(fake.calls.map((c) => c.event)).toEqual(["turn:start"]);
  });

  test("ignores known-noisy events (llm:token, llm:reasoning, llm:tool-call)", async () => {
    const fake = makeFakeStore();
    const sub = makeTraceSubscriber({ store: fake as any, now: () => 100, log: noopLog });
    await sub.handle("turn:start", { turnId: "t1", sessionId: "s1" });
    await sub.handle("llm:token", { turnId: "t1", delta: "x" });
    await sub.handle("llm:reasoning", { turnId: "t1", delta: "..." });
    await sub.handle("llm:tool-call", { turnId: "t1", toolCall: {} });
    expect(fake.calls.map((c) => c.event)).toEqual(["turn:start"]);
  });

  test("event-log write failures are logged and dropped", async () => {
    const logs: string[] = [];
    const sub = makeTraceSubscriber({
      store: { internalAppendEvent: async () => { throw new Error("disk full"); } } as any,
      now: () => 100,
      log: (msg) => logs.push(msg),
    });
    await sub.handle("turn:start", { turnId: "t1", sessionId: "s1" });
    expect(logs.join("\n")).toContain("disk full");
  });
});
```

- [ ] **Step 2: Run, see fail**

```bash
cd plugins/llm-session-manager && bun test test/trace-subscriber.test.ts
```

- [ ] **Step 3: Implement**

`plugins/llm-session-manager/trace-subscriber.ts`:

```ts
import type { SessionsStoreService } from "./store";

const LOGGED_EVENTS = new Set<string>([
  "turn:start", "turn:end", "turn:error", "turn:cancel",
  "llm:request", "llm:done", "llm:error",
  "tool:before-execute", "tool:execute", "tool:result", "tool:error",
  "codemode:code-emitted", "codemode:before-execute", "codemode:result", "codemode:error",
]);

const SKIP_EVENTS = new Set<string>([
  "llm:before-call", "llm:token", "llm:reasoning", "llm:tool-call",
]);

export interface TraceSubscriberDeps {
  store: SessionsStoreService;
  now: () => number;
  log: (msg: string) => void;
}

export interface TraceSubscriber {
  handle(event: string, payload: any): Promise<void>;
}

export function makeTraceSubscriber(deps: TraceSubscriberDeps): TraceSubscriber {
  const turnToSession = new Map<string, string>();

  return {
    async handle(event, payload) {
      if (SKIP_EVENTS.has(event)) return;
      if (!LOGGED_EVENTS.has(event)) return;
      const turnId: string | undefined = payload?.turnId;
      if (!turnId) return;

      let sessionId: string | undefined;
      if (event === "turn:start") {
        sessionId = payload?.sessionId;
        if (sessionId) turnToSession.set(turnId, sessionId);
      } else {
        sessionId = turnToSession.get(turnId);
      }
      if (!sessionId) return;

      const append = deps.store.internalAppendEvent;
      if (!append) return;
      try {
        await append(sessionId, deps.now(), event, payload);
      } catch (err) {
        deps.log(`sessions: dropped trace event ${event}: ${String((err as any)?.message ?? err)}`);
        return;
      }

      if (event === "turn:end") {
        turnToSession.delete(turnId);
      }
    },
  };
}
```

- [ ] **Step 4: Run, see pass + commit**

```bash
cd plugins/llm-session-manager && bun test test/trace-subscriber.test.ts
git add plugins/llm-session-manager/trace-subscriber.ts plugins/llm-session-manager/test/trace-subscriber.test.ts
git commit -m "feat(llm-session-manager): trace subscriber routes turn-scoped events to session logs"
```

### Task 2.10: `public.d.ts` final shape

**Files:**
- Modify: `plugins/llm-session-manager/public.d.ts`

- [ ] **Step 1: Replace placeholder with full re-exports**

`plugins/llm-session-manager/public.d.ts`:

```ts
export type {
  SessionsStoreService,
  SessionRecord,
  TurnHandle,
} from "./store";
export type { EventLogEntry } from "./events-log";
export { harnessKey } from "./harness-key";
```

- [ ] **Step 2: Verify compilation**

```bash
cd plugins/llm-session-manager && bun test
```

Expected: all tests still PASS.

- [ ] **Step 3: Commit**

```bash
git add plugins/llm-session-manager/public.d.ts
git commit -m "feat(llm-session-manager): finalize public.d.ts surface"
```

### Task 2.11: Plugin lifecycle (`index.ts`) — TDD

**Files:**
- Modify: `plugins/llm-session-manager/index.ts`
- Create: `plugins/llm-session-manager/test/index.test.ts`

- [ ] **Step 1: Write the failing test**

`plugins/llm-session-manager/test/index.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../index";

function makeCtx() {
  const services = new Map<string, any>();
  const subs = new Map<string, Array<(payload: any) => Promise<void> | void>>();
  const definedEvents = new Set<string>();
  const definedServices = new Set<string>();
  return {
    config: { sessionsBase: undefined as undefined | string },
    harness: { ref: "official/openai-compatible@0.1.0", jsonPath: undefined } as { ref?: string; jsonPath?: string },
    log: () => {},
    pluginManager: {} as any,
    runtime: { pluginManager: {} as any },
    fs: {} as any, net: {} as any, secrets: {} as any, exec: {} as any,
    defineEvent: (name: string) => { definedEvents.add(name); },
    defineService: (name: string) => { definedServices.add(name); },
    provideService: (name: string, impl: any) => { services.set(name, impl); },
    consumeService: () => {},
    useService: (name: string) => services.get(name),
    on: (event: string, handler: any) => {
      const list = subs.get(event) ?? [];
      list.push(handler);
      subs.set(event, list);
    },
    emit: async (event: string, payload?: any) => {
      const list = subs.get(event) ?? [];
      for (const h of list) await h(payload);
      return [];
    },
    services, subs, definedEvents, definedServices,
  };
}

describe("llm-session-manager plugin lifecycle", () => {
  test("setup() provides sessions:store and registers trace subscribers", async () => {
    const ctx = makeCtx();
    ctx.config = { sessionsBase: mkdtempSync(join(tmpdir(), "lifecycle-")) };
    await plugin.setup!(ctx as any);
    expect(ctx.services.has("sessions:store")).toBe(true);
    // trace subscribers registered for at least these turn-scoped events:
    expect(ctx.subs.has("turn:start")).toBe(true);
    expect(ctx.subs.has("llm:request")).toBe(true);
    expect(ctx.subs.has("tool:execute")).toBe(true);
  });

  test("setup() refuses if neither ctx.harness.ref nor jsonPath is present and no default", async () => {
    // (Default fallback to 'default' is allowed; this test asserts setup() succeeds with default key.)
    const ctx = makeCtx();
    ctx.harness = {};
    ctx.config = { sessionsBase: mkdtempSync(join(tmpdir(), "lifecycle2-")) };
    await plugin.setup!(ctx as any);
    expect(ctx.services.has("sessions:store")).toBe(true);
  });
});
```

- [ ] **Step 2: Run, see fail**

```bash
cd plugins/llm-session-manager && bun test test/index.test.ts
```

- [ ] **Step 3: Implement `index.ts`**

`plugins/llm-session-manager/index.ts`:

```ts
import type { KaizenPlugin } from "kaizen/types";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { harnessKey } from "./harness-key";
import { makeStore, type SessionsStoreService } from "./store";
import { makeTraceSubscriber } from "./trace-subscriber";

interface SessionManagerConfig {
  /** Override for tests. Defaults to ~/.kaizen/sessions. */
  sessionsBase?: string;
}

const TRACE_EVENTS = [
  "turn:start", "turn:end", "turn:error", "turn:cancel",
  "llm:request", "llm:done", "llm:error",
  "tool:before-execute", "tool:execute", "tool:result", "tool:error",
  "codemode:code-emitted", "codemode:before-execute", "codemode:result", "codemode:error",
];

const plugin: KaizenPlugin = {
  name: "llm-session-manager",
  apiVersion: "3.0.0",
  permissions: { tier: "scoped", fs: { read: ["~/.kaizen/sessions/**"], write: ["~/.kaizen/sessions/**"] } },
  services: {
    consumes: ["llm-events:vocabulary"],
    provides: ["sessions:store"],
  },

  async setup(ctx) {
    ctx.consumeService("llm-events:vocabulary");

    const cfg = (ctx.config ?? {}) as SessionManagerConfig;
    const sessionsBase = cfg.sessionsBase ?? join(homedir(), ".kaizen", "sessions");
    const key = harnessKey(ctx.harness ?? {});

    // Plugin fingerprint: kaizen does not currently expose the loaded plugin set
    // to plugins. Use a placeholder (single entry containing this plugin's name+version)
    // until the runtime exposes it. The fingerprint is recorded for meta-harness analysis;
    // a stale entry is acceptable in v0.
    const pluginFingerprint = ["llm-session-manager@0.1.0"];

    const store = makeStore({
      sessionsBase,
      harnessKey: key,
      pluginFingerprint,
      now: () => Date.now(),
      newUuid: () => randomUUID(),
      log: ctx.log.bind(ctx),
      emit: ctx.emit.bind(ctx),
    });

    ctx.defineService("sessions:store", { description: "Persistent session store with per-turn append/commit/rollback and an append-only event log." });
    ctx.provideService<SessionsStoreService>("sessions:store", store);

    const tracer = makeTraceSubscriber({ store, now: () => Date.now(), log: ctx.log.bind(ctx) });
    for (const event of TRACE_EVENTS) {
      ctx.on(event, async (payload: any) => { await tracer.handle(event, payload); });
    }
  },
};

export default plugin;
```

- [ ] **Step 4: Run, see pass**

```bash
cd plugins/llm-session-manager && bun test
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-session-manager/index.ts plugins/llm-session-manager/test/index.test.ts
git commit -m "feat(llm-session-manager): plugin lifecycle wires store + trace subscribers"
```

### Task 2.12: Crash safety integration test

**Files:**
- Create: `plugins/llm-session-manager/test/crash-safety.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeStore } from "../store";

function newStore() {
  const base = mkdtempSync(join(tmpdir(), "crash-"));
  let n = 0;
  return {
    base,
    store: makeStore({
      sessionsBase: base,
      harnessKey: "h",
      pluginFingerprint: [],
      now: () => 100 + ++n,
      newUuid: (() => {
        let m = 0;
        return () => `00000000-0000-4000-8000-${String(++m).padStart(12, "0")}`;
      })(),
      log: () => {},
      emit: async () => [],
    }),
  };
}

describe("crash safety", () => {
  test("partial trailing line in events.jsonl is truncated on reopen", async () => {
    const { base, store } = newStore();
    const r = await store.create({});
    // Simulate: write a complete line + a partial trailing line directly to disk.
    const eventsPath = join(base, "h", r.id, "events.jsonl");
    writeFileSync(
      eventsPath,
      `{"offset":0,"ts":1,"event":"turn:start","payload":{"turnId":"t","sessionId":"${r.id}"}}\n{"offset":1,"ts":2,"event":"llm:re`,
    );
    // Reopen by recreating the store against the same base.
    const next = makeStore({
      sessionsBase: base, harnessKey: "h", pluginFingerprint: [],
      now: () => 999, newUuid: () => "x", log: () => {}, emit: async () => [],
    });
    const out: any[] = [];
    for await (const e of next.readEvents(r.id)) out.push(e);
    expect(out).toHaveLength(1);
    const after = readFileSync(eventsPath, "utf8");
    expect(after.endsWith("\n")).toBe(true);
  });

  test("stale snapshot.json.tmp is cleaned on next write", async () => {
    const { base, store } = newStore();
    const r = await store.create({});
    const tmpPath = join(base, "h", r.id, "snapshot.json.tmp");
    writeFileSync(tmpPath, "{ corrupted half-write");
    const h = store.beginTurn(r.id, "t");
    h.append({ role: "user", content: "x" });
    await h.commit();
    expect(existsSync(tmpPath)).toBe(false);
  });

  test("missing index.jsonl: rebuild from disk walk recovers sessions", async () => {
    const { base, store } = newStore();
    const r1 = await store.create({});
    const r2 = await store.create({ parentSessionId: r1.id, childId: "child1" });
    // Wipe the index file (NOT the snapshots).
    const idxPath = join(base, "h", "index.jsonl");
    require("node:fs").unlinkSync(idxPath);
    const next = makeStore({
      sessionsBase: base, harnessKey: "h", pluginFingerprint: [],
      now: () => 999, newUuid: () => "x", log: () => {}, emit: async () => [],
    });
    const all = await next.list({ includeChildren: true });
    expect(all.map((e) => e.id).sort()).toEqual([r1.id, r2.id].sort());
  });

  test("crash-after-commit-before-turn:end: snapshot authoritative, no synthesized turn:end", async () => {
    const { base, store } = newStore();
    const r = await store.create({});
    const h = store.beginTurn(r.id, "t-orphan");
    h.append({ role: "user", content: "u" });
    h.append({ role: "assistant", content: "a" });
    // Manually write a turn:start to events.jsonl to simulate the trace subscriber having logged it.
    const eventsPath = join(base, "h", r.id, "events.jsonl");
    require("node:fs").appendFileSync(
      eventsPath,
      `{"offset":0,"ts":1,"event":"turn:start","payload":{"turnId":"t-orphan","sessionId":"${r.id}"}}\n`,
    );
    await h.commit();
    // No turn:end was emitted (simulating crash). Reopen.
    const next = makeStore({
      sessionsBase: base, harnessKey: "h", pluginFingerprint: [],
      now: () => 999, newUuid: () => "x", log: () => {}, emit: async () => [],
    });
    // (a) resume uses committed snapshot:
    const messages = await next.getMessages(r.id);
    expect(messages.length).toBe(2);
    // (b) events.jsonl contains turn:start with no turn:end:
    const events: any[] = [];
    for await (const e of next.readEvents(r.id)) events.push(e);
    const events_kinds = events.map((e) => e.event);
    expect(events_kinds).toContain("turn:start");
    expect(events_kinds).not.toContain("turn:end");
    // (c) snapshot.lastTurnAt > ts of last turn:start:
    const rec = await next.load(r.id);
    const start = events.find((e) => e.event === "turn:start")!;
    expect(rec.lastTurnAt!).toBeGreaterThan(start.ts);
  });
});
```

- [ ] **Step 2: Run, see fail (some new behaviors may need adjustments)**

```bash
cd plugins/llm-session-manager && bun test test/crash-safety.test.ts
```

If implementation tweaks are needed (e.g., the snapshot.tmp cleanup happens correctly), iterate on `snapshot.ts` / `events-log.ts` / `store.ts` to make these pass without regressing the earlier unit tests.

- [ ] **Step 3: Run all tests**

```bash
cd plugins/llm-session-manager && bun test
```

Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add plugins/llm-session-manager/test/crash-safety.test.ts
git commit -m "test(llm-session-manager): crash-safety integration suite"
```

### Task 2.13: Author CLAUDE.md and README.md for the plugin

**Files:**
- Create: `plugins/llm-session-manager/CLAUDE.md`
- Create: `plugins/llm-session-manager/README.md`

- [ ] **Step 1: Write `CLAUDE.md`**

Read another plugin's `CLAUDE.md` (e.g. `plugins/llm-driver/CLAUDE.md`) for style. Then author a short doc covering:
- Module map (one line per file).
- Boundaries (only `index.ts` touches ctx; everything else takes deps via factory).
- Invariants (single-writer per session; payload validation chokepoint; events-log never compacted; etc.).
- "Adding an event to the trace log" recipe.
- Test command.
- Local deploy stanza.

Length: ~120-200 lines. Match the pattern of existing CLAUDE.md files.

- [ ] **Step 2: Write `README.md`**

User-facing contract: what the plugin does, the `sessions:store` service surface, on-disk layout summary, and how to consume from another plugin. Match the style of `llm-driver/README.md`.

- [ ] **Step 3: Commit**

```bash
git add plugins/llm-session-manager/CLAUDE.md plugins/llm-session-manager/README.md
git commit -m "docs(llm-session-manager): CLAUDE.md and README.md"
```

### Task 2.14: Local deploy `llm-session-manager`

- [ ] **Step 1: Deploy**

```bash
mkdir -p ~/.kaizen/marketplaces/official/plugins/llm-session-manager@0.1.0
cp -R plugins/llm-session-manager/. ~/.kaizen/marketplaces/official/plugins/llm-session-manager@0.1.0/
(cd ~/.kaizen/marketplaces/official/plugins/llm-session-manager@0.1.0 \
  && bun build --target=bun --outfile=dist/index.js index.ts)
```

(Phase 9 adds it to the harness manifest; until then, the plugin is built but not loaded.)

---

# Phase 3: `llm-tools-registry` — `ToolExecutionContext.sessionId`

Goal: add `sessionId` to `ToolExecutionContext`, propagate `turnId`/`sessionId` into emitted `tool:*` events.

### Task 3.1: Add `sessionId` to `ToolExecutionContext` (registry side)

**Files:**
- Modify: `plugins/llm-tools-registry/registry.ts:9-14`

- [ ] **Step 1: Test addition**

In `plugins/llm-tools-registry/test/registry.test.ts`, add a new test asserting that `tool:execute`, `tool:result`, `tool:error`, and `tool:before-execute` payloads include both `turnId` and `sessionId` when those fields are set on the `ToolExecutionContext`. Read the existing `captureEmit()` helper for shape; write something like:

```ts
test("invoke includes turnId/sessionId in all tool:* event payloads", async () => {
  const events: Array<{ event: string; payload: any }> = [];
  const reg = makeRegistry(async (event, payload) => { events.push({ event, payload }); return []; });
  const off = reg.register({ name: "ok", description: "", parameters: { type: "object", properties: {} } }, async () => "ok");
  await reg.invoke("ok", {}, {
    signal: new AbortController().signal,
    callId: "c1",
    turnId: "t1",
    sessionId: "s1",
    log: () => {},
  });
  for (const e of events) {
    if (!e.event.startsWith("tool:")) continue;
    expect(e.payload.turnId).toBe("t1");
    expect(e.payload.sessionId).toBe("s1");
  }
  off();
});
```

- [ ] **Step 2: Run, see fail**

```bash
cd plugins/llm-tools-registry && bun test
```

- [ ] **Step 3: Update `ToolExecutionContext` and `invoke()` to propagate**

`plugins/llm-tools-registry/registry.ts`:

```ts
export interface ToolExecutionContext {
  signal: AbortSignal;
  callId: string;
  turnId?: string;
  sessionId?: string;
  log: (msg: string) => void;
}
```

In `invoke()`, the four `emit("tool:...", ...)` calls must now include `turnId: ctx.turnId` and `sessionId: ctx.sessionId` in their payload. Update each emit site (lines around 101, 106, 110, 116, 120, 124 of the current `registry.ts`):

```ts
await emit("tool:before-execute", { name, args, callId: ctx.callId, turnId: ctx.turnId, sessionId: ctx.sessionId });
// ...
await emit("tool:execute", { name, args: beforePayload.args, callId: ctx.callId, turnId: ctx.turnId, sessionId: ctx.sessionId });
// ...
await emit("tool:result", { name, callId: ctx.callId, result, turnId: ctx.turnId, sessionId: ctx.sessionId });
// ...
await emit("tool:error", { name, callId: ctx.callId, message, turnId: ctx.turnId, sessionId: ctx.sessionId, /* ...optional cause/cause */ });
```

Also update the unknown-tool error and the cancelled-by-subscriber error paths to include `turnId`/`sessionId`.

The mutable `beforePayload` object should also carry `turnId`/`sessionId` so subscribers see them; redefine the type:

```ts
const beforePayload: { name: string; args: unknown; callId: string; turnId?: string; sessionId?: string } = {
  name, args, callId: ctx.callId, turnId: ctx.turnId, sessionId: ctx.sessionId,
};
```

- [ ] **Step 4: Run, see pass**

```bash
cd plugins/llm-tools-registry && bun test
```

Expected: PASS.

- [ ] **Step 5: Update `llm-events/public.d.ts` `ToolExecutionContext` to mirror**

`plugins/llm-events/public.d.ts:133-144`:

```ts
export interface ToolExecutionContext {
  signal: AbortSignal;
  callId: string;
  turnId?: string;
  sessionId?: string;
  log: (msg: string) => void;
}
```

- [ ] **Step 6: Run llm-events tests**

```bash
cd plugins/llm-events && bun test
```

Expected: PASS (the structural type probe accepts the additive field).

- [ ] **Step 7: Commit**

```bash
git add plugins/llm-tools-registry/ plugins/llm-events/public.d.ts
git commit -m "feat(llm-tools-registry,llm-events): ToolExecutionContext gains optional sessionId; registry propagates turnId/sessionId on tool:* events"
```

### Task 3.2: Bump `llm-tools-registry` version + local deploy

- [ ] **Step 1: Bump version**

Bump minor in `plugins/llm-tools-registry/package.json` (additive contract change).

- [ ] **Step 2: Deploy**

```bash
mkdir -p ~/.kaizen/marketplaces/official/plugins/llm-tools-registry@<NEW_VERSION>
cp -R plugins/llm-tools-registry/. ~/.kaizen/marketplaces/official/plugins/llm-tools-registry@<NEW_VERSION>/
(cd ~/.kaizen/marketplaces/official/plugins/llm-tools-registry@<NEW_VERSION> \
  && bun build --target=bun --outfile=dist/index.js index.ts)
```

- [ ] **Step 3: Commit version bump**

```bash
git add plugins/llm-tools-registry/package.json
git commit -m "chore(llm-tools-registry): bump version for sessionId addition"
```

---

# Phase 4: Tool dispatch strategies thread `turnId`/`sessionId`

Both `llm-native-dispatch` and `llm-codemode-dispatch` implement `ToolDispatchStrategy.handleResponse()`. The contract gains required `turnId` and `sessionId` parameters; both must be threaded into `registry.invoke(ctx)` calls. The strategies' own emitted events (`codemode:*` for codemode, none beyond what registry emits for native) also need to carry `turnId`/`sessionId`.

### Task 4.1: Update `ToolDispatchStrategy` contract in `llm-events/public.d.ts`

**Files:**
- Modify: `plugins/llm-events/public.d.ts:166-189`

- [ ] **Step 1: Update interface**

Replace the existing `ToolDispatchStrategy.handleResponse` signature with:

```ts
export interface ToolDispatchStrategy {
  prepareRequest(input: { availableTools: ToolSchema[] }): { tools?: ToolSchema[]; systemPromptAppend?: string };

  handleResponse(input: {
    response: LLMResponse;
    registry: ToolsRegistryService;
    signal: AbortSignal;
    emit: (event: string, payload: unknown) => Promise<void>;
    turnId: string;
    sessionId: string;
  }): Promise<ChatMessage[]>;
}
```

- [ ] **Step 2: Run llm-events tests**

```bash
cd plugins/llm-events && bun test
```

Expected: PASS (structural probes accept the new shape).

- [ ] **Step 3: Commit**

```bash
git add plugins/llm-events/public.d.ts
git commit -m "feat(llm-events): ToolDispatchStrategy.handleResponse gains turnId/sessionId"
```

### Task 4.2: Update `llm-native-dispatch.handleResponse` to thread ids

**Files:**
- Modify: `plugins/llm-native-dispatch/strategy.ts`
- Modify: `plugins/llm-native-dispatch/test/*` as needed

- [ ] **Step 1: Read current implementation**

```bash
cd plugins/llm-native-dispatch && cat strategy.ts
```

Identify every `registry.invoke(name, args, ctx)` call site and the construction of `ctx` for each.

- [ ] **Step 2: Add the test**

In a relevant test file under `plugins/llm-native-dispatch/test/`, add or extend a test asserting that `handleResponse({ ..., turnId: "t1", sessionId: "s1" })` causes every `registry.invoke` it makes to receive a `ToolExecutionContext` with `turnId === "t1"` and `sessionId === "s1"`.

Use a fake registry that captures the `ctx` passed to `invoke`:

```ts
const calls: Array<{ name: string; args: unknown; ctx: any }> = [];
const fakeReg: ToolsRegistryService = {
  register: () => () => {},
  list: () => [],
  invoke: async (name, args, ctx) => { calls.push({ name, args, ctx }); return "ok"; },
} as any;
// ... call strategy.handleResponse({ ... turnId: "t1", sessionId: "s1" })
expect(calls.every((c) => c.ctx.turnId === "t1" && c.ctx.sessionId === "s1")).toBe(true);
```

- [ ] **Step 3: Run, see fail**

```bash
cd plugins/llm-native-dispatch && bun test
```

- [ ] **Step 4: Modify `strategy.ts`**

Update the function signature of `handleResponse` to accept `turnId` and `sessionId`. Find every call to `registry.invoke(...)` inside; ensure the `ToolExecutionContext` passed includes `turnId` and `sessionId`.

The pattern (where `ctx` is constructed for invoke):

```ts
const toolCtx: ToolExecutionContext = {
  signal,
  callId: tc.id,
  turnId,           // NEW
  sessionId,        // NEW
  log: (m: string) => emit("log", { m }), // or whatever existing log shape
};
const result = await registry.invoke(tc.name, tc.arguments, toolCtx);
```

- [ ] **Step 5: Run, see pass**

```bash
cd plugins/llm-native-dispatch && bun test
```

- [ ] **Step 6: Bump version + commit**

```bash
# bump minor in plugins/llm-native-dispatch/package.json
git add plugins/llm-native-dispatch/
git commit -m "feat(llm-native-dispatch): handleResponse threads turnId/sessionId into ToolExecutionContext"
```

- [ ] **Step 7: Local deploy**

```bash
mkdir -p ~/.kaizen/marketplaces/official/plugins/llm-native-dispatch@<NEW_VERSION>
cp -R plugins/llm-native-dispatch/. ~/.kaizen/marketplaces/official/plugins/llm-native-dispatch@<NEW_VERSION>/
(cd ~/.kaizen/marketplaces/official/plugins/llm-native-dispatch@<NEW_VERSION> \
  && bun build --target=bun --outfile=dist/index.js index.ts)
```

### Task 4.3: Update `llm-codemode-dispatch.handleResponse`

**Files:**
- Modify: `plugins/llm-codemode-dispatch/handle-response.ts`
- Modify: `plugins/llm-codemode-dispatch/sandbox-host.ts` if it constructs `ToolExecutionContext`s
- Modify: `plugins/llm-codemode-dispatch/test/*`

- [ ] **Step 1: Read current implementation**

```bash
cd plugins/llm-codemode-dispatch && wc -l *.ts
cat handle-response.ts
```

Note: codemode dispatch runs LLM-emitted TS in a sandbox; the sandbox calls registry.invoke per tool. Both the sandbox host and the dispatch wrapper must thread ids.

Also identify codemode-specific event emissions (`codemode:code-emitted`, `codemode:before-execute`, `codemode:result`, `codemode:error`) — those payloads need `turnId` and `sessionId` added too.

- [ ] **Step 2: Add the test**

A test in `plugins/llm-codemode-dispatch/test/` asserting:
- `handleResponse({ ..., turnId: "t1", sessionId: "s1" })` produces `codemode:code-emitted`, `codemode:before-execute`, `codemode:result` events whose payloads include `turnId === "t1"` and `sessionId === "s1"`.
- Tool calls made from within the sandbox receive a `ToolExecutionContext` with the same ids.

Mirror the fake-registry pattern from Task 4.2. For codemode events, capture via the `emit` injected to `handleResponse`.

- [ ] **Step 3: Run, see fail**

```bash
cd plugins/llm-codemode-dispatch && bun test
```

- [ ] **Step 4: Implement**

In `handle-response.ts`, accept `turnId` and `sessionId` in the input. Pass them to the sandbox host. In every `emit("codemode:*", payload)` call, add `turnId` and `sessionId` to the payload. In the sandbox-host's `registry.invoke()` ctx construction, add `turnId` and `sessionId`.

If the codemode-cancellation event `codemode:before-execute` carries an existing mutable `code` field, retain that — just add the two id fields alongside.

- [ ] **Step 5: Run, see pass**

```bash
cd plugins/llm-codemode-dispatch && bun test
```

- [ ] **Step 6: Bump + commit + deploy**

```bash
# bump minor in package.json
git add plugins/llm-codemode-dispatch/
git commit -m "feat(llm-codemode-dispatch): handleResponse threads turnId/sessionId into tool ctx and codemode:* events"

mkdir -p ~/.kaizen/marketplaces/official/plugins/llm-codemode-dispatch@<NEW_VERSION>
cp -R plugins/llm-codemode-dispatch/. ~/.kaizen/marketplaces/official/plugins/llm-codemode-dispatch@<NEW_VERSION>/
(cd ~/.kaizen/marketplaces/official/plugins/llm-codemode-dispatch@<NEW_VERSION> \
  && bun build --target=bun --outfile=dist/index.js index.ts)
```

---

# Phase 5: `llm-driver` refactor

The biggest single-plugin change. Removes `state.messages`, gains `activeSessionId`, consumes `sessions:store`, rewrites `runConversation` with discriminated-union input.

### Task 5.1: Update `RunConversationInput`/`Output` in `llm-events/public.d.ts`

**Files:**
- Modify: `plugins/llm-events/public.d.ts:193-210`

- [ ] **Step 1: Replace the existing shapes**

```ts
// Keep structurally identical to llm-session-manager/public TurnHandle.
// Do not import from llm-session-manager here: llm-events must stay dependency-rooted.
export interface TurnHandle {
  readonly turnId: string;
  append(msg: ChatMessage): void;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export type RunConversationInput = {
  systemPrompt: string;
  sessionId: string;
  toolFilter?: { tags?: string[]; names?: string[] };
  model?: string;
  parentTurnId?: string;
  signal?: AbortSignal;
  trigger?: "user" | "agent";
} & (
  | {
      externalTurnId: string;
      turnHandle: TurnHandle;
      userMessage?: never;
    }
  | {
      userMessage: ChatMessage;
      externalTurnId?: never;
      turnHandle?: never;
    }
);

export interface RunConversationOutput {
  finalMessage: ChatMessage;
  usage: { promptTokens: number; completionTokens: number };
}

export interface DriverService {
  runConversation(input: RunConversationInput): Promise<RunConversationOutput>;
}
```

Do not add an `llm-session-manager` dependency to `llm-events`. `llm-events` is the dependency root for cross-plugin types; importing from the session manager would create a circular dependency. The session-manager's `store.ts` keeps its own `TurnHandle` definition; the two must remain identical. Add a comment in both files pointing to the other.

- [ ] **Step 2: Run llm-events tests**

```bash
cd plugins/llm-events && bun test
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add plugins/llm-events/public.d.ts
git commit -m "feat(llm-events): RunConversationInput discriminated-union; add TurnHandle type"
```

### Task 5.2: Update `llm-driver/loop.ts` for new input shape

**Files:**
- Modify: `plugins/llm-driver/loop.ts`
- Modify: `plugins/llm-driver/public.d.ts`
- Modify: `plugins/llm-driver/test/*`

This is the heart of the driver refactor. The loop must:
- Accept either `{ externalTurnId, turnHandle }` OR `{ userMessage }` — two ownership modes.
- In owned-turn mode: mint `turnId`, call `sessions.beginTurn(sessionId, turnId)`, append the userMessage, emit `conversation:user-message`, emit `turn:start`, run the loop, commit/rollback/end.
- In existing-turn mode: caller did all that; loop just runs and emits `llm:*`/`tool:*` events with `turnId`/`sessionId` populated.
- Read messages via `sessions.getMessages(sessionId)` before each LLM call.
- Append new messages via `turnHandle.append()` (the active handle, whether caller-supplied or owned).
- Drop `RunConversationOutput.messages`.

- [ ] **Step 1: Update `RunConversationDeps` in `loop.ts`**

Add `sessions: SessionsStoreService` to the deps interface. Update `buildDeps()` in `index.ts` to include it (next task).

- [ ] **Step 2: Update tests in `plugins/llm-driver/test/integration.test.ts` and `system-prompt-integration.test.ts`**

Inject a fake `sessions:store` via deps. Build a test helper:

```ts
// in test/helpers.ts (new file or add to existing helpers)
export function makeFakeSessions() {
  const sessions = new Map<string, { messages: ChatMessage[] }>();
  const openTurns = new Map<string, ChatMessage[]>();
  return {
    fake: {
      async create() { const id = `s-${sessions.size + 1}`; sessions.set(id, { messages: [] }); return { id, /* ... */ } as any; },
      async load(id: string) { return { id } as any; },
      async exists(id: string) { return sessions.has(id); },
      async getMessages(id: string) {
        const base = sessions.get(id)?.messages ?? [];
        return [...base, ...(openTurns.get(id) ?? [])];
      },
      beginTurn(id: string, turnId: string) {
        if (openTurns.has(id)) throw new Error("already open");
        const buffered: ChatMessage[] = [];
        openTurns.set(id, buffered);
        return {
          turnId,
          append: (m: ChatMessage) => buffered.push(m),
          commit: async () => {
            const sess = sessions.get(id)!;
            sess.messages.push(...buffered);
            openTurns.delete(id);
          },
          rollback: async () => { openTurns.delete(id); },
        };
      },
      // …other methods stub
    } as SessionsStoreService,
    sessions,
  };
}
```

Update existing tests so any place that currently builds `runConversation` input with `messages: [...]` either:
- Uses the existing-turn mode (driver path) — pre-create a session, beginTurn, append userMessage, then call runConversation with `{ sessionId, externalTurnId, turnHandle }`, OR
- Uses owned-turn mode — pre-create a session, then call runConversation with `{ sessionId, userMessage }`.

Each test case tells you which.

Add new tests:
- "owned-turn mode: runConversation appends userMessage to session before LLM call"
- "owned-turn mode: emits conversation:user-message and turn:start"
- "existing-turn mode: does not emit turn:start (caller owns)"
- "every emitted llm:request payload includes turnId and sessionId"
- "every emitted tool:execute payload includes turnId and sessionId"

- [ ] **Step 3: Run, see fail**

```bash
cd plugins/llm-driver && bun test
```

- [ ] **Step 4: Implement loop changes**

In `loop.ts`:
1. Discriminate input: if `externalTurnId` is set → existing-turn mode; else → owned-turn mode.
2. In owned-turn mode, mint a turn id (`deps.idGen()`), open `deps.sessions.beginTurn(sessionId, turnId)`, `handle.append(userMessage)`, emit `conversation:user-message`, emit `turn:start`. The loop owns `commit/rollback`.
3. Replace any `messages: ChatMessage[]` parameter use with `await deps.sessions.getMessages(sessionId)`.
4. Append new messages (assistant content/tool_calls; tool result messages from `handleResponse`) via `handle.append()`.
5. Pass `turnId` and `sessionId` to `strategy.handleResponse({ ..., turnId, sessionId })`.
6. Add `turnId` and `sessionId` to every `emit("llm:*", payload)` and `emit("turn:*", payload)` payload.
7. On owned-turn mode terminal/abort/error: call `handle.commit()` or `handle.rollback()` and emit appropriate `turn:end`.
8. Drop `RunConversationOutput.messages`. Build `finalMessage` from the last appended assistant message (read it from `await deps.sessions.getMessages(sessionId)`).

Be especially careful that the existing "first LLM call inline + multi-step loop" structure (per the existing `loop.ts` per its CLAUDE.md) preserves its behavior, just routed through the handle.

- [ ] **Step 5: Run, see pass**

```bash
cd plugins/llm-driver && bun test
```

- [ ] **Step 6: Commit**

```bash
git add plugins/llm-driver/loop.ts plugins/llm-driver/public.d.ts plugins/llm-driver/test/
git commit -m "refactor(llm-driver): runConversation reads/writes messages through sessions:store; emits turnId/sessionId"
```

### Task 5.3: Update `llm-driver/index.ts` (state, lifecycle, REPL)

**Files:**
- Modify: `plugins/llm-driver/index.ts`
- Modify: `plugins/llm-driver/cancel.ts` if needed

Changes:
- Replace `messages: ChatMessage[]` in plugin-scope state with `activeSessionId: string | null`.
- Subscribe to `session:active-changed { from, to }` and update `state.activeSessionId`.
- `setup()` consumes `sessions:store` (required, throws if missing).
- `start()`:
  - On entry, if `state.activeSessionId == null`, call `sessions.create({})`, set `activeSessionId`, emit `session:active-changed { from: null, to: id }`.
  - Emit `harness:start` (rename from `session:start`).
  - In the loop body: replace the `state.messages` read/append/preTurnSnapshot machinery with `sessions.beginTurn(state.activeSessionId, turnId)` + `handle.append(userMessage)` + `handle.commit()/rollback()`.
  - Pass `sessionId: state.activeSessionId` and `externalTurnId: turnId` and `turnHandle: handle` into `runConversation` (existing-turn mode).
  - Emit `harness:end` on exit.
- Drop `conversation:cleared` driver-side message-wipe behavior; the driver may still subscribe but only as a status reset (no-op for state).
- Update `buildDeps()` to inject `sessions: ctx.useService<SessionsStoreService>("sessions:store")!`.

- [ ] **Step 1: Update tests**

In `plugins/llm-driver/test/integration.test.ts` (or wherever the start-loop is exercised), add assertions:
- `harness:start` is emitted (not `session:start`).
- Initial session is created on first `start()` invocation.
- After `/clear` (or whatever emits `session:active-changed`), `state.activeSessionId` is the new id and the driver doesn't try to read messages from the old one.
- Cancel-rollback test now asserts `TurnHandle.rollback()` was called instead of `state.messages` reverted.

- [ ] **Step 2: Run, see fail**

```bash
cd plugins/llm-driver && bun test
```

- [ ] **Step 3: Implement `index.ts` changes**

Walk through the existing `index.ts` (already read in the brainstorm) and apply the changes outlined above. Reference points in current code (per the file as-is):
- `state.messages` declaration → replace with `activeSessionId: string | null`.
- `ctx.on("conversation:cleared", ...)` → keep subscription but make body a no-op/status reset only. Per spec, slash commands emit `session:active-changed`; the driver subscribes and must not also emit it for `/clear`.
- `ctx.emit("session:start")` → `ctx.emit("harness:start")`.
- `ctx.emit("session:end")` → `ctx.emit("harness:end")`.
- `ctx.emit("session:error", ...)` → `ctx.emit("harness:error", ...)`.
- The `preTurnSnapshot` + push/restore logic in the user-input branch → replace with `beginTurn` / `append(userMsg)` / `commit()` / `rollback()`.
- `buildDeps()` → add `sessions`.

- [ ] **Step 4: Run, see pass + commit**

```bash
cd plugins/llm-driver && bun test
git add plugins/llm-driver/
git commit -m "refactor(llm-driver): drop state.messages; gain activeSessionId via sessions:store; rename session:* REPL events to harness:*"
```

### Task 5.4: Bump driver version + local deploy

- [ ] **Step 1: Bump minor in `plugins/llm-driver/package.json`** (major behavioral change).

- [ ] **Step 2: Local deploy** per the `llm-driver/CLAUDE.md` stanza.

- [ ] **Step 3: Commit version bump**

```bash
git add plugins/llm-driver/package.json
git commit -m "chore(llm-driver): bump version for sessions:store consumption"
```

---

# Phase 6: `llm-agents` refactor

`dispatch_agent` reads `ctx.sessionId`/`turnId`, creates or loads the sub-session, and calls `runConversation` in **owned-turn mode** with `userMessage`.

### Task 6.1: Update `dispatch.ts`

**Files:**
- Modify: `plugins/llm-agents/dispatch.ts`
- Modify: `plugins/llm-agents/test/*`
- Modify: `plugins/llm-agents/index.ts` to consume `sessions:store` and pass into `makeDispatchTool`

- [ ] **Step 1: Update tests**

In `plugins/llm-agents/test/dispatch.test.ts` (or whichever test exercises dispatch), add new tests:

```ts
test("dispatch_agent: throws if ctx.sessionId is missing", async () => {
  const tool = makeDispatchTool({
    registry: registryStub,
    tracker: trackerStub,
    driver: driverStub,
    sessions: sessionsStub,
    maxDepth: 5,
    hasSkills: () => false,
  });
  await expect(
    tool.handler({ agent_name: "x", prompt: "hi" }, { signal: new AbortController().signal, callId: "c", turnId: "t1", log: () => {} } as any),
  ).rejects.toThrow(/sessionId/i);
});

test("dispatch_agent: throws if ctx.turnId is missing", async () => { /* similar */ });

test("dispatch_agent: invalid session_id is rejected", async () => {
  // Pass session_id: "a/b" — fails the childId regex.
});

test("dispatch_agent: same session_id → reuses session, second call sees first messages", async () => {
  // Set up: dispatch with session_id: "k". Inside, the fake driver records the messages length seen.
  // First call: 1 user message. Second call (same session_id): N+1 messages now (prev assistant reply + new user).
});

test("dispatch_agent: omitted session_id creates a oneshot-* sub-session", async () => {
  // Verify sessions.create was called with childId starting "oneshot-".
});

test("dispatch_agent: existing session_id with different agent_name throws", async () => {
  // Pre-create session with agentName: "A". Dispatch with agent_name: "B" and same session_id → reject.
});
```

Use stub sessions / driver / registry per existing patterns; mirror the agent's existing test fixtures.

- [ ] **Step 2: Run, see fail**

```bash
cd plugins/llm-agents && bun test
```

- [ ] **Step 3: Implement handler changes**

`plugins/llm-agents/dispatch.ts` — update `DispatchDeps`:

```ts
export interface DispatchDeps {
  registry: RegistryHandle;
  tracker: TurnTracker;
  driver: Pick<DriverService, "runConversation">;
  sessions: SessionsStoreService;
  maxDepth: number;
  hasSkills: () => boolean;
}
```

Update the handler:

```ts
const handler: ToolHandler = async (rawArgs: unknown, ctx: ToolExecutionContext) => {
  const args = rawArgs as { agent_name?: unknown; prompt?: unknown; session_id?: unknown };
  if (typeof args?.agent_name !== "string" || typeof args?.prompt !== "string") {
    throw new Error("dispatch_agent: 'agent_name' and 'prompt' must be strings");
  }
  if (args.session_id !== undefined && typeof args.session_id !== "string") {
    throw new Error("dispatch_agent: 'session_id' must be a string when provided");
  }
  const name = args.agent_name;
  const internal = deps.registry.getInternal(name);
  if (!internal) {
    const known = deps.registry.service.list().map((a) => a.name).join(", ");
    throw new Error(`Unknown agent '${name}'. Known: ${known}`);
  }

  const turnId = ctx.turnId;
  if (!turnId) throw new Error("dispatch_agent: ToolExecutionContext.turnId missing; required for depth tracking");
  const parentSessionId = ctx.sessionId;
  if (!parentSessionId) throw new Error("dispatch_agent: ToolExecutionContext.sessionId missing");

  const depth = computeDepth(deps.tracker.records, turnId);
  if (depth >= deps.maxDepth) throw new Error(`Agent dispatch depth limit reached (max=${deps.maxDepth})`);

  const childId = (typeof args.session_id === "string" ? args.session_id : `oneshot-${shortUuid()}`);
  if (!/^[A-Za-z0-9_.-]+$/.test(childId)) {
    throw new Error(`dispatch_agent: session_id must match ^[A-Za-z0-9_.-]+$ (got ${JSON.stringify(childId)})`);
  }
  const fullId = `${parentSessionId}/${childId}`;

  let session;
  if (await deps.sessions.exists(fullId)) {
    session = await deps.sessions.load(fullId);
    if (session.agentName !== name) {
      throw new Error(`session_id '${childId}' already exists under a different agent ('${session.agentName}')`);
    }
  } else {
    session = await deps.sessions.create({
      parentSessionId,
      childId,
      agentName: name,
      model: internal.modelOverride,
    });
  }

  const manifestNames = internal.toolFilter?.names ?? [];
  const manifestTags = internal.toolFilter?.tags ?? [];
  const alwaysOn: string[] = ["dispatch_agent"];
  if (deps.hasSkills()) alwaysOn.push("load_skill");
  const mergedNames = Array.from(new Set([...manifestNames, ...alwaysOn]));
  const toolFilter = { names: mergedNames, tags: manifestTags };

  const input: RunConversationInput = {
    systemPrompt: internal.systemPrompt,
    sessionId: session.id,
    toolFilter,
    ...(internal.modelOverride ? { model: internal.modelOverride } : {}),
    parentTurnId: turnId,
    signal: ctx.signal,
    userMessage: { role: "user", content: args.prompt },
  };

  const emit = (ctx as any).emit as ((e: string, p: unknown) => Promise<void>) | undefined;
  try {
    await emit?.("status:item-update", { key: "agents.active", value: name });
    let output;
    try {
      output = await deps.driver.runConversation(input);
    } catch (err: any) {
      if (err?.name === "AbortError" || ctx.signal.aborted) throw new Error(`Agent '${name}' cancelled`);
      throw new Error(`Agent '${name}' failed: ${err?.message ?? String(err)}`);
    }
    return String(output.finalMessage.content ?? "");
  } finally {
    await emit?.("status:item-clear", { key: "agents.active" });
  }
};
```

Add a small `shortUuid()` helper at the top of the file:

```ts
import { randomUUID } from "node:crypto";

function shortUuid(): string {
  // 8 hex chars from crypto.randomUUID without dashes; enough entropy for one-shot ids.
  return randomUUID().replace(/-/g, "").slice(0, 8);
}
```

Update the schema:

```ts
export const DISPATCH_SCHEMA: ToolSchema = {
  name: "dispatch_agent",
  description:
    "Delegate a sub-task to a named specialist agent. Returns the agent's final response as a string. " +
    "Use `session_id` to continue an existing sub-agent thread or start a fresh one.",
  parameters: {
    type: "object",
    required: ["agent_name", "prompt"],
    properties: {
      agent_name: { type: "string", description: "One of the names listed under 'Available agents' in the system prompt." },
      prompt: { type: "string", description: "The instruction to send to the agent as its only user message." },
      session_id: {
        type: "string",
        description:
          "Optional. Short label (^[A-Za-z0-9_.-]+$) identifying a sub-agent thread under the current session. " +
          "Reusing the same session_id continues the same sub-agent's history; a new session_id starts a fresh thread.",
      },
    },
    additionalProperties: false,
  } as any,
  tags: ["agents", "core"],
};
```

- [ ] **Step 4: Wire `sessions:store` consumption in `index.ts`**

`plugins/llm-agents/index.ts`:
- Add `"sessions:store"` to `services.consumes`.
- In `setup()`, call `ctx.consumeService("sessions:store")`.
- In the `makeDispatchTool({ ... })` call, pass `sessions: ctx.useService<SessionsStoreService>("sessions:store")!`. (Resolution may need to happen lazily — check the existing `safeUse<T>` pattern in `llm-driver/index.ts` and apply the same here.)

- [ ] **Step 5: Run, see pass**

```bash
cd plugins/llm-agents && bun test
```

- [ ] **Step 6: Commit + bump + deploy**

```bash
# bump minor in plugins/llm-agents/package.json
git add plugins/llm-agents/
git commit -m "feat(llm-agents): dispatch_agent gains session_id; persistent sub-agent histories via sessions:store"

mkdir -p ~/.kaizen/marketplaces/official/plugins/llm-agents@<NEW_VERSION>
cp -R plugins/llm-agents/. ~/.kaizen/marketplaces/official/plugins/llm-agents@<NEW_VERSION>/
(cd ~/.kaizen/marketplaces/official/plugins/llm-agents@<NEW_VERSION> \
  && bun build --target=bun --outfile=dist/index.js index.ts)
```

---

# Phase 7: `llm-slash-commands` — `/session:*` and `/clear` archival

### Task 7.1: Add `/session:new`, `/session:list`, `/session:resume`, `/session:delete`

**Files:**
- Modify: `plugins/llm-slash-commands/builtins.ts` (or wherever built-in commands are defined)
- Modify: `plugins/llm-slash-commands/index.ts` to consume `sessions:store`
- Modify: `plugins/llm-slash-commands/test/*`

Important: `llm-slash-commands` must mirror the driver's active session id. It does this by registering a setup-time `ctx.on("session:active-changed", ...)` listener and storing the latest `to` value in module/plugin state. The driver remains the UX owner of active state; slash commands only keep a mirror so they can compute `{ from, to }` payloads and active-delete behavior.

- [ ] **Step 1: Read existing builtin pattern**

```bash
cat plugins/llm-slash-commands/builtins.ts plugins/llm-slash-commands/CLAUDE.md
```

Identify how a built-in command is registered (manifest + handler). Then mirror.

- [ ] **Step 2: Add tests**

For each command:

```ts
test("/session:new emits session:active-changed and creates a new session", async () => {
  // Precondition: active session "old". After /session:new: active is the new id; session:active-changed { from: "old", to: <new> } emitted.
});

test("session commands mirror active session from session:active-changed", async () => {
  // Emit session:active-changed { from: null, to: "s1" }; then /session:new should use from: "s1".
});

test("/session:list shows top-level sessions only by default", async () => {
  // Three sessions including a sub-session; output lists 2 top-level ids.
});

test("/session:list --all includes sub-sessions", async () => { /* ... */ });

test("/session:resume <id> sets active and emits session:active-changed and session:resumed", async () => {});

test("/session:resume <unknown> errors", async () => {});

test("/session:delete <id> deletes inactive session, leaves activeSessionId unchanged", async () => {});

test("/session:delete <activeId> creates replacement, deletes target, emits session:active-changed only on success", async () => {});

test("/session:delete <id> without --cascade rejects when children exist", async () => {});
```

- [ ] **Step 3: Run, see fail**

```bash
cd plugins/llm-slash-commands && bun test
```

- [ ] **Step 4: Implement commands**

In `builtins.ts` (or new file `session-commands.ts` and import from index), register four commands and one updated `/clear`. For each, the handler:
1. Calls into `sessions:store` (resolved via the deps captured at register time).
2. Reads the mirrored `activeSessionId` captured from `session:active-changed`; if a command that needs an active session runs before one is known, print a clear error and do not create/delete anything.
3. Emits `session:active-changed { from, to }` for new/resume/clear/delete-of-active.
4. For `/clear`: also emit `conversation:cleared { from, to }`.
5. For `/session:delete`:
   - Preflight: check children (call `sessions.list({ parentSessionId: id })` or read from `list({ includeChildren: true })` filtered by parentSessionId).
   - If active: create replacement, attempt `sessions.delete(id, { cascade })`, emit `session:active-changed` only on success. On delete failure: best-effort `sessions.delete(replacement.id)`; if cleanup fails, log and surface the original error.

Resolve `sessions:store` either at registration time (deps closure) or in `setup()` and pass to register. In `index.ts`, add `"sessions:store"` to `services.consumes`, call `ctx.consumeService("sessions:store")`, and register the `session:active-changed` listener before command handlers can run.

- [ ] **Step 5: Run, see pass + commit**

```bash
cd plugins/llm-slash-commands && bun test
git add plugins/llm-slash-commands/
git commit -m "feat(llm-slash-commands): /session:* commands and archival /clear"
```

### Task 7.2: Bump version + local deploy

- [ ] Bump minor in `plugins/llm-slash-commands/package.json`.
- [ ] Local deploy per CLAUDE.md.
- [ ] Commit version bump.

---

# Phase 8: `llm-status-items` and other event-name consumer renames

Goal: rename any subscriber to `session:start/end/error/exit-requested` to use `harness:*`.

### Task 8.1: `llm-status-items` rename

**Files:**
- Modify: `plugins/llm-status-items/index.ts` (and any other file with subscriptions)
- Modify: `plugins/llm-status-items/test/*`

- [ ] **Step 1: Find subscriptions**

```bash
grep -n '"session:start"\|"session:end"\|"session:error"\|"session:exit-requested"' plugins/llm-status-items/*.ts
```

- [ ] **Step 2: Add a test asserting the new event names are subscribed**

A simple hand-rolled test:

```ts
test("subscribes to harness:start/end (not session:*)", async () => {
  const ctx = makeCtx(); // captures ctx.on() calls
  await plugin.setup!(ctx as any);
  expect(ctx.subscribedEvents).toContain("harness:start");
  expect(ctx.subscribedEvents).not.toContain("session:start");
});
```

- [ ] **Step 3: Run, see fail**

- [ ] **Step 4: Replace `session:start` etc with `harness:start` etc**

Mechanical sed-equivalent on the subscriber strings.

- [ ] **Step 5: Run, see pass + commit**

```bash
cd plugins/llm-status-items && bun test
git add plugins/llm-status-items/
git commit -m "refactor(llm-status-items): subscribe to harness:* (renamed from session:*)"
```

### Task 8.2: Audit other plugins for stale `session:*` subscribers

- [ ] **Step 1: Repo-wide grep**

```bash
grep -rn '"session:start"\|"session:end"\|"session:error"\|"session:exit-requested"' plugins/
```

For every match outside `llm-events` and the spec/plan files: add a test in that plugin asserting the new event name, update the subscription, run that plugin's tests, commit.

The grep result determines how many additional micro-tasks this becomes. Treat each plugin as its own commit:

```bash
git commit -m "refactor(<plugin>): subscribe to harness:* (renamed)"
```

### Task 8.3: Bump versions for any plugin patched in Phase 8

- [ ] Patch-bump (e.g. `0.1.0` → `0.1.1`) for each modified plugin's `package.json`.
- [ ] Local deploy each.
- [ ] One commit per plugin: `chore(<plugin>): bump version for harness:* listener rename`.

---

# Phase 9: Harness manifest + smoke

### Task 9.1: Add `llm-session-manager` to `harnesses/openai-compatible.json`

**Files:**
- Modify: `harnesses/openai-compatible.json`

- [ ] **Step 1: Read current manifest**

```bash
cat harnesses/openai-compatible.json
```

- [ ] **Step 2: Add the plugin**

Add `"llm-session-manager@0.1.0"` (or the marketplace ref form the manifest already uses for other plugins) to the `plugins` array. Match the existing entry shape — if other plugins are listed as `"official/<name>@<version>"`, follow that.

- [ ] **Step 3: Validate the manifest format**

The harness loader validates this on load — see `kaizen` runtime. For now, eyeball: JSON parses, the new entry follows the same shape as siblings.

- [ ] **Step 4: Commit**

```bash
git add harnesses/openai-compatible.json
git commit -m "feat(harness): add llm-session-manager to openai-compatible harness"
```

### Task 9.2: End-to-end smoke

- [ ] **Step 1: Sync local marketplace**

```bash
# (per any plugin's CLAUDE.md "If you also need the harness manifest to pick up changes" stanza)
# Sync the local marketplace repo so kaizen sees the updated manifest.
```

- [ ] **Step 2: Boot the harness**

```bash
kaizen --harness official/openai-compatible
```

- [ ] **Step 3: Smoke checklist**

In the running harness:
- [ ] Type a message; assistant replies; quit.
- [ ] Verify a snapshot exists at `~/.kaizen/sessions/<harness>/<session-id>/snapshot.json` and `events.jsonl` has at least `turn:start`, `llm:request`, `llm:done`, `turn:end`.
- [ ] Re-launch kaizen.
- [ ] `/session:list` shows the previous session.
- [ ] `/session:resume <id>` restores the conversation; the next assistant reply has prior context.
- [ ] `/session:new` flips active to a fresh session.
- [ ] `/clear` archives the current and creates new (verify both ids appear in `/session:list`).
- [ ] An agent dispatch (if you have a configured agent) creates a sub-session under the parent, with its own `events.jsonl`.
- [ ] `/session:list --all` shows the sub-session.
- [ ] `/session:delete <sub-id>` deletes the sub-session, files removed.
- [ ] `/session:delete <active-id> --cascade` (if active has children) creates replacement and deletes target.
- [ ] No stale `session:start`/`session:end` subscriber warnings in logs.

- [ ] **Step 4: Document any gaps**

If any smoke step reveals a missed integration (e.g., a plugin still listening on `session:start`), file as a follow-up commit referencing this plan.

---

## Rollout summary

After all 9 phases:

- 1 new plugin (`llm-session-manager`) deployed.
- 7 existing plugins updated and re-deployed (`llm-events`, `llm-tools-registry`, `llm-native-dispatch`, `llm-codemode-dispatch`, `llm-driver`, `llm-agents`, `llm-slash-commands`).
- Possibly 1+ patch-only plugins for listener renames (`llm-status-items` and any others surfaced by the grep).
- Harness manifest updated.
- Sessions persist; sub-agents have caller-controlled persistent histories; full execution trace per session.

---

## Self-review notes

A scan of the plan against the spec:

- **Spec coverage** — every spec section mapped to a phase: contract → 2; on-disk layout → 2.5/2.6/2.7/2.8; event log → 2.9 + Phase 4; driver changes → 5; agent dispatch → 6; slash commands → 7; harness key → 2.2; vocab rename → 1; tools registry sessionId → 3; dispatch strategies → 4; testing → embedded TDD throughout, plus integration in 2.12 and smoke in 9.2.
- **Type consistency** — `TurnHandle` is intentionally defined structurally in both `llm-events/public.d.ts` and `llm-session-manager` to keep dependency direction one-way; those definitions MUST stay identical — see notes in Task 5.1. `SessionsStoreService` is defined in `llm-session-manager/store.ts` and re-exported via `llm-session-manager/public.d.ts`.
- **Placeholders** — none of the "TBD/TODO" variety. Two soft elisions remain: (a) Task 4.2 / 4.3 expect the executor to read the current dispatch source before editing rather than inlining the full file here, because both are non-trivial and TDD-driven; (b) Phase 8 asks the executor to grep for stale subscribers and treat each match as a commit. Both are explicit work items, not placeholder text.
- **Plugin fingerprint** — the spec calls for sorted `<name>@<version>` of all loaded plugins recorded per session. Kaizen does not currently expose the loaded plugin set to plugins, so Task 2.11 records a placeholder fingerprint with just `llm-session-manager@0.1.0`. Filing a kaizen issue to expose plugin set, similar to issue #74 for harness identity, is a reasonable follow-up — call it out in the smoke step.
