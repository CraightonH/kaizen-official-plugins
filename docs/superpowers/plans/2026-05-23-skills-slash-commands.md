# Skills slash commands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/skills:list` and `/skills:get <name>` slash commands to the `llm-skills` plugin so users can inspect the skills registry from the kaizen TUI.

**Architecture:** A new pure module `slash-commands.ts` in `llm-skills` registers the two namespaced commands against `slash:registry`. `index.ts` looks up `slash:registry` as a topo-hint-optional dependency (declared in `services.consumes`, looked up via `useService`, no `consumeService`) — when present, it wires the commands in `setup()` and drains the registrations in `stop()`. The new module is filesystem-free, ctx-free, and unit-testable with fake services. `/skills:list` prints name + description for every registered skill, alpha-sorted. `/skills:get <name>` prints a header (source layer derived from `baseDir`, path, token count) followed by the rendered skill body.

**Tech Stack:** TypeScript, Bun, `bun:test`, `llm-contracts` (`SkillsRegistryService`, `SlashRegistryService`, `SlashCommandContext`, `SkillManifest`).

**Spec:** `docs/superpowers/specs/2026-05-23-skills-slash-commands-design.md`

---

## File map

- **Create:** `plugins/llm-skills/slash-commands.ts` — `registerSlashCommands({ registry, slash, projectRoot, userRoot })` factory. Pure. No fs, no ctx, no module state. Returns a single cleanup function.
- **Create:** `plugins/llm-skills/test/slash-commands.test.ts` — unit tests using fake `SlashRegistryService` and fake `SkillsRegistryService`.
- **Modify:** `plugins/llm-skills/index.ts` — add `"slash:registry"` to `services.consumes`, look up the service in `setup()` via `useService`, call `registerSlashCommands(...)` when present, hold the cleanup in module scope, drain it in `stop()`.

No changes to `llm-contracts`. No changes to `claude-skills`. No new dependencies.

---

### Task 1: Add `slash:registry` to `services.consumes` (topo-hint only)

**Why first:** `services.consumes` controls plugin load order. Declaring it before any code touches the service guarantees that when `llm-slash-commands` is also in the harness, it loads first. The declaration is independent of any code that references the service, so it's a safe standalone step.

**Files:**
- Modify: `plugins/llm-skills/index.ts`

- [ ] **Step 1: Read the current `services` block** (lines around 49–62) to confirm the existing shape before editing.

- [ ] **Step 2: Add `"slash:registry"` to `consumes`**

Locate this block in `plugins/llm-skills/index.ts`:

```ts
  services: {
    provides: ["skills:registry"],
    // tools:registry is functionally optional (load_skill is only registered
    // if it's present), but it's listed here so kaizen's topo-sort orders
    // this plugin AFTER the registry's provider when one exists. Without
    // this edge, useService("tools:registry") may run before the registry
    // is provided and silently miss load_skill registration. This is an
    // acknowledged AGENTS.md edge case: the entry is a topo-sort hint, not
    // a hard boot requirement (no consumeService call backs it up).
    // prompt:registry is optional — the available-skills section is disabled
    // when absent (harness:error emitted), but the plugin otherwise runs fine.
    consumes: ["tools:registry"],
  },
```

Change the `consumes` line to:

```ts
    // slash:registry is topo-hint optional — when present, llm-slash-commands
    // loads first so the registration in setup() succeeds via useService.
    // When absent, the lookup returns undefined and the /skills:* commands
    // are simply not registered. No consumeService backs this entry.
    consumes: ["tools:registry", "slash:registry"],
```

- [ ] **Step 3: Verify the plugin still builds**

Run from the repo root:

```bash
cd plugins/llm-skills && bun build --target=bun --outfile=dist/index.js index.ts
```

Expected: build succeeds, prints bundle size, no type errors.

- [ ] **Step 4: Verify existing tests still pass**

```bash
cd plugins/llm-skills && bun test
```

Expected: all existing tests pass (nothing should regress; we only added a string to an array).

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-skills/index.ts
git commit -m "llm-skills: declare slash:registry as topo-hint optional dep"
```

---

### Task 2: Stub `slash-commands.ts` and prove the test harness wires up

**Why second:** Establish the file with the right imports and an empty export so subsequent TDD steps build incrementally on a known-good baseline. No behavior yet — just structure.

**Files:**
- Create: `plugins/llm-skills/slash-commands.ts`
- Create: `plugins/llm-skills/test/slash-commands.test.ts`

- [ ] **Step 1: Write the failing baseline test**

Create `plugins/llm-skills/test/slash-commands.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type {
  SkillManifest,
  SkillsRegistryService,
  SlashCommandHandler,
  SlashCommandManifest,
  SlashCommandContext,
  SlashRegistryEntry,
  SlashRegistryService,
} from "llm-contracts/public";
import { registerSlashCommands } from "../slash-commands.ts";

type Registered = { manifest: SlashCommandManifest; handler: SlashCommandHandler };

function makeFakeSlash() {
  const registered: Registered[] = [];
  const service: SlashRegistryService = {
    register(manifest, handler) {
      registered.push({ manifest, handler });
      return () => {
        const i = registered.findIndex((r) => r.manifest.name === manifest.name);
        if (i >= 0) registered.splice(i, 1);
      };
    },
    get(name): SlashRegistryEntry | undefined {
      const hit = registered.find((r) => r.manifest.name === name);
      return hit ? { manifest: hit.manifest, handler: hit.handler } : undefined;
    },
    list() {
      return registered.map((r) => r.manifest);
    },
  };
  return { service, registered };
}

function makeFakeRegistry(opts: {
  list?: SkillManifest[];
  bodies?: Record<string, string>;
} = {}): SkillsRegistryService {
  const entries = opts.list ?? [];
  const bodies = opts.bodies ?? {};
  return {
    list: () => entries,
    load: async (name) => {
      if (!(name in bodies)) throw new Error(`no body for ${name}`);
      return bodies[name]!;
    },
    register: () => () => {},
    rescan: async () => ({ changed: false, count: entries.length }),
  };
}

function makeCtx(args: string): { ctx: SlashCommandContext; prints: Array<{ text: string; markdown?: boolean }> } {
  const prints: Array<{ text: string; markdown?: boolean }> = [];
  const ctx: SlashCommandContext = {
    args,
    raw: `/skills:get ${args}`,
    signal: new AbortController().signal,
    emit: async () => {},
    print: async (text, opts) => {
      prints.push({ text, markdown: opts?.markdown });
    },
  };
  return { ctx, prints };
}

describe("registerSlashCommands", () => {
  test("registers /skills:list and /skills:get", () => {
    const slash = makeFakeSlash();
    const registry = makeFakeRegistry();
    const off = registerSlashCommands({
      registry,
      slash: slash.service,
      projectRoot: "/proj/.kaizen/skills",
      userRoot: "/home/u/.kaizen/skills",
    });
    expect(slash.registered.map((r) => r.manifest.name).sort()).toEqual([
      "skills:get",
      "skills:list",
    ]);
    expect(slash.registered.every((r) => r.manifest.source === "plugin")).toBe(true);
    off();
    expect(slash.registered).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd plugins/llm-skills && bun test test/slash-commands.test.ts
```

Expected: FAIL with "Cannot find module '../slash-commands.ts'" or similar resolution error.

- [ ] **Step 3: Write the minimal stub**

Create `plugins/llm-skills/slash-commands.ts`:

```ts
import type {
  SkillsRegistryService,
  SlashCommandHandler,
  SlashCommandManifest,
  SlashRegistryService,
} from "llm-contracts/public";

export interface RegisterSlashCommandsDeps {
  registry: SkillsRegistryService;
  slash: SlashRegistryService;
  projectRoot: string;
  userRoot: string;
}

export function registerSlashCommands(deps: RegisterSlashCommandsDeps): () => void {
  const { slash } = deps;
  const offs: Array<() => void> = [];

  const listManifest: SlashCommandManifest = {
    name: "skills:list",
    description: "List all registered skills",
    source: "plugin",
  };
  const listHandler: SlashCommandHandler = async (ctx) => {
    await ctx.print("(not implemented)");
  };
  offs.push(slash.register(listManifest, listHandler));

  const getManifest: SlashCommandManifest = {
    name: "skills:get",
    description: "Show a skill's source path, token count, and body",
    source: "plugin",
    usage: "<name>",
  };
  const getHandler: SlashCommandHandler = async (ctx) => {
    await ctx.print("(not implemented)");
  };
  offs.push(slash.register(getManifest, getHandler));

  return () => {
    for (const off of offs) {
      try { off(); } catch { /* idempotent */ }
    }
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd plugins/llm-skills && bun test test/slash-commands.test.ts
```

Expected: PASS — the single "registers /skills:list and /skills:get" test passes. Other tests in `test/` continue to pass.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-skills/slash-commands.ts plugins/llm-skills/test/slash-commands.test.ts
git commit -m "llm-skills: stub slash-commands module + registration test"
```

---

### Task 3: `/skills:list` — empty registry

**Files:**
- Modify: `plugins/llm-skills/slash-commands.ts`
- Modify: `plugins/llm-skills/test/slash-commands.test.ts`

- [ ] **Step 1: Write the failing test**

Append to the `describe("registerSlashCommands", () => { ... })` block in `plugins/llm-skills/test/slash-commands.test.ts`:

```ts
  test("/skills:list with empty registry prints 'No skills registered.'", async () => {
    const slash = makeFakeSlash();
    const registry = makeFakeRegistry({ list: [] });
    registerSlashCommands({
      registry,
      slash: slash.service,
      projectRoot: "/proj/.kaizen/skills",
      userRoot: "/home/u/.kaizen/skills",
    });
    const listEntry = slash.registered.find((r) => r.manifest.name === "skills:list")!;
    const { ctx, prints } = makeCtx("");
    await listEntry.handler(ctx);
    expect(prints).toHaveLength(1);
    expect(prints[0]!.text).toBe("No skills registered.");
    expect(prints[0]!.markdown).toBe(true);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd plugins/llm-skills && bun test test/slash-commands.test.ts
```

Expected: FAIL — `expect(prints[0]!.text).toBe("No skills registered.")` receives "(not implemented)".

- [ ] **Step 3: Implement `/skills:list` for the empty case**

In `plugins/llm-skills/slash-commands.ts`, also import `SkillManifest`:

```ts
import type {
  SkillManifest,
  SkillsRegistryService,
  SlashCommandHandler,
  SlashCommandManifest,
  SlashRegistryService,
} from "llm-contracts/public";
```

Replace the `listHandler` stub with a real implementation that calls a helper:

```ts
  const listHandler: SlashCommandHandler = async (ctx) => {
    await ctx.print(formatList(deps.registry.list()), { markdown: true });
  };
```

Add this helper at the bottom of the file (still inside the module, after `registerSlashCommands`):

```ts
function formatList(entries: SkillManifest[]): string {
  if (entries.length === 0) return "No skills registered.";
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  return sorted.map((e) => `\`${e.name}\` — ${e.description}`).join("\n");
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd plugins/llm-skills && bun test test/slash-commands.test.ts
```

Expected: PASS — both tests now pass.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-skills/slash-commands.ts plugins/llm-skills/test/slash-commands.test.ts
git commit -m "llm-skills: /skills:list empty-registry output"
```

---

### Task 4: `/skills:list` — populated registry, alpha sort

**Files:**
- Modify: `plugins/llm-skills/test/slash-commands.test.ts`

- [ ] **Step 1: Write the failing test**

Append to the describe block:

```ts
  test("/skills:list prints `<name>` — <description> per skill, alpha sorted", async () => {
    const slash = makeFakeSlash();
    const registry = makeFakeRegistry({
      list: [
        { name: "zeta", description: "Last one" },
        { name: "alpha", description: "First one" },
        { name: "superpowers:brainstorming", description: "Brainstorm features" },
      ],
    });
    registerSlashCommands({
      registry,
      slash: slash.service,
      projectRoot: "/proj/.kaizen/skills",
      userRoot: "/home/u/.kaizen/skills",
    });
    const listEntry = slash.registered.find((r) => r.manifest.name === "skills:list")!;
    const { ctx, prints } = makeCtx("");
    await listEntry.handler(ctx);
    expect(prints).toHaveLength(1);
    expect(prints[0]!.text).toBe(
      "`alpha` — First one\n" +
      "`superpowers:brainstorming` — Brainstorm features\n" +
      "`zeta` — Last one"
    );
    expect(prints[0]!.markdown).toBe(true);
  });
```

- [ ] **Step 2: Run the test to verify it passes**

```bash
cd plugins/llm-skills && bun test test/slash-commands.test.ts
```

Expected: PASS — `formatList` already handles this. No code change needed; this test pins the contract.

- [ ] **Step 3: Commit**

```bash
git add plugins/llm-skills/test/slash-commands.test.ts
git commit -m "llm-skills: pin /skills:list alpha-sort output format"
```

---

### Task 5: `/skills:get` — missing argument prints usage hint

**Files:**
- Modify: `plugins/llm-skills/slash-commands.ts`
- Modify: `plugins/llm-skills/test/slash-commands.test.ts`

- [ ] **Step 1: Write the failing test**

Append to the describe block:

```ts
  test("/skills:get with no args prints usage hint", async () => {
    const slash = makeFakeSlash();
    const registry = makeFakeRegistry({
      list: [{ name: "alpha", description: "Anything" }],
      bodies: { alpha: "body" },
    });
    registerSlashCommands({
      registry,
      slash: slash.service,
      projectRoot: "/proj/.kaizen/skills",
      userRoot: "/home/u/.kaizen/skills",
    });
    const getEntry = slash.registered.find((r) => r.manifest.name === "skills:get")!;
    const { ctx, prints } = makeCtx("   "); // whitespace-only counts as no arg
    await getEntry.handler(ctx);
    expect(prints).toHaveLength(1);
    expect(prints[0]!.text).toBe(
      "Usage: /skills:get <name>\nRun /skills:list to see what's available."
    );
  });
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd plugins/llm-skills && bun test test/slash-commands.test.ts
```

Expected: FAIL — `getHandler` still prints "(not implemented)".

- [ ] **Step 3: Replace the `getHandler` stub**

In `plugins/llm-skills/slash-commands.ts`, replace the `getHandler` stub with a delegation to a new helper:

```ts
  const getHandler: SlashCommandHandler = async (ctx) => {
    await handleGet(ctx, deps);
  };
```

Add the helper below `formatList` (still in the module):

```ts
async function handleGet(
  ctx: import("llm-contracts/public").SlashCommandContext,
  deps: RegisterSlashCommandsDeps,
): Promise<void> {
  const name = ctx.args.trim();
  if (!name) {
    await ctx.print("Usage: /skills:get <name>\nRun /skills:list to see what's available.");
    return;
  }
  // Remaining branches added in subsequent tasks.
  await ctx.print(`(stub: would look up ${name})`);
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd plugins/llm-skills && bun test test/slash-commands.test.ts
```

Expected: PASS — usage-hint test passes; earlier tests still pass.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-skills/slash-commands.ts plugins/llm-skills/test/slash-commands.test.ts
git commit -m "llm-skills: /skills:get usage hint on missing arg"
```

---

### Task 6: `/skills:get` — unknown name prints not-found hint

**Files:**
- Modify: `plugins/llm-skills/slash-commands.ts`
- Modify: `plugins/llm-skills/test/slash-commands.test.ts`

- [ ] **Step 1: Write the failing test**

Append to the describe block:

```ts
  test("/skills:get with unknown name prints not-found hint", async () => {
    const slash = makeFakeSlash();
    const registry = makeFakeRegistry({
      list: [{ name: "alpha", description: "Anything" }],
      bodies: { alpha: "body" },
    });
    registerSlashCommands({
      registry,
      slash: slash.service,
      projectRoot: "/proj/.kaizen/skills",
      userRoot: "/home/u/.kaizen/skills",
    });
    const getEntry = slash.registered.find((r) => r.manifest.name === "skills:get")!;
    const { ctx, prints } = makeCtx("not-a-real-skill");
    await getEntry.handler(ctx);
    expect(prints).toHaveLength(1);
    expect(prints[0]!.text).toBe(
      "Unknown skill: not-a-real-skill. Run /skills:list to see what's available."
    );
  });
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd plugins/llm-skills && bun test test/slash-commands.test.ts
```

Expected: FAIL — handler prints `(stub: would look up not-a-real-skill)`.

- [ ] **Step 3: Extend `handleGet` with the unknown-name branch**

In `plugins/llm-skills/slash-commands.ts`, replace the body of `handleGet` with:

```ts
async function handleGet(
  ctx: import("llm-contracts/public").SlashCommandContext,
  deps: RegisterSlashCommandsDeps,
): Promise<void> {
  const name = ctx.args.trim();
  if (!name) {
    await ctx.print("Usage: /skills:get <name>\nRun /skills:list to see what's available.");
    return;
  }
  const entry = deps.registry.list().find((m) => m.name === name);
  if (!entry) {
    await ctx.print(`Unknown skill: ${name}. Run /skills:list to see what's available.`);
    return;
  }
  // Body fetch + header rendering added in the next task.
  await ctx.print(`(stub: would render ${name})`);
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd plugins/llm-skills && bun test test/slash-commands.test.ts
```

Expected: PASS — unknown-name test passes; earlier tests still pass.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-skills/slash-commands.ts plugins/llm-skills/test/slash-commands.test.ts
git commit -m "llm-skills: /skills:get not-found hint on unknown name"
```

---

### Task 7: `/skills:get` — project-layer skill renders header + body

**Files:**
- Modify: `plugins/llm-skills/slash-commands.ts`
- Modify: `plugins/llm-skills/test/slash-commands.test.ts`

- [ ] **Step 1: Write the failing test**

Append to the describe block:

```ts
  test("/skills:get on a project-layer skill prints header + body", async () => {
    const projectRoot = "/proj/.kaizen/skills";
    const userRoot = "/home/u/.kaizen/skills";
    const slash = makeFakeSlash();
    const registry = makeFakeRegistry({
      list: [{
        name: "alpha",
        description: "Project alpha",
        tokens: 42,
        baseDir: `${projectRoot}/alpha`,
      }],
      bodies: { alpha: "# Alpha\n\nThe body." },
    });
    registerSlashCommands({ registry, slash: slash.service, projectRoot, userRoot });
    const getEntry = slash.registered.find((r) => r.manifest.name === "skills:get")!;
    const { ctx, prints } = makeCtx("alpha");
    await getEntry.handler(ctx);
    expect(prints).toHaveLength(1);
    expect(prints[0]!.text).toBe(
      "**alpha**\n" +
      "Source: project\n" +
      "Path: `/proj/.kaizen/skills/alpha`\n" +
      "Tokens: 42\n" +
      "\n---\n\n" +
      "# Alpha\n\nThe body."
    );
    expect(prints[0]!.markdown).toBe(true);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd plugins/llm-skills && bun test test/slash-commands.test.ts
```

Expected: FAIL — handler still prints `(stub: would render alpha)`.

- [ ] **Step 3: Implement the render branch + layer derivation**

In `plugins/llm-skills/slash-commands.ts`, replace the body of `handleGet` with:

```ts
async function handleGet(
  ctx: import("llm-contracts/public").SlashCommandContext,
  deps: RegisterSlashCommandsDeps,
): Promise<void> {
  const name = ctx.args.trim();
  if (!name) {
    await ctx.print("Usage: /skills:get <name>\nRun /skills:list to see what's available.");
    return;
  }
  const entry = deps.registry.list().find((m) => m.name === name);
  if (!entry) {
    await ctx.print(`Unknown skill: ${name}. Run /skills:list to see what's available.`);
    return;
  }
  let body: string;
  try {
    body = await deps.registry.load(name);
  } catch (e: any) {
    await ctx.print(`Failed to load skill ${name}: ${e?.message ?? String(e)}`);
    return;
  }
  const layer = deriveLayer(entry.baseDir, deps.projectRoot, deps.userRoot);
  const headerLines: string[] = [];
  headerLines.push(`**${entry.name}**`);
  headerLines.push(`Source: ${layer}`);
  if (entry.baseDir) headerLines.push(`Path: \`${entry.baseDir}\``);
  if (typeof entry.tokens === "number") headerLines.push(`Tokens: ${entry.tokens}`);
  const header = headerLines.join("\n");
  await ctx.print(`${header}\n\n---\n\n${body}`, { markdown: true });
}

function deriveLayer(baseDir: string | undefined, projectRoot: string, userRoot: string): string {
  if (!baseDir) return "programmatic";
  if (baseDir === projectRoot || baseDir.startsWith(projectRoot + "/")) return "project";
  if (baseDir === userRoot || baseDir.startsWith(userRoot + "/")) return "user";
  return "external";
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd plugins/llm-skills && bun test test/slash-commands.test.ts
```

Expected: PASS — project-layer render test passes; all earlier tests still pass.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-skills/slash-commands.ts plugins/llm-skills/test/slash-commands.test.ts
git commit -m "llm-skills: /skills:get renders header + body for project-layer skill"
```

---

### Task 8: `/skills:get` — user, programmatic, and external layers

**Why a single task:** Same code path, different inputs. Three parametric tests pin the layer-derivation contract.

**Files:**
- Modify: `plugins/llm-skills/test/slash-commands.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to the describe block:

```ts
  test("/skills:get on a user-layer skill labels it 'user'", async () => {
    const projectRoot = "/proj/.kaizen/skills";
    const userRoot = "/home/u/.kaizen/skills";
    const slash = makeFakeSlash();
    const registry = makeFakeRegistry({
      list: [{
        name: "beta",
        description: "User beta",
        tokens: 10,
        baseDir: `${userRoot}/beta`,
      }],
      bodies: { beta: "Beta body." },
    });
    registerSlashCommands({ registry, slash: slash.service, projectRoot, userRoot });
    const getEntry = slash.registered.find((r) => r.manifest.name === "skills:get")!;
    const { ctx, prints } = makeCtx("beta");
    await getEntry.handler(ctx);
    expect(prints[0]!.text).toContain("Source: user");
    expect(prints[0]!.text).toContain("Path: `/home/u/.kaizen/skills/beta`");
  });

  test("/skills:get on a programmatic skill (no baseDir) labels it 'programmatic' and omits Path", async () => {
    const slash = makeFakeSlash();
    const registry = makeFakeRegistry({
      list: [{ name: "gamma", description: "From a plugin", tokens: 5 }],
      bodies: { gamma: "Gamma body." },
    });
    registerSlashCommands({
      registry,
      slash: slash.service,
      projectRoot: "/proj/.kaizen/skills",
      userRoot: "/home/u/.kaizen/skills",
    });
    const getEntry = slash.registered.find((r) => r.manifest.name === "skills:get")!;
    const { ctx, prints } = makeCtx("gamma");
    await getEntry.handler(ctx);
    expect(prints[0]!.text).toContain("Source: programmatic");
    expect(prints[0]!.text).not.toContain("Path:");
  });

  test("/skills:get on a baseDir outside both roots labels it 'external'", async () => {
    const slash = makeFakeSlash();
    const registry = makeFakeRegistry({
      list: [{
        name: "delta",
        description: "From a plugin cache",
        baseDir: "/var/cache/kaizen/plugin-x/delta",
      }],
      bodies: { delta: "Delta body." },
    });
    registerSlashCommands({
      registry,
      slash: slash.service,
      projectRoot: "/proj/.kaizen/skills",
      userRoot: "/home/u/.kaizen/skills",
    });
    const getEntry = slash.registered.find((r) => r.manifest.name === "skills:get")!;
    const { ctx, prints } = makeCtx("delta");
    await getEntry.handler(ctx);
    expect(prints[0]!.text).toContain("Source: external");
    expect(prints[0]!.text).toContain("Path: `/var/cache/kaizen/plugin-x/delta`");
  });
```

- [ ] **Step 2: Run the tests to verify they pass**

```bash
cd plugins/llm-skills && bun test test/slash-commands.test.ts
```

Expected: PASS — `deriveLayer` already covers all three branches. These tests pin the contract.

- [ ] **Step 3: Commit**

```bash
git add plugins/llm-skills/test/slash-commands.test.ts
git commit -m "llm-skills: pin /skills:get layer labels for user/programmatic/external"
```

---

### Task 9: `/skills:get` — `registry.load()` failure is reported, not thrown

**Files:**
- Modify: `plugins/llm-skills/test/slash-commands.test.ts`

- [ ] **Step 1: Write the failing test**

Append to the describe block:

```ts
  test("/skills:get reports load() failures instead of throwing", async () => {
    const slash = makeFakeSlash();
    const registry: SkillsRegistryService = {
      list: () => [{ name: "broken", description: "Will fail to load" }],
      load: async () => { throw new Error("disk is on fire"); },
      register: () => () => {},
      rescan: async () => ({ changed: false, count: 1 }),
    };
    registerSlashCommands({
      registry,
      slash: slash.service,
      projectRoot: "/proj/.kaizen/skills",
      userRoot: "/home/u/.kaizen/skills",
    });
    const getEntry = slash.registered.find((r) => r.manifest.name === "skills:get")!;
    const { ctx, prints } = makeCtx("broken");
    await getEntry.handler(ctx); // must not throw
    expect(prints).toHaveLength(1);
    expect(prints[0]!.text).toBe("Failed to load skill broken: disk is on fire");
  });
```

- [ ] **Step 2: Run the test to verify it passes**

```bash
cd plugins/llm-skills && bun test test/slash-commands.test.ts
```

Expected: PASS — the try/catch added in Task 7 already handles this. This test pins the contract.

- [ ] **Step 3: Commit**

```bash
git add plugins/llm-skills/test/slash-commands.test.ts
git commit -m "llm-skills: pin /skills:get load-failure path"
```

---

### Task 10: Wire `registerSlashCommands` into `index.ts`

**Why now:** The module is fully tested. Now connect it to the plugin lifecycle so commands appear at runtime.

**Files:**
- Modify: `plugins/llm-skills/index.ts`

- [ ] **Step 1: Add the import and the module-scope cleanup handle**

In `plugins/llm-skills/index.ts`, add to the existing top-of-file imports:

```ts
import { registerSlashCommands } from "./slash-commands.ts";
import type { SlashRegistryService } from "llm-contracts/public";
```

Below the existing `unregisterTool` / `sectionHandle` declarations (around line 43–44), add:

```ts
let unregisterSlashCommands: (() => void) | undefined;
```

- [ ] **Step 2: Look up `slash:registry` and register in `setup()`**

In `setup(ctx)`, **after** the `tools:registry` block (the one that ends with the `ctx.log("[llm-skills] tools:registry not available; load_skill not registered")` else-branch), append:

```ts
    // /skills:list and /skills:get — registered when llm-slash-commands is present.
    // slash:registry is declared in services.consumes as a topo-hint only;
    // useService returns undefined when the harness doesn't include the plugin.
    const slash = ctx.useService<SlashRegistryService>("slash:registry");
    if (slash) {
      unregisterSlashCommands = registerSlashCommands({
        registry,
        slash,
        projectRoot,
        userRoot,
      });
    } else {
      ctx.log("[llm-skills] slash:registry not available; /skills:* commands not registered");
    }
```

- [ ] **Step 3: Drain the cleanup in `stop()`**

In the existing `stop()` body, add a try/catch line and clear the handle. The final `stop()` should look like:

```ts
  async stop() {
    try { unregisterTool?.(); } catch { /* idempotent */ }
    try { sectionHandle?.unregister(); } catch { /* idempotent */ }
    try { unregisterSlashCommands?.(); } catch { /* idempotent */ }
    unregisterTool = undefined;
    sectionHandle = undefined;
    unregisterSlashCommands = undefined;
  },
```

- [ ] **Step 4: Verify the plugin builds**

```bash
cd plugins/llm-skills && bun build --target=bun --outfile=dist/index.js index.ts
```

Expected: build succeeds, no type errors.

- [ ] **Step 5: Run all `llm-skills` tests**

```bash
cd plugins/llm-skills && bun test
```

Expected: all tests pass (slash-commands.test.ts + the previously existing tests).

- [ ] **Step 6: Commit**

```bash
git add plugins/llm-skills/index.ts
git commit -m "llm-skills: wire /skills:list and /skills:get into setup()/stop()"
```

---

### Task 11: Integration smoke — plugin loads cleanly without `slash:registry`

**Why:** Guard the topo-hint-optional contract. The plugin must not crash when `slash:registry` is absent from the harness (e.g., the claude-wrapper harness).

**Files:**
- Modify: `plugins/llm-skills/test/index.test.ts` (or whatever the existing setup-level test file is named — check first)

- [ ] **Step 1: Locate the existing setup smoke test**

```bash
ls plugins/llm-skills/test/
```

Use `index.test.ts` if it exists. If not, but `integration.test.ts` exists, use that instead. If neither exists, create `plugins/llm-skills/test/index.test.ts` with the standard fake-ctx imports already used elsewhere in the plugin (look at how other tests build a fake `ctx`).

- [ ] **Step 2: Write the failing test**

Append a new test case to the existing setup-level test file. Adjust the `ctx` factory references to match what that file already uses:

```ts
test("setup() runs cleanly when slash:registry is absent", async () => {
  // Use the same fake-ctx pattern as the surrounding tests in this file.
  // Crucially: ctx.useService("slash:registry") must return undefined.
  // ctx.useService("prompt:registry") and "tools:registry" should still be
  // resolvable to fakes (or undefined) the same way other tests in this
  // file already handle them — copy the existing pattern.
  const ctx = makeFakeCtx({ services: { /* no slash:registry */ } });
  await plugin.setup!(ctx);
  // The plugin must not throw. /skills:* simply isn't registered.
  await plugin.stop!();
});

test("setup() registers /skills:list and /skills:get when slash:registry is present", async () => {
  const recorded: string[] = [];
  const fakeSlash: SlashRegistryService = {
    register(manifest) {
      recorded.push(manifest.name);
      return () => {};
    },
    get: () => undefined,
    list: () => [],
  };
  const ctx = makeFakeCtx({ services: { "slash:registry": fakeSlash } });
  await plugin.setup!(ctx);
  expect(recorded.sort()).toEqual(["skills:get", "skills:list"]);
  await plugin.stop!();
});
```

If the existing test file does not already import `SlashRegistryService` or define a `makeFakeCtx` that supports injecting services, add the needed imports/fixtures by matching the **existing** pattern used in that file. **Do not invent a new fake-ctx framework** — read the file first and extend what's there.

- [ ] **Step 3: Run the test to verify both cases pass**

```bash
cd plugins/llm-skills && bun test
```

Expected: PASS for both new cases; all previously passing tests continue to pass.

- [ ] **Step 4: Commit**

```bash
git add plugins/llm-skills/test/
git commit -m "llm-skills: smoke-test setup with and without slash:registry"
```

---

### Task 12: Local deploy and end-to-end smoke

**Why:** The kaizen runtime prefers `dist/index.js` over source. Without rebuilding the install dir, runtime behavior won't change even though tests pass. Per `plugins/llm-skills/CLAUDE.md` "Local deploy" section.

**Files:** none (build + sync only).

- [ ] **Step 1: Determine the install dir for the current version**

```bash
jq -r .version plugins/llm-skills/package.json
```

Note the version (e.g. `0.1.2`). The install dir is:

```
~/.kaizen/marketplaces/official/plugins/llm-skills@<VERSION>/
```

- [ ] **Step 2: Build the bundle from source**

```bash
(cd plugins/llm-skills && bun build --target=bun --outfile=dist/index.js index.ts)
```

Expected: build succeeds; `plugins/llm-skills/dist/index.js` is updated.

- [ ] **Step 3: Sync source + bundle into the install dir**

Run, replacing `<VERSION>` with the version from Step 1:

```bash
PLUGIN=llm-skills
VERSION=<VERSION>
INSTALL_DIR=~/.kaizen/marketplaces/official/plugins/${PLUGIN}@${VERSION}
mkdir -p "$INSTALL_DIR/dist"
cp plugins/$PLUGIN/dist/index.js "$INSTALL_DIR/dist/index.js"
rsync -a --exclude='node_modules' --exclude='dist' plugins/$PLUGIN/ "$INSTALL_DIR/"
```

- [ ] **Step 4: Smoke-test in the local harness**

Run kaizen against the local harness:

```bash
kaizen --harness ./harnesses/local.json
```

In the TUI, type:

```
/skills:list
```

Expected: the registered skills are printed, one per line, format `` `<name>` — <description> ``. If no skills are registered in the local environment, expect "No skills registered."

Then:

```
/skills:get <name-from-the-list>
```

Expected: header (`**name**`, `Source: …`, `Path: …` if disk-backed, `Tokens: …` if known) followed by `\n---\n` then the rendered skill body. Markdown rendering should produce headings/code blocks/etc.

Exit the harness.

- [ ] **Step 5: Done — no commit (the deploy step touches no checked-in files)**

If the build or sync did modify any committed files (e.g. `dist/index.js` is tracked in this plugin), commit those:

```bash
git status plugins/llm-skills/
# If dist/index.js shows as modified and is tracked:
git add plugins/llm-skills/dist/index.js
git commit -m "llm-skills: rebuild dist with /skills:* commands"
```

If `dist/` is `.gitignore`d, skip this step.

---

## Self-review checklist (already run)

- **Spec coverage:** Every requirement from `docs/superpowers/specs/2026-05-23-skills-slash-commands-design.md` maps to a task — `/skills:list` empty + populated (Tasks 3, 4), `/skills:get` missing-arg + unknown + render + load-failure (Tasks 5, 6, 7, 9), source-layer derivation (Task 7 + 8), topo-hint-optional dep (Tasks 1, 10), absent-`slash:registry` graceful path (Tasks 10, 11), local deploy (Task 12).
- **Placeholder scan:** No TBDs, no "implement later". Task 11 has one acknowledged conditional ("Adjust to whatever fake-ctx pattern the file already uses") because the existing test file's exact fake-ctx shape isn't reproduced here — the engineer must extend the pattern that already exists rather than invent a new one. That is correct guidance for an in-place test addition.
- **Type consistency:** `RegisterSlashCommandsDeps`, `formatList`, `handleGet`, `deriveLayer` are referenced consistently across Tasks 2, 3, 5, 6, 7. `SlashCommandHandler`, `SlashCommandManifest`, `SlashCommandContext`, `SkillManifest`, `SlashRegistryService`, `SkillsRegistryService` all come from `llm-contracts/public`. The cleanup-handle name `unregisterSlashCommands` is consistent across Tasks 10 and the `stop()` body.
