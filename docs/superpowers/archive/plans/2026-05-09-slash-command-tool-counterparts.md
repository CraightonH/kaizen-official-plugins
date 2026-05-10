# Slash Command Tool Counterparts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move session-related slash built-ins out of `llm-slash-commands` into `llm-session-manager`, then add tool counterparts in both `llm-session-manager` and `llm-mcp-bridge` so the LLM can do everything the human can via these commands.

**Architecture:** Per-plugin pure command core (`commands.ts`) + two thin adapters (`slash.ts`, `tools.ts`) that share it. Slash returns formatted text via `ctx.print`; tools return structured data. Tool name mirrors slash command (e.g. `/session:list` ↔ tool `session:list`). Registration deferred to `harness:start` where consumed registries (`slash:registry`, `tools:registry`) aren't guaranteed at `setup()` time.

**Tech Stack:** TypeScript, Bun (`bun:test`, `bun build`). Existing kaizen plugin API v3.0.0.

**Spec:** `docs/superpowers/specs/2026-05-09-slash-command-tool-counterparts-design.md`

---

## File Structure

**`plugins/llm-session-manager/`**
- Create `commands.ts` — pure command core: `clearSession`, `listSessions`, `resumeSession`, `renameActiveSession`, `deleteSession`. Each takes `{ store, emit, getActiveSessionId }` deps.
- Create `slash.ts` — `registerSlashCommands(slash, commands)`. Free-form string args, formatted output via `ctx.print`.
- Create `tools.ts` — `registerToolCommands(tools, commands)`. JSON-schema args, structured returns.
- Modify `index.ts` — track active session (subscribe `session:active-changed`); on `harness:start`, look up `slash:registry` and `tools:registry`, register both adapters; bump `permissions.events.subscribe` to include `harness:start`, `session:active-changed`.
- Create `test/commands.test.ts`, `test/slash.test.ts`, `test/tools.test.ts`, `test/parity.test.ts`.

**`plugins/llm-slash-commands/`**
- Modify `builtins.ts` — remove `/clear` and `/session:*` registrations and the `BuiltinDeps` fields they need. Keep `/help`, `/exit`, `/history`. Remove unused imports (e.g. `SessionsStoreService`, `SessionRecord`, `resolveSession`, `sessionLine`).
- Modify `index.ts` — drop `consumes: ["sessions:store"]`, drop the `useService("sessions:store")` lookup, drop the `registerBuiltins` deps that were removed. Keep `activeSessionId` tracking (file-loader still needs it).
- Modify `test/builtins.test.ts` — remove tests for the moved commands.
- Modify `test/integration.test.ts` if it covers moved commands.

**`plugins/llm-mcp-bridge/`**
- Create `tools-peers.ts` — `registerToolPeers(tools, bridge, reloadFromDisk)`. Tool peers for `mcp:list`, `mcp:reload`, `mcp:reconnect`, `mcp:disable`. Calls the same `bridge` service the slash adapters call.
- Modify `index.ts` — after the existing `registerSlashCommands` call, also call `registerToolPeers(registry, svc, reloadFromDisk)`. (Both run inside the existing `tools:registry` consumer block, so no `harness:start` deferral needed here.)
- Create `test/tools-peers.test.ts`.

**Deploy** (final task): rebundle the three modified plugins into `~/.kaizen/marketplaces/official/plugins/<name>@<ver>/dist/index.js`.

---

## Task 1: Pure command core in llm-session-manager

**Files:**
- Create: `plugins/llm-session-manager/commands.ts`
- Test: `plugins/llm-session-manager/test/commands.test.ts`

This module contains the shared logic both adapters call. Mocks the store; no real filesystem.

- [ ] **Step 1: Write failing tests for `clearSession`**

Create `plugins/llm-session-manager/test/commands.test.ts`:

```typescript
import { describe, it, expect, mock } from "bun:test";
import { makeCommands } from "../commands.ts";
import type { SessionsStoreService, SessionRecord } from "../store.ts";

function fakeStore(overrides: Partial<SessionsStoreService> = {}): SessionsStoreService {
  return {
    create: mock(async () => ({ id: "new-id", harness: "h", metadata: {}, createdAt: 0, pluginFingerprint: [] } as SessionRecord)),
    load: mock(async () => { throw new Error("not impl"); }),
    exists: mock(async () => false),
    getMessages: mock(async () => []),
    beginTurn: mock(() => ({ turnId: "", append: () => {}, commit: async () => {}, rollback: async () => {} })),
    list: mock(async () => []),
    rename: mock(async (id, alias) => ({ id, alias: alias ?? undefined, harness: "h", metadata: {}, createdAt: 0, pluginFingerprint: [] } as SessionRecord)),
    delete: mock(async () => {}),
    readEvents: mock(() => (async function* () {})()),
    ...overrides,
  };
}

function captureEmit() {
  const calls: Array<{ event: string; payload: any }> = [];
  return {
    calls,
    emit: async (event: string, payload: unknown) => { calls.push({ event, payload: payload as any }); return []; },
  };
}

describe("clearSession", () => {
  it("creates a new session and emits both session:active-changed and conversation:cleared", async () => {
    const store = fakeStore({
      create: mock(async () => ({ id: "sess-2", alias: "happy-otter", harness: "h", metadata: {}, createdAt: 0, pluginFingerprint: [] } as SessionRecord)),
    });
    const bus = captureEmit();
    const cmds = makeCommands({ store, emit: bus.emit, getActiveSessionId: () => "sess-1" });

    const result = await cmds.clearSession();

    expect(result).toEqual({ from: "sess-1", to: "sess-2", alias: "happy-otter" });
    expect(bus.calls).toEqual([
      { event: "session:active-changed", payload: { from: "sess-1", to: "sess-2", alias: "happy-otter" } },
      { event: "conversation:cleared", payload: { from: "sess-1", to: "sess-2" } },
    ]);
  });

  it("handles null active session", async () => {
    const store = fakeStore({
      create: mock(async () => ({ id: "sess-1", harness: "h", metadata: {}, createdAt: 0, pluginFingerprint: [] } as SessionRecord)),
    });
    const bus = captureEmit();
    const cmds = makeCommands({ store, emit: bus.emit, getActiveSessionId: () => null });
    const result = await cmds.clearSession();
    expect(result.from).toBe(null);
    expect(result.alias).toBe(null);
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

```bash
cd plugins/llm-session-manager && bun test test/commands.test.ts
```
Expected: FAIL — `Cannot find module '../commands.ts'`.

- [ ] **Step 3: Write `commands.ts` skeleton with `clearSession` only**

Create `plugins/llm-session-manager/commands.ts`:

```typescript
import type { SessionsStoreService, SessionRecord } from "./store.ts";

export interface CommandsDeps {
  store: SessionsStoreService;
  emit: (event: string, payload: unknown) => Promise<unknown[]>;
  getActiveSessionId: () => string | null;
}

export interface ClearResult {
  from: string | null;
  to: string;
  alias: string | null;
}

export interface CommandsApi {
  clearSession(): Promise<ClearResult>;
}

export function makeCommands(deps: CommandsDeps): CommandsApi {
  async function clearSession(): Promise<ClearResult> {
    const from = deps.getActiveSessionId();
    const next = await deps.store.create({});
    const alias = next.alias ?? null;
    await deps.emit("session:active-changed", { from, to: next.id, alias });
    await deps.emit("conversation:cleared", { from, to: next.id });
    return { from, to: next.id, alias };
  }

  return { clearSession };
}
```

- [ ] **Step 4: Run tests to confirm pass**

```bash
bun test test/commands.test.ts
```
Expected: PASS, 2 tests.

- [ ] **Step 5: Add `listSessions` test + impl**

Append to `test/commands.test.ts`:

```typescript
describe("listSessions", () => {
  it("delegates to store.list with includeChildren", async () => {
    const rows: SessionRecord[] = [{ id: "s1", harness: "h", metadata: {}, createdAt: 0, pluginFingerprint: [] }];
    const store = fakeStore({ list: mock(async () => rows) });
    const cmds = makeCommands({ store, emit: async () => [], getActiveSessionId: () => null });
    const out = await cmds.listSessions({ includeChildren: true });
    expect(out).toBe(rows);
    expect((store.list as any).mock.calls[0][0]).toEqual({ includeChildren: true });
  });

  it("defaults includeChildren to false", async () => {
    const store = fakeStore({ list: mock(async () => []) });
    const cmds = makeCommands({ store, emit: async () => [], getActiveSessionId: () => null });
    await cmds.listSessions({});
    expect((store.list as any).mock.calls[0][0]).toEqual({ includeChildren: false });
  });
});
```

Add to `commands.ts`:

```typescript
// In the CommandsApi interface:
listSessions(opts: { includeChildren?: boolean }): Promise<SessionRecord[]>;

// In makeCommands(), before `return`:
async function listSessions(opts: { includeChildren?: boolean }): Promise<SessionRecord[]> {
  return deps.store.list({ includeChildren: opts.includeChildren ?? false });
}

// And add `listSessions` to the returned object.
```

- [ ] **Step 6: Run tests to confirm pass**

```bash
bun test test/commands.test.ts
```
Expected: PASS, 4 tests.

- [ ] **Step 7: Add `resumeSession` test + impl**

Append to `test/commands.test.ts`:

```typescript
describe("resumeSession", () => {
  it("resolves by id when session exists", async () => {
    const rec: SessionRecord = { id: "s1", alias: "fox", harness: "h", metadata: {}, createdAt: 0, pluginFingerprint: [] };
    const store = fakeStore({
      exists: mock(async (id) => id === "s1"),
      load: mock(async () => rec),
    });
    const bus = captureEmit();
    const cmds = makeCommands({ store, emit: bus.emit, getActiveSessionId: () => "old" });
    const out = await cmds.resumeSession({ id_or_alias: "s1" });
    expect(out).toEqual({ id: "s1", alias: "fox" });
    expect(bus.calls.map((c) => c.event)).toEqual(["session:active-changed", "session:resumed"]);
    expect(bus.calls[0].payload).toEqual({ from: "old", to: "s1", alias: "fox" });
    expect(bus.calls[1].payload).toEqual({ id: "s1" });
  });

  it("resolves by alias when id miss", async () => {
    const rec: SessionRecord = { id: "s2", alias: "owl", harness: "h", metadata: {}, createdAt: 0, pluginFingerprint: [] };
    const store = fakeStore({
      exists: mock(async () => false),
      list: mock(async () => [rec]),
    });
    const cmds = makeCommands({ store, emit: async () => [], getActiveSessionId: () => null });
    const out = await cmds.resumeSession({ id_or_alias: "owl" });
    expect(out).toEqual({ id: "s2", alias: "owl" });
  });

  it("throws when token resolves to nothing", async () => {
    const store = fakeStore({ exists: mock(async () => false), list: mock(async () => []) });
    const cmds = makeCommands({ store, emit: async () => [], getActiveSessionId: () => null });
    await expect(cmds.resumeSession({ id_or_alias: "nope" })).rejects.toThrow(/session not found: nope/);
  });

  it("throws on empty token", async () => {
    const cmds = makeCommands({ store: fakeStore(), emit: async () => [], getActiveSessionId: () => null });
    await expect(cmds.resumeSession({ id_or_alias: "" })).rejects.toThrow(/missing session id/);
  });
});
```

Add to `commands.ts`:

```typescript
// CommandsApi:
resumeSession(opts: { id_or_alias: string }): Promise<{ id: string; alias: string | null }>;

// makeCommands():
async function resumeSession(opts: { id_or_alias: string }): Promise<{ id: string; alias: string | null }> {
  const token = opts.id_or_alias;
  if (!token) throw new Error("missing session id");
  let record: SessionRecord;
  if (await deps.store.exists(token)) {
    record = await deps.store.load(token);
  } else {
    const all = await deps.store.list({ includeChildren: true });
    const match = all.find((r) => r.alias === token);
    if (!match) throw new Error(`session not found: ${token}`);
    record = match;
  }
  const from = deps.getActiveSessionId();
  const alias = record.alias ?? null;
  await deps.emit("session:active-changed", { from, to: record.id, alias });
  await deps.emit("session:resumed", { id: record.id });
  return { id: record.id, alias };
}
```

- [ ] **Step 8: Run tests to confirm pass**

```bash
bun test test/commands.test.ts
```
Expected: PASS.

- [ ] **Step 9: Add `renameActiveSession` test + impl**

Append to `test/commands.test.ts`:

```typescript
describe("renameActiveSession", () => {
  it("renames when active session set", async () => {
    const store = fakeStore({
      rename: mock(async (id, alias) => ({ id, alias: alias!, harness: "h", metadata: {}, createdAt: 0, pluginFingerprint: [] })),
    });
    const cmds = makeCommands({ store, emit: async () => [], getActiveSessionId: () => "active" });
    const out = await cmds.renameActiveSession({ name: "new-name" });
    expect(out).toEqual({ id: "active", alias: "new-name" });
    expect((store.rename as any).mock.calls[0]).toEqual(["active", "new-name"]);
  });

  it("throws when no active session", async () => {
    const cmds = makeCommands({ store: fakeStore(), emit: async () => [], getActiveSessionId: () => null });
    await expect(cmds.renameActiveSession({ name: "x" })).rejects.toThrow(/no active session/i);
  });

  it("throws on empty name", async () => {
    const cmds = makeCommands({ store: fakeStore(), emit: async () => [], getActiveSessionId: () => "active" });
    await expect(cmds.renameActiveSession({ name: "" })).rejects.toThrow(/name is required/i);
  });
});
```

Add to `commands.ts`:

```typescript
renameActiveSession(opts: { name: string }): Promise<{ id: string; alias: string }>;

async function renameActiveSession(opts: { name: string }): Promise<{ id: string; alias: string }> {
  if (!opts.name) throw new Error("name is required");
  const active = deps.getActiveSessionId();
  if (!active) throw new Error("no active session");
  const record = await deps.store.rename(active, opts.name);
  return { id: record.id, alias: record.alias! };
}
```

- [ ] **Step 10: Run tests to confirm pass**

```bash
bun test test/commands.test.ts
```
Expected: PASS.

- [ ] **Step 11: Add `deleteSession` test + impl**

Append to `test/commands.test.ts`:

```typescript
describe("deleteSession", () => {
  it("deletes a non-active session", async () => {
    const store = fakeStore();
    const cmds = makeCommands({ store, emit: async () => [], getActiveSessionId: () => "active" });
    const out = await cmds.deleteSession({ id: "other", cascade: false });
    expect(out).toEqual({ deleted: "other" });
    expect((store.delete as any).mock.calls[0]).toEqual(["other", { cascade: false }]);
  });

  it("requires --cascade when active session has children", async () => {
    const store = fakeStore({
      list: mock(async () => [
        { id: "active", harness: "h", metadata: {}, createdAt: 0, pluginFingerprint: [] },
        { id: "active/child", harness: "h", metadata: {}, createdAt: 0, pluginFingerprint: [] },
      ]),
    });
    const cmds = makeCommands({ store, emit: async () => [], getActiveSessionId: () => "active" });
    await expect(cmds.deleteSession({ id: "active", cascade: false })).rejects.toThrow(/cascade/);
  });

  it("creates a replacement when deleting active session", async () => {
    const newRec: SessionRecord = { id: "replacement", alias: "fresh-cat", harness: "h", metadata: {}, createdAt: 0, pluginFingerprint: [] };
    const store = fakeStore({
      list: mock(async () => [{ id: "active", harness: "h", metadata: {}, createdAt: 0, pluginFingerprint: [] }]),
      create: mock(async () => newRec),
    });
    const bus = captureEmit();
    const cmds = makeCommands({ store, emit: bus.emit, getActiveSessionId: () => "active" });
    const out = await cmds.deleteSession({ id: "active", cascade: false });
    expect(out).toEqual({ deleted: "active", replacement: "replacement" });
    expect(bus.calls[0]).toEqual({ event: "session:active-changed", payload: { from: "active", to: "replacement", alias: "fresh-cat" } });
  });

  it("rolls back replacement if delete throws", async () => {
    const newRec: SessionRecord = { id: "replacement", harness: "h", metadata: {}, createdAt: 0, pluginFingerprint: [] };
    const deleted: string[] = [];
    const store = fakeStore({
      list: mock(async () => [{ id: "active", harness: "h", metadata: {}, createdAt: 0, pluginFingerprint: [] }]),
      create: mock(async () => newRec),
      delete: mock(async (id: string) => {
        deleted.push(id);
        if (id === "active") throw new Error("disk-full");
      }),
    });
    const cmds = makeCommands({ store, emit: async () => [], getActiveSessionId: () => "active" });
    await expect(cmds.deleteSession({ id: "active", cascade: false })).rejects.toThrow(/disk-full/);
    expect(deleted).toEqual(["active", "replacement"]);
  });

  it("throws on missing id", async () => {
    const cmds = makeCommands({ store: fakeStore(), emit: async () => [], getActiveSessionId: () => null });
    await expect(cmds.deleteSession({ id: "", cascade: false })).rejects.toThrow(/missing session id/);
  });
});
```

Add to `commands.ts`:

```typescript
deleteSession(opts: { id: string; cascade?: boolean }): Promise<{ deleted: string; replacement?: string }>;

async function deleteSession(opts: { id: string; cascade?: boolean }): Promise<{ deleted: string; replacement?: string }> {
  if (!opts.id) throw new Error("missing session id");
  const cascade = opts.cascade ?? false;
  const active = deps.getActiveSessionId();
  if (opts.id !== active) {
    await deps.store.delete(opts.id, { cascade });
    return { deleted: opts.id };
  }
  const all = await deps.store.list({ includeChildren: true });
  const hasChildren = all.some((r) => r.id.startsWith(opts.id + "/"));
  if (hasChildren && !cascade) {
    throw new Error(`delete: session '${opts.id}' has children; pass cascade=true`);
  }
  const replacement = await deps.store.create({});
  try {
    await deps.store.delete(opts.id, { cascade });
  } catch (err) {
    try {
      await deps.store.delete(replacement.id, { cascade: true });
    } catch { /* ignore secondary failure */ }
    throw err;
  }
  await deps.emit("session:active-changed", { from: opts.id, to: replacement.id, alias: replacement.alias ?? null });
  return { deleted: opts.id, replacement: replacement.id };
}
```

- [ ] **Step 12: Run tests to confirm pass**

```bash
bun test test/commands.test.ts
```
Expected: PASS.

- [ ] **Step 13: Commit**

```bash
git add plugins/llm-session-manager/commands.ts plugins/llm-session-manager/test/commands.test.ts
git commit -m "feat(session-manager): add command core for slash/tool adapters"
```

---

## Task 2: Slash adapters in llm-session-manager

**Files:**
- Create: `plugins/llm-session-manager/slash.ts`
- Test: `plugins/llm-session-manager/test/slash.test.ts`

- [ ] **Step 1: Write failing tests**

Create `plugins/llm-session-manager/test/slash.test.ts`:

```typescript
import { describe, it, expect, mock } from "bun:test";
import { registerSlashCommands, type SlashRegistryLike } from "../slash.ts";
import type { CommandsApi } from "../commands.ts";

interface RegisteredCommand {
  manifest: { name: string; description: string; usage?: string };
  handler: (ctx: { args: string; print: (t: string) => Promise<void> }) => Promise<void>;
}

function fakeSlash(): { svc: SlashRegistryLike; commands: RegisteredCommand[] } {
  const commands: RegisteredCommand[] = [];
  return {
    commands,
    svc: { register: (manifest, handler) => { commands.push({ manifest, handler }); return () => {}; } },
  };
}

function fakeCommands(overrides: Partial<CommandsApi> = {}): CommandsApi {
  return {
    clearSession: mock(async () => ({ from: null, to: "new", alias: null })),
    listSessions: mock(async () => []),
    resumeSession: mock(async (opts) => ({ id: opts.id_or_alias, alias: null })),
    renameActiveSession: mock(async (opts) => ({ id: "active", alias: opts.name })),
    deleteSession: mock(async (opts) => ({ deleted: opts.id })),
    ...overrides,
  };
}

function captureCtx() {
  const out: string[] = [];
  return { out, make: (args: string) => ({ args, print: async (t: string) => { out.push(t); } }) };
}

describe("session slash commands", () => {
  it("registers exactly /clear, /session:new, /session:list, /session:resume, /session:rename, /session:delete", () => {
    const { svc, commands } = fakeSlash();
    registerSlashCommands(svc, fakeCommands());
    expect(commands.map((c) => c.manifest.name).sort()).toEqual([
      "clear",
      "session:delete",
      "session:list",
      "session:new",
      "session:rename",
      "session:resume",
    ]);
  });

  it("/clear and /session:new both call clearSession and print active session id", async () => {
    const cmds = fakeCommands({
      clearSession: mock(async () => ({ from: "old", to: "new-id", alias: "owl" })),
    });
    const { svc, commands } = fakeSlash();
    registerSlashCommands(svc, cmds);
    const cap = captureCtx();
    for (const name of ["clear", "session:new"]) {
      cap.out.length = 0;
      await commands.find((c) => c.manifest.name === name)!.handler(cap.make(""));
      expect(cap.out[0]).toBe("Active session: new-id");
    }
    expect((cmds.clearSession as any).mock.calls.length).toBe(2);
  });

  it("/session:list passes --all → includeChildren: true", async () => {
    const list = mock(async () => [
      { id: "s1", alias: "owl", harness: "h", metadata: {}, createdAt: 0, pluginFingerprint: [] },
    ]);
    const { svc, commands } = fakeSlash();
    registerSlashCommands(svc, fakeCommands({ listSessions: list as any }));
    const cap = captureCtx();
    await commands.find((c) => c.manifest.name === "session:list")!.handler(cap.make("--all"));
    expect((list as any).mock.calls[0][0]).toEqual({ includeChildren: true });
    expect(cap.out[0]).toContain("s1");
    expect(cap.out[0]).toContain("(owl)");
  });

  it("/session:list prints 'No sessions.' when empty", async () => {
    const { svc, commands } = fakeSlash();
    registerSlashCommands(svc, fakeCommands({ listSessions: mock(async () => []) as any }));
    const cap = captureCtx();
    await commands.find((c) => c.manifest.name === "session:list")!.handler(cap.make(""));
    expect(cap.out[0]).toBe("No sessions.");
  });

  it("/session:resume passes the trimmed arg to resumeSession", async () => {
    const resume = mock(async () => ({ id: "s2", alias: null }));
    const { svc, commands } = fakeSlash();
    registerSlashCommands(svc, fakeCommands({ resumeSession: resume as any }));
    const cap = captureCtx();
    await commands.find((c) => c.manifest.name === "session:resume")!.handler(cap.make("  fox "));
    expect((resume as any).mock.calls[0][0]).toEqual({ id_or_alias: "fox" });
    expect(cap.out[0]).toBe("Active session: s2");
  });

  it("/session:rename prints success and surfaces errors via print", async () => {
    const rename = mock(async () => { throw new Error("alias taken"); });
    const { svc, commands } = fakeSlash();
    registerSlashCommands(svc, fakeCommands({ renameActiveSession: rename as any }));
    const cap = captureCtx();
    await commands.find((c) => c.manifest.name === "session:rename")!.handler(cap.make("dup"));
    expect(cap.out[0]).toBe("Rename failed: alias taken");
  });

  it("/session:rename prints usage when arg missing", async () => {
    const { svc, commands } = fakeSlash();
    registerSlashCommands(svc, fakeCommands());
    const cap = captureCtx();
    await commands.find((c) => c.manifest.name === "session:rename")!.handler(cap.make(""));
    expect(cap.out[0]).toBe("Usage: /session:rename <new-name>");
  });

  it("/session:delete with --cascade", async () => {
    const del = mock(async (opts: any) => ({ deleted: opts.id }));
    const { svc, commands } = fakeSlash();
    registerSlashCommands(svc, fakeCommands({ deleteSession: del as any }));
    const cap = captureCtx();
    await commands.find((c) => c.manifest.name === "session:delete")!.handler(cap.make("foo --cascade"));
    expect((del as any).mock.calls[0][0]).toEqual({ id: "foo", cascade: true });
    expect(cap.out[0]).toBe("Deleted session: foo");
  });

  it("/session:delete prints replacement note when active session", async () => {
    const del = mock(async () => ({ deleted: "active", replacement: "new" }));
    const { svc, commands } = fakeSlash();
    registerSlashCommands(svc, fakeCommands({ deleteSession: del as any }));
    const cap = captureCtx();
    await commands.find((c) => c.manifest.name === "session:delete")!.handler(cap.make("active"));
    expect(cap.out[0]).toBe("Active session: new");
  });
});
```

- [ ] **Step 2: Run test, expect failure**

```bash
bun test test/slash.test.ts
```
Expected: FAIL — slash.ts missing.

- [ ] **Step 3: Implement `slash.ts`**

Create `plugins/llm-session-manager/slash.ts`:

```typescript
import type { CommandsApi } from "./commands.ts";
import type { SessionRecord } from "./store.ts";

export interface SlashCommandManifestLike {
  name: string;
  description: string;
  source: "plugin";
  usage?: string;
}
export interface SlashCommandContextLike {
  args: string;
  print: (text: string) => Promise<void>;
}
export interface SlashRegistryLike {
  register(manifest: SlashCommandManifestLike, handler: (ctx: SlashCommandContextLike) => Promise<void>): () => void;
}

function sessionLine(record: SessionRecord): string {
  const label = record.alias ? ` (${record.alias})` : "";
  const agent = record.agentName ? ` agent=${record.agentName}` : "";
  const marker = record.parentSessionId ? "  " : "";
  return `${marker}${record.id}${label}${agent}`;
}

export function registerSlashCommands(slash: SlashRegistryLike, cmds: CommandsApi): Array<() => void> {
  const offs: Array<() => void> = [];

  const newSessionHandler = async (ctx: SlashCommandContextLike) => {
    const r = await cmds.clearSession();
    await ctx.print(`Active session: ${r.to}`);
  };

  offs.push(slash.register(
    { name: "clear", description: "Archive current session and start a fresh one", source: "plugin" },
    newSessionHandler,
  ));
  offs.push(slash.register(
    { name: "session:new", description: "Create and switch to a new top-level session", source: "plugin" },
    newSessionHandler,
  ));

  offs.push(slash.register(
    { name: "session:list", description: "List sessions", source: "plugin", usage: "[--all]" },
    async (ctx) => {
      const includeChildren = ctx.args.split(/\s+/).filter(Boolean).includes("--all");
      const rows = await cmds.listSessions({ includeChildren });
      await ctx.print(rows.length ? rows.map(sessionLine).join("\n") : "No sessions.");
    },
  ));

  offs.push(slash.register(
    { name: "session:resume", description: "Resume a session by id or alias", source: "plugin", usage: "<id|alias>" },
    async (ctx) => {
      const r = await cmds.resumeSession({ id_or_alias: ctx.args.trim() });
      await ctx.print(`Active session: ${r.id}`);
    },
  ));

  offs.push(slash.register(
    { name: "session:rename", description: "Rename the active session (alias only; id is unchanged)", source: "plugin", usage: "<new-name>" },
    async (ctx) => {
      const name = ctx.args.trim();
      if (!name) {
        await ctx.print("Usage: /session:rename <new-name>");
        return;
      }
      try {
        const r = await cmds.renameActiveSession({ name });
        await ctx.print(`Renamed session ${r.id} → ${r.alias}`);
      } catch (e: any) {
        await ctx.print(`Rename failed: ${e?.message ?? String(e)}`);
      }
    },
  ));

  offs.push(slash.register(
    { name: "session:delete", description: "Delete a session", source: "plugin", usage: "<id> [--cascade]" },
    async (ctx) => {
      const parts = ctx.args.split(/\s+/).filter(Boolean);
      const cascade = parts.includes("--cascade");
      const id = parts.find((p) => p !== "--cascade");
      if (!id) throw new Error("missing session id");
      const r = await cmds.deleteSession({ id, cascade });
      if (r.replacement) {
        await ctx.print(`Active session: ${r.replacement}`);
      } else {
        await ctx.print(`Deleted session: ${r.deleted}`);
      }
    },
  ));

  return offs;
}
```

- [ ] **Step 4: Run tests, expect pass**

```bash
bun test test/slash.test.ts
```
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-session-manager/slash.ts plugins/llm-session-manager/test/slash.test.ts
git commit -m "feat(session-manager): slash adapters for /clear and /session:*"
```

---

## Task 3: Tool adapters in llm-session-manager

**Files:**
- Create: `plugins/llm-session-manager/tools.ts`
- Test: `plugins/llm-session-manager/test/tools.test.ts`

- [ ] **Step 1: Write failing tests**

Create `plugins/llm-session-manager/test/tools.test.ts`:

```typescript
import { describe, it, expect, mock } from "bun:test";
import { registerToolCommands, type ToolsRegistryLike } from "../tools.ts";
import type { CommandsApi } from "../commands.ts";

interface RegisteredTool {
  schema: { name: string; description: string; parameters: any };
  handler: (args: any, ctx: any) => Promise<unknown>;
}

function fakeRegistry(): { svc: ToolsRegistryLike; tools: RegisteredTool[] } {
  const tools: RegisteredTool[] = [];
  return {
    tools,
    svc: { register: (schema, handler) => { tools.push({ schema, handler } as RegisteredTool); return () => {}; } },
  };
}

function fakeCommands(overrides: Partial<CommandsApi> = {}): CommandsApi {
  return {
    clearSession: mock(async () => ({ from: null, to: "new", alias: null })),
    listSessions: mock(async () => []),
    resumeSession: mock(async () => ({ id: "x", alias: null })),
    renameActiveSession: mock(async (opts) => ({ id: "active", alias: opts.name })),
    deleteSession: mock(async (opts) => ({ deleted: opts.id })),
    ...overrides,
  };
}

const callCtx = () => ({ signal: new AbortController().signal, callId: "c1", log: () => {} });

describe("session tool peers", () => {
  it("registers exactly the five tool peers", () => {
    const { svc, tools } = fakeRegistry();
    registerToolCommands(svc, fakeCommands());
    expect(tools.map((t) => t.schema.name).sort()).toEqual([
      "session:delete",
      "session:list",
      "session:new",
      "session:rename",
      "session:resume",
    ]);
  });

  it("session:new returns the clearSession result verbatim", async () => {
    const cmds = fakeCommands({ clearSession: mock(async () => ({ from: "a", to: "b", alias: "owl" })) });
    const { svc, tools } = fakeRegistry();
    registerToolCommands(svc, cmds);
    const out = await tools.find((t) => t.schema.name === "session:new")!.handler({}, callCtx());
    expect(out).toEqual({ from: "a", to: "b", alias: "owl" });
  });

  it("session:list passes includeChildren and returns rows", async () => {
    const rows = [{ id: "s1", alias: "owl", harness: "h", metadata: {}, createdAt: 0, pluginFingerprint: [] }];
    const list = mock(async () => rows);
    const { svc, tools } = fakeRegistry();
    registerToolCommands(svc, fakeCommands({ listSessions: list as any }));
    const out = await tools.find((t) => t.schema.name === "session:list")!.handler({ includeChildren: true }, callCtx());
    expect(out).toBe(rows);
    expect((list as any).mock.calls[0][0]).toEqual({ includeChildren: true });
  });

  it("session:resume requires id_or_alias in schema", () => {
    const { svc, tools } = fakeRegistry();
    registerToolCommands(svc, fakeCommands());
    const t = tools.find((t) => t.schema.name === "session:resume")!;
    expect(t.schema.parameters.required).toContain("id_or_alias");
  });

  it("session:rename requires name in schema", () => {
    const { svc, tools } = fakeRegistry();
    registerToolCommands(svc, fakeCommands());
    const t = tools.find((t) => t.schema.name === "session:rename")!;
    expect(t.schema.parameters.required).toContain("name");
  });

  it("session:delete passes id and cascade", async () => {
    const del = mock(async () => ({ deleted: "x", replacement: "y" }));
    const { svc, tools } = fakeRegistry();
    registerToolCommands(svc, fakeCommands({ deleteSession: del as any }));
    const out = await tools.find((t) => t.schema.name === "session:delete")!.handler({ id: "x", cascade: true }, callCtx());
    expect(out).toEqual({ deleted: "x", replacement: "y" });
    expect((del as any).mock.calls[0][0]).toEqual({ id: "x", cascade: true });
  });

  it("session:rename surfaces underlying errors (no swallow)", async () => {
    const rename = mock(async () => { throw new Error("alias taken"); });
    const { svc, tools } = fakeRegistry();
    registerToolCommands(svc, fakeCommands({ renameActiveSession: rename as any }));
    const t = tools.find((t) => t.schema.name === "session:rename")!;
    await expect(t.handler({ name: "x" }, callCtx())).rejects.toThrow(/alias taken/);
  });
});
```

- [ ] **Step 2: Run test, expect failure**

```bash
bun test test/tools.test.ts
```
Expected: FAIL — tools.ts missing.

- [ ] **Step 3: Implement `tools.ts`**

Create `plugins/llm-session-manager/tools.ts`:

```typescript
import type { CommandsApi } from "./commands.ts";
import type { ToolSchema } from "llm-events/public";

export interface ToolHandlerLike {
  (args: any, ctx: { signal: AbortSignal; callId: string; log: (m: string) => void }): Promise<unknown>;
}
export interface ToolsRegistryLike {
  register(schema: ToolSchema, handler: ToolHandlerLike): () => void;
}

const EMPTY_OBJECT = { type: "object", properties: {}, additionalProperties: false } as const;

export function registerToolCommands(tools: ToolsRegistryLike, cmds: CommandsApi): Array<() => void> {
  const offs: Array<() => void> = [];

  offs.push(tools.register(
    {
      name: "session:new",
      description: "Archive the current session and start a fresh one. Returns ids of previous (from) and new (to) sessions.",
      parameters: EMPTY_OBJECT as any,
    },
    async () => cmds.clearSession(),
  ));

  offs.push(tools.register(
    {
      name: "session:list",
      description: "List sessions for the current harness.",
      parameters: {
        type: "object",
        properties: { includeChildren: { type: "boolean", description: "Include child sessions (e.g. agent sessions). Defaults to false." } },
        additionalProperties: false,
      } as any,
    },
    async (args: any) => cmds.listSessions({ includeChildren: !!args?.includeChildren }),
  ));

  offs.push(tools.register(
    {
      name: "session:resume",
      description: "Switch the active session to one resolved by id or alias.",
      parameters: {
        type: "object",
        properties: { id_or_alias: { type: "string", description: "Session id (full path) or alias." } },
        required: ["id_or_alias"],
        additionalProperties: false,
      } as any,
    },
    async (args: any) => cmds.resumeSession({ id_or_alias: String(args?.id_or_alias ?? "") }),
  ));

  offs.push(tools.register(
    {
      name: "session:rename",
      description: "Rename the active session (alias only; id is unchanged).",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "New alias for the active session." } },
        required: ["name"],
        additionalProperties: false,
      } as any,
    },
    async (args: any) => cmds.renameActiveSession({ name: String(args?.name ?? "") }),
  ));

  offs.push(tools.register(
    {
      name: "session:delete",
      description: "Delete a session by id. If deleting the active session, a replacement is created and made active.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Session id to delete." },
          cascade: { type: "boolean", description: "Also delete child sessions. Required when deleting a session that has children. Defaults to false." },
        },
        required: ["id"],
        additionalProperties: false,
      } as any,
    },
    async (args: any) => cmds.deleteSession({ id: String(args?.id ?? ""), cascade: !!args?.cascade }),
  ));

  return offs;
}
```

- [ ] **Step 4: Run tests, expect pass**

```bash
bun test test/tools.test.ts
```
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-session-manager/tools.ts plugins/llm-session-manager/test/tools.test.ts
git commit -m "feat(session-manager): tool peers for session:* commands"
```

---

## Task 4: Adapter parity test

**Files:**
- Test: `plugins/llm-session-manager/test/parity.test.ts`

- [ ] **Step 1: Write parity test**

Create `plugins/llm-session-manager/test/parity.test.ts`:

```typescript
import { describe, it, expect, mock } from "bun:test";
import { registerSlashCommands } from "../slash.ts";
import { registerToolCommands } from "../tools.ts";
import { makeCommands } from "../commands.ts";
import type { SessionsStoreService, SessionRecord } from "../store.ts";

function fakeStore(rec: SessionRecord): SessionsStoreService {
  return {
    create: mock(async () => rec),
    load: mock(async () => rec),
    exists: mock(async () => true),
    getMessages: mock(async () => []),
    beginTurn: mock(() => ({ turnId: "", append: () => {}, commit: async () => {}, rollback: async () => {} })),
    list: mock(async () => [rec]),
    rename: mock(async (id, alias) => ({ ...rec, id, alias: alias ?? undefined })),
    delete: mock(async () => {}),
    readEvents: mock(() => (async function* () {})()),
  };
}

describe("slash and tool adapters produce equivalent service side-effects", () => {
  it("clearSession: /clear and session:new both call store.create exactly once and emit the same events", async () => {
    const rec: SessionRecord = { id: "fresh", alias: "ant", harness: "h", metadata: {}, createdAt: 0, pluginFingerprint: [] };

    async function run(register: (cmds: ReturnType<typeof makeCommands>) => Promise<void>) {
      const store = fakeStore(rec);
      const events: Array<{ event: string; payload: any }> = [];
      const cmds = makeCommands({
        store,
        emit: async (event, payload) => { events.push({ event, payload: payload as any }); return []; },
        getActiveSessionId: () => "old",
      });
      await register(cmds);
      return { store, events };
    }

    const slashRun = await run(async (cmds) => {
      const registered: any[] = [];
      registerSlashCommands({ register: (m, h) => { registered.push({ m, h }); return () => {}; } }, cmds);
      await registered.find((r) => r.m.name === "session:new").h({ args: "", print: async () => {} });
    });
    const toolRun = await run(async (cmds) => {
      const registered: any[] = [];
      registerToolCommands({ register: (s, h) => { registered.push({ s, h }); return () => {}; } }, cmds);
      await registered.find((r) => r.s.name === "session:new").h({}, { signal: new AbortController().signal, callId: "c", log: () => {} });
    });

    expect((slashRun.store.create as any).mock.calls.length).toBe(1);
    expect((toolRun.store.create as any).mock.calls.length).toBe(1);
    expect(slashRun.events).toEqual(toolRun.events);
  });
});
```

- [ ] **Step 2: Run test, expect pass (no impl needed — just verifying parity)**

```bash
bun test test/parity.test.ts
```
Expected: PASS, 1 test.

- [ ] **Step 3: Commit**

```bash
git add plugins/llm-session-manager/test/parity.test.ts
git commit -m "test(session-manager): parity test for slash vs tool adapters"
```

---

## Task 5: Wire registrations into llm-session-manager index.ts

**Files:**
- Modify: `plugins/llm-session-manager/index.ts`

- [ ] **Step 1: Update index.ts to register slash + tool peers on harness:start**

Replace `plugins/llm-session-manager/index.ts` entirely:

```typescript
import type { KaizenPlugin } from "kaizen/types";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { harnessKey } from "./harness-key";
import { makeStore, type SessionsStoreService } from "./store";
import { makeTraceSubscriber } from "./trace-subscriber";
import { makeCommands } from "./commands.ts";
import { registerSlashCommands, type SlashRegistryLike } from "./slash.ts";
import { registerToolCommands, type ToolsRegistryLike } from "./tools.ts";

interface SessionManagerConfig {
  sessionsBase?: string;
}

const TRACE_EVENTS = [
  "session:renamed",
  "turn:start",
  "turn:end",
  "turn:error",
  "turn:cancel",
  "llm:request",
  "llm:done",
  "llm:error",
  "tool:before-execute",
  "tool:execute",
  "tool:result",
  "tool:error",
  "codemode:code-emitted",
  "codemode:before-execute",
  "codemode:result",
  "codemode:error",
];

const LIFECYCLE_EVENTS = ["harness:start", "session:active-changed"];

const plugin: KaizenPlugin = {
  name: "llm-session-manager",
  apiVersion: "3.0.0",
  permissions: {
    tier: "scoped",
    fs: { read: ["~/.kaizen/sessions/**"], write: ["~/.kaizen/sessions/**"] },
    events: { subscribe: [...TRACE_EVENTS, ...LIFECYCLE_EVENTS] },
  },
  services: {
    consumes: ["llm-events:vocabulary"],
    provides: ["sessions:store"],
  },

  async setup(ctx) {
    ctx.consumeService("llm-events:vocabulary");
    const config = (ctx.config ?? {}) as SessionManagerConfig;
    const sessionsBase = config.sessionsBase ?? join(homedir(), ".kaizen", "sessions");
    const key = harnessKey(ctx.harness ?? {});
    const store = makeStore({
      sessionsBase,
      harnessKey: key,
      pluginFingerprint: ["llm-session-manager@0.1.0"],
      now: () => Date.now(),
      newUuid: () => randomUUID(),
      log: ctx.log.bind(ctx),
      emit: ctx.emit.bind(ctx),
    });

    ctx.defineService("sessions:store", {
      description: "Persistent session store with per-turn commit/rollback and append-only traces.",
    });
    ctx.provideService<SessionsStoreService>("sessions:store", store);

    let activeSessionId: string | null = null;
    ctx.on("session:active-changed", (payload: any) => {
      if (typeof payload?.to === "string") activeSessionId = payload.to;
    });

    const subscriber = makeTraceSubscriber({
      store,
      now: () => Date.now(),
      log: ctx.log.bind(ctx),
    });
    for (const event of TRACE_EVENTS) {
      ctx.on(event, async (payload: any) => {
        await subscriber.handle(event, payload);
      });
    }

    // Register slash + tool adapters on harness:start so consumed registries
    // are guaranteed to be provided. Both are soft dependencies.
    ctx.on("harness:start", () => {
      const cmds = makeCommands({ store, emit: ctx.emit.bind(ctx), getActiveSessionId: () => activeSessionId });
      try {
        const slash = ctx.useService<SlashRegistryLike>("slash:registry");
        if (slash) registerSlashCommands(slash, cmds);
      } catch { /* slash:registry absent — skip */ }
      try {
        const toolsReg = ctx.useService<ToolsRegistryLike>("tools:registry");
        if (toolsReg) registerToolCommands(toolsReg, cmds);
      } catch { /* tools:registry absent — skip */ }
    });
  },
};

export default plugin;
```

- [ ] **Step 2: Run all session-manager tests**

```bash
cd plugins/llm-session-manager && bun test
```
Expected: PASS for all (including existing tests).

- [ ] **Step 3: Commit**

```bash
git add plugins/llm-session-manager/index.ts
git commit -m "feat(session-manager): register slash + tool adapters on harness:start"
```

---

## Task 6: Strip session built-ins from llm-slash-commands

**Files:**
- Modify: `plugins/llm-slash-commands/builtins.ts`
- Modify: `plugins/llm-slash-commands/index.ts`
- Modify: `plugins/llm-slash-commands/test/builtins.test.ts`

- [ ] **Step 1: Replace `builtins.ts` with the trimmed version**

Replace `plugins/llm-slash-commands/builtins.ts` entirely:

```typescript
import type {
  SlashCommandContext,
  SlashCommandManifest,
  SlashRegistryService,
} from "./registry.ts";

interface Group {
  label: string;
  match: (m: SlashCommandManifest) => boolean;
}

const DRIVER_BARE_NAMES = new Set(["clear", "model"]);

const GROUPS: Group[] = [
  { label: "Built-in", match: (m) => m.source === "builtin" && !m.name.includes(":") && !DRIVER_BARE_NAMES.has(m.name) },
  { label: "Driver",   match: (m) => m.source === "builtin" && DRIVER_BARE_NAMES.has(m.name) },
  { label: "Skills",   match: (m) => m.name === "skills" || m.name.startsWith("skills:") || m.name.startsWith("skills-") },
  { label: "Agents",   match: (m) => m.name === "agents" || m.name.startsWith("agents:") },
  { label: "Sessions", match: (m) => m.name.startsWith("session:") || m.name === "clear" },
  { label: "Memory",   match: (m) => m.name.startsWith("memory:") },
  { label: "MCP",      match: (m) => m.name.startsWith("mcp:") },
  { label: "User",     match: (m) => m.source === "file" },
];

function formatLine(m: SlashCommandManifest): string {
  const head = m.usage ? `/${m.name} ${m.usage}` : `/${m.name}`;
  return `  ${head} — ${m.description}`;
}

function formatEntry(m: SlashCommandManifest): string {
  const head = m.usage ? `/${m.name} ${m.usage}` : `/${m.name}`;
  const tail = m.filePath ? `\n  source: ${m.filePath}` : "";
  return `${head} — ${m.description}${tail}`;
}

function helpAll(registry: SlashRegistryService): string {
  const all = registry.list();
  const lines: string[] = [];
  const consumed = new Set<string>();

  for (const g of GROUPS) {
    const items = all.filter((m) => !consumed.has(m.name) && g.match(m));
    if (items.length === 0) continue;
    items.forEach((m) => consumed.add(m.name));
    lines.push(g.label);
    for (const m of items) lines.push(formatLine(m));
    lines.push("");
  }

  const rest = all.filter((m) => !consumed.has(m.name));
  if (rest.length) {
    lines.push("Other");
    for (const m of rest) lines.push(formatLine(m));
    lines.push("");
  }

  return lines.join("\n").replace(/\n+$/, "");
}

export function registerBuiltins(registry: SlashRegistryService): void {
  registry.register(
    { name: "help", description: "List available slash commands", source: "builtin", usage: "[command]" },
    async (ctx: SlashCommandContext) => {
      const arg = ctx.args.trim();
      if (!arg) { await ctx.print(helpAll(registry)); return; }
      const entry = registry.get(arg);
      if (!entry) { await ctx.print(`Unknown command: /${arg}.`); return; }
      await ctx.print(formatEntry(entry.manifest));
    },
  );

  registry.register(
    { name: "exit", description: "End the session", source: "builtin" },
    async (ctx: SlashCommandContext) => {
      await ctx.emit("harness:exit-requested", {});
    },
  );

  registry.register(
    { name: "history", description: "Open the session audit view (j/k focus, Enter expand, q quit)", source: "builtin" },
    async (ctx: SlashCommandContext) => {
      await ctx.emit("tui:enter-history", {});
    },
  );
}
```

- [ ] **Step 2: Update `index.ts`**

Replace `plugins/llm-slash-commands/index.ts` with the trimmed version. Specifically: drop `consumes: ["sessions:store"]`, drop the `useService("sessions:store")` block, drop `sessions`/`getActiveSessionId`/`log` deps from `registerBuiltins(registry)`. Keep `activeSessionId` tracking for file-loader.

```typescript
import type { KaizenPlugin } from "kaizen/types";
import { readdir, readFile } from "node:fs/promises";
import { createRegistry, type SlashRegistryService } from "./registry.ts";
import { registerBuiltins } from "./builtins.ts";
import { loadFileCommands, type DriverLike } from "./file-loader.ts";
import { makeOnInputSubmit } from "./dispatcher.ts";
import { buildCompletionSource } from "./completion.ts";

interface TuiCompletionService {
  register(source: { trigger: string; list(input: string, cursor: number): Promise<unknown[]> }): () => void;
}

const plugin: KaizenPlugin = {
  name: "llm-slash-commands",
  apiVersion: "3.0.0",
  permissions: { tier: "unscoped" },
  services: { provides: ["slash:registry"] },

  async setup(ctx) {
    const registry: SlashRegistryService = createRegistry();
    let activeSessionId: string | null = null;
    ctx.on?.("session:active-changed", (payload: any) => {
      if (typeof payload?.to === "string") activeSessionId = payload.to;
    });

    registerBuiltins(registry);

    const home = process.env.HOME ?? "/";
    const cwd = process.cwd();
    const warnings = await loadFileCommands({
      home,
      cwd,
      registry,
      readDir: (p) => readdir(p),
      readFile: (p) => readFile(p, "utf8"),
      getDriver: () => ctx.useService?.<DriverLike>("driver:run-conversation") ?? undefined,
      getActiveSessionId: () => activeSessionId,
    });
    if (warnings.length) {
      const text = "llm-slash-commands: file loader warnings\n" + warnings.map((w) => `  - ${w}`).join("\n");
      await ctx.emit("conversation:system-message", {
        message: { role: "system", content: text },
      });
    }

    ctx.defineService("slash:registry", { description: "Slash command registry." });
    ctx.provideService<SlashRegistryService>("slash:registry", registry);

    const sessionSignal: AbortSignal = (ctx as any).signal ?? new AbortController().signal;
    const onSubmit = makeOnInputSubmit({
      registry,
      bus: { emit: (e, p) => ctx.emit(e, p), signal: sessionSignal },
    });
    ctx.on?.("input:submit", onSubmit, { priority: 100 });

    let completion: TuiCompletionService | undefined;
    try { completion = ctx.useService<TuiCompletionService>("llm-tui:completion"); } catch { completion = undefined; }
    if (completion) {
      completion.register(buildCompletionSource(registry));
    }
  },
};

export default plugin;
```

- [ ] **Step 3: Update `test/builtins.test.ts`**

Open `plugins/llm-slash-commands/test/builtins.test.ts`. Delete every test that exercises `/clear`, `/session:new`, `/session:list`, `/session:resume`, `/session:rename`, `/session:delete`. Keep tests for `/help`, `/exit`, `/history` only. Remove any unused imports left dangling (e.g. fake sessions store).

If any tests in `integration.test.ts` invoke session commands, delete those test cases too — those moved to `llm-session-manager`.

- [ ] **Step 4: Run llm-slash-commands tests**

```bash
cd plugins/llm-slash-commands && bun test
```
Expected: PASS, no test names referencing session/clear commands.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-slash-commands/builtins.ts plugins/llm-slash-commands/index.ts plugins/llm-slash-commands/test/
git commit -m "refactor(slash-commands): move session built-ins out to llm-session-manager"
```

---

## Task 7: Tool peers in llm-mcp-bridge

**Files:**
- Create: `plugins/llm-mcp-bridge/tools-peers.ts`
- Test: `plugins/llm-mcp-bridge/test/tools-peers.test.ts`

- [ ] **Step 1: Write failing tests**

Create `plugins/llm-mcp-bridge/test/tools-peers.test.ts`:

```typescript
import { describe, it, expect, mock } from "bun:test";
import { registerToolPeers, type ToolsRegistryLike } from "../tools-peers.ts";
import type { McpBridgeService, ServerInfo } from "../public.d.ts";

interface RegisteredTool {
  schema: { name: string; description: string; parameters: any };
  handler: (args: any, ctx: any) => Promise<unknown>;
}

function fakeRegistry(): { svc: ToolsRegistryLike; tools: RegisteredTool[] } {
  const tools: RegisteredTool[] = [];
  return {
    tools,
    svc: { register: (schema, handler) => { tools.push({ schema, handler } as RegisteredTool); return () => {}; } },
  };
}

function fakeBridge(overrides: Partial<McpBridgeService & { reload: any }> = {}): any {
  return {
    list: mock(() => [] as ServerInfo[]),
    get: mock(() => undefined),
    reconnect: mock(async () => {}),
    reload: mock(async () => ({ added: [], removed: [], updated: [] })),
    shutdown: mock(async () => {}),
    ...overrides,
  };
}

const callCtx = () => ({ signal: new AbortController().signal, callId: "c1", log: () => {} });

describe("mcp tool peers", () => {
  it("registers exactly mcp:list, mcp:reload, mcp:reconnect, mcp:disable", () => {
    const { svc, tools } = fakeRegistry();
    registerToolPeers(svc, fakeBridge(), async () => new Map());
    expect(tools.map((t) => t.schema.name).sort()).toEqual([
      "mcp:disable", "mcp:list", "mcp:reconnect", "mcp:reload",
    ]);
  });

  it("mcp:list returns bridge.list() rows verbatim", async () => {
    const rows: ServerInfo[] = [
      { name: "github", transport: "stdio", status: "connected", toolCount: 3, resourceCount: 0, lastError: undefined } as any,
    ];
    const bridge = fakeBridge({ list: mock(() => rows) });
    const { svc, tools } = fakeRegistry();
    registerToolPeers(svc, bridge, async () => new Map());
    const out = await tools.find((t) => t.schema.name === "mcp:list")!.handler({}, callCtx());
    expect(out).toBe(rows);
  });

  it("mcp:reload re-reads config and applies bridge.reload()", async () => {
    const cfg = new Map();
    const reload = mock(async () => ({ added: ["a"], removed: [], updated: ["u"] }));
    const reloadFromDisk = mock(async () => cfg);
    const bridge = fakeBridge({ reload });
    const { svc, tools } = fakeRegistry();
    registerToolPeers(svc, bridge, reloadFromDisk);
    const out = await tools.find((t) => t.schema.name === "mcp:reload")!.handler({}, callCtx());
    expect(out).toEqual({ added: ["a"], removed: [], updated: ["u"] });
    expect((reloadFromDisk as any).mock.calls.length).toBe(1);
    expect((reload as any).mock.calls[0][0]).toBe(cfg);
  });

  it("mcp:reconnect calls bridge.reconnect with the server name", async () => {
    const reconnect = mock(async () => {});
    const bridge = fakeBridge({ reconnect });
    const { svc, tools } = fakeRegistry();
    registerToolPeers(svc, bridge, async () => new Map());
    const out = await tools.find((t) => t.schema.name === "mcp:reconnect")!.handler({ server: "github" }, callCtx());
    expect(out).toEqual({ ok: true });
    expect((reconnect as any).mock.calls[0]).toEqual(["github"]);
  });

  it("mcp:disable calls bridge.shutdown with the server name", async () => {
    const shutdown = mock(async () => {});
    const bridge = fakeBridge({ shutdown });
    const { svc, tools } = fakeRegistry();
    registerToolPeers(svc, bridge, async () => new Map());
    const out = await tools.find((t) => t.schema.name === "mcp:disable")!.handler({ server: "github" }, callCtx());
    expect(out).toEqual({ ok: true });
    expect((shutdown as any).mock.calls[0]).toEqual(["github"]);
  });

  it("mcp:reconnect requires server in schema", () => {
    const { svc, tools } = fakeRegistry();
    registerToolPeers(svc, fakeBridge(), async () => new Map());
    const t = tools.find((t) => t.schema.name === "mcp:reconnect")!;
    expect(t.schema.parameters.required).toContain("server");
  });
});
```

- [ ] **Step 2: Run test, expect failure**

```bash
cd plugins/llm-mcp-bridge && bun test test/tools-peers.test.ts
```
Expected: FAIL — tools-peers.ts missing.

- [ ] **Step 3: Implement `tools-peers.ts`**

Create `plugins/llm-mcp-bridge/tools-peers.ts`:

```typescript
import type { McpBridgeService, ServerInfo } from "./public.d.ts";
import type { ResolvedServerConfig } from "./config.ts";
import type { ToolSchema } from "llm-events/public";

export interface ToolHandlerLike {
  (args: any, ctx: { signal: AbortSignal; callId: string; log: (m: string) => void }): Promise<unknown>;
}
export interface ToolsRegistryLike {
  register(schema: ToolSchema, handler: ToolHandlerLike): () => void;
}

const EMPTY_OBJECT = { type: "object", properties: {}, additionalProperties: false } as const;

const SERVER_ARG = {
  type: "object",
  properties: { server: { type: "string", description: "MCP server name as configured." } },
  required: ["server"],
  additionalProperties: false,
} as const;

export function registerToolPeers(
  tools: ToolsRegistryLike,
  bridge: McpBridgeService & { reload(cfg: Map<string, ResolvedServerConfig>): Promise<{ added: string[]; removed: string[]; updated: string[] }> },
  reloadFromDisk: () => Promise<Map<string, ResolvedServerConfig>>,
): Array<() => void> {
  const offs: Array<() => void> = [];

  offs.push(tools.register(
    {
      name: "mcp:list",
      description: "List configured MCP servers and their connection status, transport, and tool/resource counts.",
      parameters: EMPTY_OBJECT as any,
    },
    async () => bridge.list() as ServerInfo[],
  ));

  offs.push(tools.register(
    {
      name: "mcp:reload",
      description: "Re-read the MCP server configuration from disk and apply the diff. Returns the added, removed, and updated server names.",
      parameters: EMPTY_OBJECT as any,
    },
    async () => {
      const cfg = await reloadFromDisk();
      return bridge.reload(cfg);
    },
  ));

  offs.push(tools.register(
    {
      name: "mcp:reconnect",
      description: "Force-reconnect a single MCP server. Useful when a server is in a degraded state.",
      parameters: SERVER_ARG as any,
    },
    async (args: any) => {
      await bridge.reconnect(String(args?.server ?? ""));
      return { ok: true };
    },
  ));

  offs.push(tools.register(
    {
      name: "mcp:disable",
      description: "Shut down a single MCP server until the next mcp:reload. Tools belonging to the server stop working.",
      parameters: SERVER_ARG as any,
    },
    async (args: any) => {
      await bridge.shutdown(String(args?.server ?? ""));
      return { ok: true };
    },
  ));

  return offs;
}
```

- [ ] **Step 4: Run tests, expect pass**

```bash
bun test test/tools-peers.test.ts
```
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-mcp-bridge/tools-peers.ts plugins/llm-mcp-bridge/test/tools-peers.test.ts
git commit -m "feat(mcp-bridge): tool peers for /mcp:* slash commands"
```

---

## Task 8: Wire mcp tool peers into llm-mcp-bridge index.ts

**Files:**
- Modify: `plugins/llm-mcp-bridge/index.ts`

- [ ] **Step 1: Add the registerToolPeers call inside the existing `tools:registry` block**

In `plugins/llm-mcp-bridge/index.ts`, after this block:

```typescript
// Slash commands (soft dependency).
const slash = ctx.useService<SlashRegistryLike>("slash:registry");
if (slash) {
  registerSlashCommands(slash, svc, async () => (await loadConfig(realDeps(log))).servers, log);
} else {
  log("llm-mcp-bridge: slash:registry not present; /mcp:* commands not registered");
}
```

Add (immediately after, before the status-bar section):

```typescript
// Tool peers — same surface, shaped for the LLM.
registerToolPeers(
  { register: (s, h) => registry.register(s as any, h as any) },
  svc,
  async () => (await loadConfig(realDeps(log))).servers,
);
```

And add the import at the top:

```typescript
import { registerToolPeers } from "./tools-peers.ts";
```

- [ ] **Step 2: Run all mcp-bridge tests**

```bash
bun test
```
Expected: PASS for all (including existing tests).

- [ ] **Step 3: Commit**

```bash
git add plugins/llm-mcp-bridge/index.ts
git commit -m "feat(mcp-bridge): register /mcp:* tool peers alongside slash commands"
```

---

## Task 9: Full repo test sweep

- [ ] **Step 1: Run every plugin's tests**

```bash
cd /Users/chancock/git/kaizen-official-plugins
for d in plugins/llm-session-manager plugins/llm-slash-commands plugins/llm-mcp-bridge plugins/llm-tools-registry; do
  echo "=== $d ==="
  (cd "$d" && bun test 2>&1 | tail -5)
done
```
Expected: every plugin reports PASS with no failures.

- [ ] **Step 2: Commit if any incidental fixes were needed**

If a peer plugin's tests broke (e.g. an integration test in another plugin that relied on session commands living in `llm-slash-commands`), fix in place and commit:

```bash
git add -A && git commit -m "test: fix peer-plugin tests after session command move"
```

If nothing changed, skip this step.

---

## Task 10: Bundle and deploy locally

**Files:** none committed; bundles under `~/.kaizen/marketplaces/official/plugins/<name>@<ver>/`.

- [ ] **Step 1: Re-bundle the three modified plugins**

```bash
for p in llm-session-manager llm-slash-commands llm-mcp-bridge; do
  ver=$(ls ~/.kaizen/marketplaces/official/plugins/ | grep "^${p}@" | head -1)
  cp -R "/Users/chancock/git/kaizen-official-plugins/plugins/${p}/." "$HOME/.kaizen/marketplaces/official/plugins/${ver}/"
  (cd "$HOME/.kaizen/marketplaces/official/plugins/${ver}" && bun build --target=bun --outfile=dist/index.js index.ts)
done
```
Expected: three "Bundled N modules" lines, no errors.

- [ ] **Step 2: Smoke-test in a kaizen session**

Run kaizen against the openai-compatible harness and verify:

- `/help` lists `/clear`, `/session:*` under "Sessions"; `/mcp:*` still listed under "MCP"; `/tools:list` still listed.
- `/session:list` runs and returns rows.
- The LLM sees `session:new`, `session:list`, `session:resume`, `session:rename`, `session:delete`, `mcp:list`, `mcp:reload`, `mcp:reconnect`, `mcp:disable` in its tool catalog.
- Invoking `mcp:list` from the LLM returns the same rows as `/mcp:list`.

```bash
kaizen --harness official/openai-compatible
```

- [ ] **Step 3: Push**

```bash
git push
```
Expected: pushes to `main`.

---

## Self-Review

**Spec coverage:**

- Architecture (shared core + thin adapters): Tasks 1, 2, 3, 7. ✓
- Refactor (move session built-ins out of `llm-slash-commands`): Tasks 5, 6. ✓
- Tool peers (session): Task 3. ✓
- Tool peers (mcp): Task 7, 8. ✓
- Audit table (skip /help, /exit, /history, /tools:*): Task 5 (only `/help`, `/exit`, `/history` remain in builtins). Tools registry already skipped per spec. ✓
- Required parity test per plugin: Task 4 covers session-manager. mcp-bridge has structural parity by sharing the bridge service object directly. (Slash and tool both call same `bridge.*` methods; both get tested in their respective unit suites.)
- Out of scope (#4 seed prompt) is not implemented anywhere here. ✓
- Implementation note: `llm-session-manager` registers on `harness:start`, tier stays `scoped` with widened `events.subscribe` whitelist. Task 5. ✓

**Placeholder scan:** no TBDs, all code blocks complete, all paths absolute or repo-relative-explicit.

**Type consistency:** `CommandsApi` defined in commands.ts; both adapters import it. `SlashRegistryLike`, `ToolsRegistryLike` defined where used. `SessionRecord` imported from `store.ts` in slash.ts. `ServerInfo`, `McpBridgeService` imported from public.d.ts in mcp tool peers.

**Spec requirements with no task:** none found.
