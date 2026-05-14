# Agents Visibility Slash Commands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two read-only plugin-source slash commands — `/agents:list` and `/agents:show <name>` — to the `llm-agents` plugin, exposing the agent registry (which backs `dispatch_agent`) to the human user of the openai-compatible harness.

**Architecture:** A new pure factory module `plugins/llm-agents/slash.ts` exposes `makeSlashHandlers({ registry })`. `index.ts` gains a topo-hint optional dependency on `slash:registry`, looks it up at setup, registers both handlers, and tears them down in `stop()` using the same idempotent module-scope-unregister-fn pattern already used for the dispatch tool and prompt section.

**Tech Stack:** TypeScript / Bun, `bun:test`, kaizen plugin API v3, `llm-contracts/public` types (`SlashCommandHandler`, `SlashCommandContext`, `SlashRegistryService`).

**Spec:** `docs/superpowers/specs/2026-05-14-agents-slash-command-design.md`

---

## File map

- **Create** `plugins/llm-agents/slash.ts` — pure factory `makeSlashHandlers({ registry })` → `{ listHandler, showHandler }`. No `ctx` imports, no I/O.
- **Create** `plugins/llm-agents/test/slash.test.ts` — unit tests using hand-rolled fakes for the registry handle and `SlashCommandContext`.
- **Modify** `plugins/llm-agents/index.ts` — add `"slash:registry"` to `services.consumes`; after the prompt-section registration, optionally look up the slash service and register both commands; teardown in `stop()`.
- **Modify** `plugins/llm-agents/CLAUDE.md` — add `slash.ts` to the module map and a one-line invariant about optional slash registration.

---

## Task 1: Add `slash.ts` with `listHandler` (TDD)

**Files:**
- Create: `plugins/llm-agents/slash.ts`
- Create: `plugins/llm-agents/test/slash.test.ts`

- [ ] **Step 1: Write the failing tests for `listHandler`**

Create `plugins/llm-agents/test/slash.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import type { SlashCommandContext } from "llm-contracts/public";
import { makeSlashHandlers } from "../slash.ts";
import type { InternalAgentManifest } from "../frontmatter.ts";

function mkManifest(over: Partial<InternalAgentManifest> & { name: string }): InternalAgentManifest {
  return {
    name: over.name,
    description: over.description ?? `desc for ${over.name}`,
    systemPrompt: over.systemPrompt ?? `prompt for ${over.name}`,
    toolFilter: over.toolFilter,
    sourcePath: over.sourcePath ?? `/agents/${over.name}.md`,
    scope: over.scope ?? "user",
    modelOverride: over.modelOverride,
  };
}

function fakeRegistry(manifests: InternalAgentManifest[]) {
  const byName = new Map(manifests.map((m) => [m.name, m]));
  return {
    service: {
      list: () => manifests.map(({ sourcePath, scope, modelOverride, ...rest }) => rest),
      register: () => () => {},
    },
    getInternal: (name: string) => byName.get(name),
  };
}

function fakeCmdCtx(args = ""): SlashCommandContext & { printed: string[] } {
  const printed: string[] = [];
  return {
    args,
    raw: `/agents:list ${args}`.trim(),
    signal: new AbortController().signal,
    emit: async () => {},
    print: async (text: string) => { printed.push(text); },
    printed,
  } as unknown as SlashCommandContext & { printed: string[] };
}

describe("listHandler", () => {
  it("prints 'No agents registered.' when registry is empty", async () => {
    const { listHandler } = makeSlashHandlers({ registry: fakeRegistry([]) });
    const ctx = fakeCmdCtx();
    await listHandler(ctx);
    expect(ctx.printed).toEqual(["No agents registered."]);
  });

  it("prints alphabetized bullets with scope tags for user/project/runtime agents", async () => {
    const reg = fakeRegistry([
      mkManifest({ name: "db-migrator", description: "Plans and applies schema migrations safely.", scope: "project", sourcePath: "/proj/.kaizen/agents/db-migrator.md" }),
      mkManifest({ name: "code-reviewer", description: "Reviews diffs.", scope: "user", sourcePath: "/home/u/.kaizen/agents/code-reviewer.md" }),
      mkManifest({ name: "runtime:router:main", description: "Routes between specialists.", scope: "user", sourcePath: "<runtime>" }),
    ]);
    const { listHandler } = makeSlashHandlers({ registry: reg });
    const ctx = fakeCmdCtx();
    await listHandler(ctx);
    expect(ctx.printed).toHaveLength(1);
    expect(ctx.printed[0]).toBe(
      "- **`code-reviewer`** [user] — Reviews diffs.\n" +
      "- **`db-migrator`** [project] — Plans and applies schema migrations safely.\n" +
      "- **`runtime:router:main`** [runtime] — Routes between specialists.",
    );
  });

  it("ignores args", async () => {
    const reg = fakeRegistry([mkManifest({ name: "a", description: "A." })]);
    const { listHandler } = makeSlashHandlers({ registry: reg });
    const ctx = fakeCmdCtx("garbage   args");
    await listHandler(ctx);
    expect(ctx.printed[0]).toBe("- **`a`** [user] — A.");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd plugins/llm-agents && bun test test/slash.test.ts`
Expected: FAIL with `Cannot find module '../slash.ts'` (or equivalent module-not-found).

- [ ] **Step 3: Create the minimal `slash.ts` implementing `listHandler`**

Create `plugins/llm-agents/slash.ts`:

```typescript
import type { SlashCommandHandler } from "llm-contracts/public";
import type { InternalAgentManifest } from "./frontmatter.ts";

export interface SlashHandlerDeps {
  registry: {
    service: { list(): Array<Pick<InternalAgentManifest, "name" | "description" | "systemPrompt" | "toolFilter">> };
    getInternal(name: string): InternalAgentManifest | undefined;
  };
}

function scopeTag(m: InternalAgentManifest): "user" | "project" | "runtime" {
  if (m.sourcePath === "<runtime>") return "runtime";
  return m.scope;
}

export function makeSlashHandlers(deps: SlashHandlerDeps): {
  listHandler: SlashCommandHandler;
  showHandler: SlashCommandHandler;
} {
  const listHandler: SlashCommandHandler = async (cmdCtx) => {
    try {
      const items = deps.registry.service.list();
      if (items.length === 0) {
        await cmdCtx.print("No agents registered.");
        return;
      }
      const lines: string[] = [];
      for (const pub of [...items].sort((a, b) => a.name.localeCompare(b.name))) {
        const internal = deps.registry.getInternal(pub.name);
        if (!internal) continue;
        lines.push(`- **\`${pub.name}\`** [${scopeTag(internal)}] — ${pub.description}`);
      }
      await cmdCtx.print(lines.join("\n"));
    } catch (err) {
      await cmdCtx.print(`Error: ${(err as Error).message}`);
    }
  };

  const showHandler: SlashCommandHandler = async (cmdCtx) => {
    // Implemented in Task 2.
    await cmdCtx.print("Usage: /agents:show <name>");
  };

  return { listHandler, showHandler };
}
```

- [ ] **Step 4: Run tests to verify `listHandler` tests pass**

Run: `cd plugins/llm-agents && bun test test/slash.test.ts`
Expected: 3 tests pass (listHandler block). `showHandler` block does not exist yet.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-agents/slash.ts plugins/llm-agents/test/slash.test.ts
git commit -m "feat(llm-agents): add slash listHandler factory"
```

---

## Task 2: Add `showHandler` (TDD)

**Files:**
- Modify: `plugins/llm-agents/slash.ts`
- Modify: `plugins/llm-agents/test/slash.test.ts`

- [ ] **Step 1: Append failing tests for `showHandler`**

Append to `plugins/llm-agents/test/slash.test.ts` (inside the same file, after the `describe("listHandler", ...)` block):

```typescript
describe("showHandler", () => {
  it("prints usage when args are empty/whitespace", async () => {
    const { showHandler } = makeSlashHandlers({ registry: fakeRegistry([]) });
    const ctx = fakeCmdCtx("   ");
    await showHandler(ctx);
    expect(ctx.printed).toEqual(["Usage: /agents:show <name>"]);
  });

  it("prints unknown-agent message when name is not in registry", async () => {
    const reg = fakeRegistry([mkManifest({ name: "a" })]);
    const { showHandler } = makeSlashHandlers({ registry: reg });
    const ctx = fakeCmdCtx("does-not-exist");
    await showHandler(ctx);
    expect(ctx.printed).toEqual([
      "Unknown agent: does-not-exist. Run /agents:list to see registered agents.",
    ]);
  });

  it("renders a file-loaded agent with full system prompt and tool filter (tags + names)", async () => {
    const reg = fakeRegistry([
      mkManifest({
        name: "code-reviewer",
        description: "Reviews diffs.",
        systemPrompt: "You are a focused code reviewer.\nFollow the rules.",
        toolFilter: { tags: ["read-only"], names: ["read_file", "grep*"] },
        scope: "user",
        sourcePath: "/home/u/.kaizen/agents/code-reviewer.md",
      }),
    ]);
    const { showHandler } = makeSlashHandlers({ registry: reg });
    const ctx = fakeCmdCtx("code-reviewer");
    await showHandler(ctx);
    expect(ctx.printed).toHaveLength(1);
    expect(ctx.printed[0]).toBe(
      "**Agent**: code-reviewer\n" +
      "**Scope**: user\n" +
      "**Source**: /home/u/.kaizen/agents/code-reviewer.md\n" +
      "\n" +
      "**Description**: Reviews diffs.\n" +
      "\n" +
      "**Tool filter**:\n" +
      "- Tags: read-only\n" +
      "- Names: read_file, grep*\n" +
      "\n" +
      "**System prompt**:\n" +
      "```\n" +
      "You are a focused code reviewer.\nFollow the rules.\n" +
      "```",
    );
  });

  it("renders a runtime agent with sourcePath '<runtime>' and 'none' tool filter", async () => {
    const reg = fakeRegistry([
      mkManifest({
        name: "runtime:router:main",
        description: "Routes.",
        systemPrompt: "Router.",
        sourcePath: "<runtime>",
        toolFilter: undefined,
      }),
    ]);
    const { showHandler } = makeSlashHandlers({ registry: reg });
    const ctx = fakeCmdCtx("runtime:router:main");
    await showHandler(ctx);
    expect(ctx.printed[0]).toContain("**Scope**: runtime");
    expect(ctx.printed[0]).toContain("**Source**: <runtime>");
    expect(ctx.printed[0]).toContain(
      "Tool filter: none (agent inherits parent's tool view, plus always-on dispatch_agent / load_skill).",
    );
    expect(ctx.printed[0]).not.toContain("- Tags:");
    expect(ctx.printed[0]).not.toContain("- Names:");
  });

  it("omits Names: sub-bullet when toolFilter has only tags", async () => {
    const reg = fakeRegistry([
      mkManifest({ name: "a", toolFilter: { tags: ["read-only"] } }),
    ]);
    const { showHandler } = makeSlashHandlers({ registry: reg });
    const ctx = fakeCmdCtx("a");
    await showHandler(ctx);
    expect(ctx.printed[0]).toContain("- Tags: read-only");
    expect(ctx.printed[0]).not.toContain("- Names:");
  });

  it("omits Tags: sub-bullet when toolFilter has only names", async () => {
    const reg = fakeRegistry([
      mkManifest({ name: "a", toolFilter: { names: ["read_*"] } }),
    ]);
    const { showHandler } = makeSlashHandlers({ registry: reg });
    const ctx = fakeCmdCtx("a");
    await showHandler(ctx);
    expect(ctx.printed[0]).toContain("- Names: read_*");
    expect(ctx.printed[0]).not.toContain("- Tags:");
  });
});
```

- [ ] **Step 2: Run tests to verify `showHandler` tests fail**

Run: `cd plugins/llm-agents && bun test test/slash.test.ts`
Expected: 6 new failures in the `showHandler` describe block. listHandler tests still pass.

- [ ] **Step 3: Replace the stub `showHandler` in `slash.ts`**

In `plugins/llm-agents/slash.ts`, replace the `const showHandler` block with the full implementation. The full file should now read:

```typescript
import type { SlashCommandHandler } from "llm-contracts/public";
import type { InternalAgentManifest } from "./frontmatter.ts";

export interface SlashHandlerDeps {
  registry: {
    service: { list(): Array<Pick<InternalAgentManifest, "name" | "description" | "systemPrompt" | "toolFilter">> };
    getInternal(name: string): InternalAgentManifest | undefined;
  };
}

function scopeTag(m: InternalAgentManifest): "user" | "project" | "runtime" {
  if (m.sourcePath === "<runtime>") return "runtime";
  return m.scope;
}

function renderToolFilter(m: InternalAgentManifest): string {
  const tf = m.toolFilter;
  if (!tf || ((!tf.tags || tf.tags.length === 0) && (!tf.names || tf.names.length === 0))) {
    return "Tool filter: none (agent inherits parent's tool view, plus always-on dispatch_agent / load_skill).";
  }
  const parts = ["**Tool filter**:"];
  if (tf.tags && tf.tags.length > 0) parts.push(`- Tags: ${tf.tags.join(", ")}`);
  if (tf.names && tf.names.length > 0) parts.push(`- Names: ${tf.names.join(", ")}`);
  return parts.join("\n");
}

function renderShow(m: InternalAgentManifest): string {
  return [
    `**Agent**: ${m.name}`,
    `**Scope**: ${scopeTag(m)}`,
    `**Source**: ${m.sourcePath}`,
    "",
    `**Description**: ${m.description}`,
    "",
    renderToolFilter(m),
    "",
    "**System prompt**:",
    "```",
    m.systemPrompt,
    "```",
  ].join("\n");
}

export function makeSlashHandlers(deps: SlashHandlerDeps): {
  listHandler: SlashCommandHandler;
  showHandler: SlashCommandHandler;
} {
  const listHandler: SlashCommandHandler = async (cmdCtx) => {
    try {
      const items = deps.registry.service.list();
      if (items.length === 0) {
        await cmdCtx.print("No agents registered.");
        return;
      }
      const lines: string[] = [];
      for (const pub of [...items].sort((a, b) => a.name.localeCompare(b.name))) {
        const internal = deps.registry.getInternal(pub.name);
        if (!internal) continue;
        lines.push(`- **\`${pub.name}\`** [${scopeTag(internal)}] — ${pub.description}`);
      }
      await cmdCtx.print(lines.join("\n"));
    } catch (err) {
      await cmdCtx.print(`Error: ${(err as Error).message}`);
    }
  };

  const showHandler: SlashCommandHandler = async (cmdCtx) => {
    try {
      const name = cmdCtx.args.trim();
      if (name === "") {
        await cmdCtx.print("Usage: /agents:show <name>");
        return;
      }
      const internal = deps.registry.getInternal(name);
      if (!internal) {
        await cmdCtx.print(`Unknown agent: ${name}. Run /agents:list to see registered agents.`);
        return;
      }
      await cmdCtx.print(renderShow(internal));
    } catch (err) {
      await cmdCtx.print(`Error: ${(err as Error).message}`);
    }
  };

  return { listHandler, showHandler };
}
```

- [ ] **Step 4: Run all tests to verify they pass**

Run: `cd plugins/llm-agents && bun test test/slash.test.ts`
Expected: 9 tests pass (3 listHandler + 6 showHandler).

Then run the full plugin suite to verify nothing else regressed:

Run: `cd plugins/llm-agents && bun test`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-agents/slash.ts plugins/llm-agents/test/slash.test.ts
git commit -m "feat(llm-agents): add slash showHandler with full agent detail"
```

---

## Task 3: Wire registration and teardown into `index.ts`

**Files:**
- Modify: `plugins/llm-agents/index.ts`

- [ ] **Step 1: Add the slash imports and module-scope unregister handle**

In `plugins/llm-agents/index.ts`, add imports near the top with the other type imports:

```typescript
import type { SlashRegistryService } from "llm-contracts/public";
import { makeSlashHandlers } from "./slash.ts";
```

And add a third module-scope handle alongside `sectionHandle` / `toolUnregister`:

```typescript
let slashOffs: Array<() => void> = [];
```

(Place it right after the existing `let toolUnregister: ...` line near the top of the file.)

- [ ] **Step 2: Add `"slash:registry"` to `services.consumes`**

In the same file, update the `services.consumes` array to include `"slash:registry"`. The full array becomes:

```typescript
consumes: [
  "events:vocabulary",
  "tools:registry",
  "driver:run-conversation",
  "sessions:store",
  "prompt:registry",
  "skills:registry",
  "slash:registry",
],
```

- [ ] **Step 3: Register the slash commands at the end of `setup`, before the discovery microtask**

In `setup(ctx)`, immediately after the `if (promptSystem) { ... } else { ... }` block that registers the prompt section, and BEFORE `queueMicrotask(...)`, insert:

```typescript
    // Slash commands for user-facing registry visibility (topo-hint optional).
    try {
      const slash = ctx.useService<SlashRegistryService>("slash:registry");
      if (slash) {
        const { listHandler, showHandler } = makeSlashHandlers({ registry: handle });
        slashOffs.push(slash.register(
          { name: "agents:list", description: "List registered agents.", source: "plugin" },
          listHandler,
        ));
        slashOffs.push(slash.register(
          { name: "agents:show", description: "Show full detail for one agent.", usage: "<name>", source: "plugin" },
          showHandler,
        ));
      }
    } catch { /* slash:registry not defined in this harness — skip */ }
```

Note: `handle` here is the `RegistryHandle` created earlier in `setup` by `makeRegistryHandle(...)`. The slash handlers use both `handle.service.list()` and `handle.getInternal(name)`; the handle exposes both directly.

- [ ] **Step 4: Tear down in `stop()`**

Replace the existing `stop()` body with:

```typescript
  async stop() {
    // Idempotent cleanup on reload. The registry handle is intentionally not
    // torn down — its in-memory state is rebuilt by the next setup() call.
    try { toolUnregister?.(); } catch { /* ignore */ }
    toolUnregister = undefined;
    try { sectionHandle?.unregister(); } catch { /* ignore */ }
    sectionHandle = undefined;
    for (const off of slashOffs) { try { off(); } catch { /* ignore */ } }
    slashOffs = [];
  },
```

- [ ] **Step 5: Type-check and run the full plugin test suite**

Run: `cd plugins/llm-agents && bun test`
Expected: all tests pass (including pre-existing `index.test.ts` and the new `slash.test.ts`).

- [ ] **Step 6: Commit**

```bash
git add plugins/llm-agents/index.ts
git commit -m "feat(llm-agents): register /agents:list and /agents:show slash commands"
```

---

## Task 4: Update `CLAUDE.md` module map and invariants

**Files:**
- Modify: `plugins/llm-agents/CLAUDE.md`

- [ ] **Step 1: Add `slash.ts` to the module map**

In `plugins/llm-agents/CLAUDE.md`, inside the fenced module-map block, add this line after the `dispatch.ts` line and before `public.d.ts`:

```
slash.ts        makeSlashHandlers({ registry }) → { listHandler, showHandler } for the
                /agents:list and /agents:show plugin-source slash commands. Pure factory;
                no `ctx`. Reads via registry.service.list() and registry.getInternal().
```

- [ ] **Step 2: Add an invariant for the slash registration**

In the same file, in the "Invariants" section, append this bullet:

```
- **Slash registration is topo-hint optional.** `slash:registry` is in `services.consumes` so kaizen orders `llm-slash-commands` first when present, but the lookup is guarded with `try`/`catch` and `if (slash)`. A harness without slash commands still boots — the dispatch tool, registry, and prompt section all work; only the `/agents:list` and `/agents:show` user-facing commands are absent.
```

- [ ] **Step 3: Commit**

```bash
git add plugins/llm-agents/CLAUDE.md
git commit -m "docs(llm-agents): document slash.ts module and topo-hint slash dep"
```

---

## Task 5: Local deploy and smoke test

**Files:** none modified — verification only.

- [ ] **Step 1: Build and deploy the plugin into the local marketplace install dir**

```bash
PLUGIN=llm-agents
VERSION=$(jq -r .version plugins/$PLUGIN/package.json)
INSTALL_DIR=~/.kaizen/marketplaces/official/plugins/${PLUGIN}@${VERSION}
(cd plugins/$PLUGIN && bun build --target=bun --outfile=dist/index.js index.ts)
mkdir -p "$INSTALL_DIR/dist"
cp plugins/$PLUGIN/dist/index.js "$INSTALL_DIR/dist/index.js"
rsync -a --exclude='node_modules' --exclude='dist' plugins/$PLUGIN/ "$INSTALL_DIR/"
```

Expected: `bun build` reports a non-zero-byte `dist/index.js`; `rsync` exits 0.

- [ ] **Step 2: Launch the openai-compatible harness and run the two new commands**

```bash
kaizen --harness ./harnesses/openai-compatible.json
```

At the prompt, type:

```
/agents:list
```

Expected: either `No agents registered.` (if you have no agent files in `~/.kaizen/agents/` or `.kaizen/agents/`) OR an alphabetized markdown bullet list with `[user]` / `[project]` / `[runtime]` scope tags.

If at least one agent is listed, pick any name and run:

```
/agents:show <name>
```

Expected: the detail block (Agent / Scope / Source / Description / Tool filter / System prompt) rendered as markdown in the TUI.

If you have no agents at all and want to verify the show path, drop a sample agent file:

```bash
mkdir -p ~/.kaizen/agents
cp plugins/llm-agents/examples/code-reviewer.md ~/.kaizen/agents/
```

Restart the harness, then re-run `/agents:list` and `/agents:show code-reviewer`.

- [ ] **Step 3: Verify graceful degradation against the slash-less case**

(Optional — only run if a harness without `llm-slash-commands` exists in `harnesses/`.) Boot any such harness and confirm `llm-agents` loads cleanly with no errors emitted on `harness:error` for the slash registration. Skip this step otherwise; the topo-hint pattern is exercised at unit level by the existing index test (no slash provider = no throw).

- [ ] **Step 4: No commit required**

Smoke testing produces no file changes. Done.

---

## Self-review summary

**Spec coverage:**
- `/agents:list` catalog + scope tags + alphabetization → Task 1.
- `/agents:show <name>` with all field rules (`<runtime>` source, `none` tool filter, omitting empty sub-bullets, full system prompt fence) → Task 2.
- Topo-hint optional `slash:registry` dep with `try`/`catch` degrade → Task 3.
- Idempotent `stop()` teardown → Task 3 step 4.
- Module-map docs and invariants → Task 4.
- Local deploy + smoke → Task 5.

**Type consistency:** `makeSlashHandlers({ registry })` defined in Task 1 is used identically in Task 3. `RegistryHandle.getInternal` and `RegistryHandle.service.list` referenced in handler code match the existing `plugins/llm-agents/registry.ts` surface.

**Placeholders:** none — every code step shows complete code; every command shows expected output.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-14-agents-slash-command.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
