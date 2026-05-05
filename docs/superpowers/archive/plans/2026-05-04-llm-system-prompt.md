# `llm-system-prompt` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the `llm-system-prompt` Kaizen plugin (Spec 14 — `docs/superpowers/specs/2026-05-04-llm-system-prompt-design.md`). The plugin owns construction of the assistant's system prompt: exposes a `prompt:system` service into which other plugins register named, prioritized sections; owns the identity/persona section sourced from `~/.kaizen/system-prompt.md` and `<project>/.kaizen/system-prompt.md`; emits `prompt:rebuilt` when the assembly changes; and is consumed by `llm-driver` as the canonical replacement for ad-hoc `request.systemPrompt` mutation in `llm:before-call`.

**Architecture:** A single trusted-tier plugin with four pure-ish modules — `registry.ts` (the SystemPromptService implementation with handle-scoped ownership), `identity.ts` (global+project file resolution with hard-coded fallback and per-render date interpolation), `slash.ts` (factories for `/prompt:show`, `/prompt:reload`, `/prompt:disable`, `/prompt:enable` handlers), and `index.ts` (plugin lifecycle: defines events, wires services, registers identity at priority 10, registers slash commands). Two driver-side changes follow: `llm-driver/loop.ts` consumes the assembly via cache keyed on generation; `llm-events/index.ts` adds `prompt:rebuilt` + `prompt:reload` to VOCAB.

**Tech Stack:** TypeScript, Bun runtime, `node:fs/promises`, `node:path`, `node:os`. Tests use `bun:test`. No external runtime deps. Slash registry consumed via existing `slash:registry` service (see `plugins/llm-slash-commands/registry.ts`).

---

## Prerequisites & Tier-for-Parallelism Map

This plan implements one new plugin (`llm-system-prompt`) and modifies two existing plugins (`llm-events`, `llm-driver`). Spec 15 (code-mode API surface) is a separate plan that depends on this one.

Tiers indicate what can run in parallel — Tier-A tasks have no inter-task imports.

- **Tier 0** (sequential, blocks all others): Task 1 (scaffold).
- **Tier 1A** (parallel, leaf modules): Task 2 (`registry.ts`), Task 3 (`identity.ts`).
- **Tier 1B** (sequential, integrates A): Task 4 (`slash.ts`), Task 5 (`public.d.ts`), Task 6 (`index.ts`).
- **Tier 2** (sequential, cross-plugin): Task 7 (event vocab in `llm-events`), Task 8 (driver integration in `llm-driver/loop.ts`), Task 9 (marketplace + harness wiring), Task 10 (e2e smoke test).

## File Structure

```
plugins/llm-system-prompt/
  index.ts              # KaizenPlugin: setup wires service, identity, slash commands, events
  registry.ts           # createRegistry(): SystemPromptService impl + RegisteredSection handles, ownership tracking, generation counter
  identity.ts           # resolveIdentity(opts): { render, reload }; reads global+project files, builds the section, exposes reload
  slash.ts              # makePromptSlashHandlers(svc, identityHandle, ui): builds the four handlers
  public.d.ts           # exported types: SystemPromptSection, SystemPromptService, RegisteredSection
  package.json
  tsconfig.json
  README.md
  test/
    registry.test.ts
    identity.test.ts
    slash.test.ts
    index.test.ts       # plugin lifecycle through a fake ctx
    fixtures/
      identity-global-only/system-prompt.md
      identity-project-only/system-prompt.md
      identity-both/global/system-prompt.md
      identity-both/project/system-prompt.md
      identity-empty/                          # neither file
```

Modified files outside the plugin:
- `plugins/llm-events/index.ts` — extend `VOCAB` with `PROMPT_REBUILT`, `PROMPT_RELOAD`.
- `plugins/llm-events/public.d.ts` — extend `Vocab` interface.
- `plugins/llm-driver/loop.ts` — replace `prepareRequest`'s `systemPromptAppend` path with `prompt:system.assemble()` consumption (transitional: keep legacy path as fallback when service is absent).
- `plugins/llm-driver/index.ts` — `consumes: ["prompt:system"]`, pass service into `runConversation` deps.
- `.kaizen/marketplace.json` — register `llm-system-prompt@0.1.0`.
- `harnesses/openai-compatible.json` — add `official/llm-system-prompt@0.1.0` to plugin list (before `llm-driver`).

Boundaries:
- `registry.ts` is the only stateful module besides `identity.ts`'s file cache. Ownership and generation tracking live exclusively here.
- `identity.ts` is stateful only in that it caches the merged file contents; date interpolation happens at every `render()` call (no cache for the date).
- `slash.ts` is a factory of pure handler functions; no top-level state.
- `index.ts` is the only place that touches `ctx`.

---

## Task 1: Scaffold `llm-system-prompt` plugin skeleton

**Files:**
- Create: `plugins/llm-system-prompt/package.json`
- Create: `plugins/llm-system-prompt/tsconfig.json`
- Create: `plugins/llm-system-prompt/README.md`
- Create: `plugins/llm-system-prompt/index.ts` (placeholder)
- Create: `plugins/llm-system-prompt/public.d.ts` (placeholder)
- Create: `plugins/llm-system-prompt/test/index.test.ts` (placeholder)

- [ ] **Step 1: Write the placeholder structure test**

Create `plugins/llm-system-prompt/test/index.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import plugin from "../index.ts";

describe("llm-system-prompt plugin manifest", () => {
  it("exports a KaizenPlugin with the correct name and apiVersion", () => {
    expect(plugin.name).toBe("llm-system-prompt");
    expect(plugin.apiVersion).toBe("3.0.0");
    expect(plugin.permissions?.tier).toBe("trusted");
  });

  it("provides prompt:system", () => {
    expect(plugin.services?.provides).toContain("prompt:system");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/llm-system-prompt && bun test test/index.test.ts`
Expected: FAIL — `Cannot find module ../index.ts` (or compile error from empty file).

- [ ] **Step 3: Write `package.json`**

Create `plugins/llm-system-prompt/package.json`:

```json
{
  "name": "llm-system-prompt",
  "version": "0.1.0",
  "description": "System-prompt assembler service (prompt:system) for the openai-compatible harness",
  "type": "module",
  "exports": { ".": "./index.ts" },
  "keywords": ["kaizen-plugin"],
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "^5.4.0"
  }
}
```

- [ ] **Step 4: Write `tsconfig.json`**

Create `plugins/llm-system-prompt/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "allowImportingTsExtensions": true,
    "types": ["bun"]
  },
  "include": ["**/*.ts"]
}
```

- [ ] **Step 5: Write placeholder `public.d.ts`**

Create `plugins/llm-system-prompt/public.d.ts`:

```typescript
export interface SystemPromptSection {
  id: string;
  priority: number;
  render(): string | Promise<string>;
  title?: string;
}

export interface RegisteredSection {
  unregister(): void;
  bumpGeneration(): void;
}

export interface SystemPromptService {
  register(section: SystemPromptSection): RegisteredSection;
  assemble(): Promise<string>;
  list(): ReadonlyArray<{ id: string; priority: number; title?: string }>;
  generation(): number;
}
```

- [ ] **Step 6: Write placeholder `index.ts`**

Create `plugins/llm-system-prompt/index.ts`:

```typescript
import type { KaizenPlugin } from "kaizen/types";

const plugin: KaizenPlugin = {
  name: "llm-system-prompt",
  apiVersion: "3.0.0",
  permissions: { tier: "trusted" },
  services: { provides: ["prompt:system"] },

  async setup(ctx) {
    ctx.defineService("prompt:system", {
      description: "Assembles the assistant's system prompt from registered sections.",
    });
    // implementation lands in Task 6
  },
};

export default plugin;
```

- [ ] **Step 7: Write `README.md`**

Create `plugins/llm-system-prompt/README.md`:

```markdown
# llm-system-prompt

Owns construction of the assistant's system prompt for the openai-compatible harness.

- Provides the `prompt:system` service: a registry where peers register named, prioritized sections.
- Owns the `identity` section sourced from `~/.kaizen/system-prompt.md` (global) merged with `<project>/.kaizen/system-prompt.md` (project override under a `## Project context` header). Falls back to a built-in default if neither exists.
- Emits `prompt:rebuilt` whenever the assembly changes; `llm-driver` consumes this to invalidate its cached prompt.
- Registers slash commands: `/prompt:show`, `/prompt:reload`, `/prompt:disable`, `/prompt:enable`.

See `docs/superpowers/specs/2026-05-04-llm-system-prompt-design.md` (Spec 14) for the full contract.
```

- [ ] **Step 8: Run tests to verify scaffold works**

Run: `cd plugins/llm-system-prompt && bun install && bun test test/index.test.ts`
Expected: PASS — both manifest assertions green.

- [ ] **Step 9: Commit**

```bash
git add plugins/llm-system-prompt
git commit -m "feat(llm-system-prompt): scaffold plugin skeleton (Spec 14)"
```

---

## Task 2: Implement `registry.ts` — SystemPromptService with handle-scoped ownership

**Files:**
- Create: `plugins/llm-system-prompt/registry.ts`
- Create: `plugins/llm-system-prompt/test/registry.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `plugins/llm-system-prompt/test/registry.test.ts`:

```typescript
import { describe, expect, it, mock } from "bun:test";
import { createRegistry } from "../registry.ts";

describe("registry — basic operations", () => {
  it("starts at generation 0 with an empty list", () => {
    const r = createRegistry({ emit: mock(() => Promise.resolve()) });
    expect(r.generation()).toBe(0);
    expect(r.list()).toEqual([]);
  });

  it("register increments generation and emits prompt:rebuilt", async () => {
    const emit = mock(async (_e: string, _p: unknown) => {});
    const r = createRegistry({ emit });
    r.register({ id: "a", priority: 100, render: () => "A" });
    expect(r.generation()).toBe(1);
    expect(emit).toHaveBeenCalledWith("prompt:rebuilt", { generation: 1 });
  });

  it("assemble returns sections sorted by priority", async () => {
    const r = createRegistry({ emit: mock(() => Promise.resolve()) });
    r.register({ id: "b", priority: 200, render: () => "BBB" });
    r.register({ id: "a", priority: 100, render: () => "AAA" });
    const out = await r.assemble();
    expect(out.indexOf("AAA")).toBeLessThan(out.indexOf("BBB"));
  });

  it("assemble applies section title as `## {title}` header", async () => {
    const r = createRegistry({ emit: mock(() => Promise.resolve()) });
    r.register({ id: "a", priority: 100, render: () => "body", title: "Heading" });
    const out = await r.assemble();
    expect(out).toContain("## Heading\nbody");
  });

  it("assemble omits sections that render empty", async () => {
    const r = createRegistry({ emit: mock(() => Promise.resolve()) });
    r.register({ id: "a", priority: 100, render: () => "" });
    r.register({ id: "b", priority: 200, render: () => "kept" });
    const out = await r.assemble();
    expect(out).not.toMatch(/^\s*$/);
    expect(out).toContain("kept");
  });

  it("assemble is memoized on generation — same string instance until generation changes", async () => {
    const r = createRegistry({ emit: mock(() => Promise.resolve()) });
    r.register({ id: "a", priority: 100, render: () => "AAA" });
    const s1 = await r.assemble();
    const s2 = await r.assemble();
    expect(s1).toBe(s2); // identity, not equality
  });
});

describe("registry — handle-scoped ownership", () => {
  it("handle.unregister removes the section and bumps generation", async () => {
    const emit = mock(async (_e: string, _p: unknown) => {});
    const r = createRegistry({ emit });
    const h = r.register({ id: "a", priority: 100, render: () => "AAA" });
    const genAfterRegister = r.generation();
    h.unregister();
    expect(r.generation()).toBeGreaterThan(genAfterRegister);
    expect(r.list()).toEqual([]);
  });

  it("handle.unregister is idempotent — second call is no-op", () => {
    const r = createRegistry({ emit: mock(() => Promise.resolve()) });
    const h = r.register({ id: "a", priority: 100, render: () => "AAA" });
    h.unregister();
    const gen = r.generation();
    h.unregister();
    expect(r.generation()).toBe(gen);
  });

  it("handle.bumpGeneration increments generation and emits", async () => {
    const emit = mock(async (_e: string, _p: unknown) => {});
    const r = createRegistry({ emit });
    const h = r.register({ id: "a", priority: 100, render: () => "AAA" });
    emit.mockClear();
    h.bumpGeneration();
    expect(emit).toHaveBeenCalledWith("prompt:rebuilt", expect.any(Object));
  });

  it("handle.bumpGeneration after unregister is a no-op", () => {
    const r = createRegistry({ emit: mock(() => Promise.resolve()) });
    const h = r.register({ id: "a", priority: 100, render: () => "AAA" });
    h.unregister();
    const gen = r.generation();
    h.bumpGeneration();
    expect(r.generation()).toBe(gen);
  });

  it("re-registering the same id from the same handle replaces render fn", async () => {
    const r = createRegistry({ emit: mock(() => Promise.resolve()) });
    r.register({ id: "a", priority: 100, render: () => "old" });
    r.register({ id: "a", priority: 100, render: () => "new" });
    const out = await r.assemble();
    expect(out).toContain("new");
    expect(out).not.toContain("old");
  });

  it("registering an id already owned by a live handle throws", () => {
    const r = createRegistry({ emit: mock(() => Promise.resolve()) });
    const h1 = r.register({ id: "a", priority: 100, render: () => "h1" });
    expect(() => {
      r.register({ id: "a", priority: 100, render: () => "h2" });
    }).toThrow(/already registered/);
    h1.unregister();
    // After unregister, the id is free to claim again.
    expect(() => {
      r.register({ id: "a", priority: 100, render: () => "h2" });
    }).not.toThrow();
  });
});

describe("registry — disable/enable (diagnostic)", () => {
  it("disabled section renders empty without leaving the registry", async () => {
    const r = createRegistry({ emit: mock(() => Promise.resolve()) });
    r.register({ id: "a", priority: 100, render: () => "AAA" });
    r.disable("a");
    const out = await r.assemble();
    expect(out).not.toContain("AAA");
    expect(r.list().map((s) => s.id)).toContain("a");
  });

  it("enable restores rendering", async () => {
    const r = createRegistry({ emit: mock(() => Promise.resolve()) });
    r.register({ id: "a", priority: 100, render: () => "AAA" });
    r.disable("a");
    r.enable("a");
    const out = await r.assemble();
    expect(out).toContain("AAA");
  });
});

describe("registry — render error handling", () => {
  it("a render() that throws is rendered as an inline error block, not propagated", async () => {
    const r = createRegistry({ emit: mock(() => Promise.resolve()) });
    r.register({ id: "broken", priority: 100, render: () => { throw new Error("boom"); } });
    r.register({ id: "ok", priority: 200, render: () => "OK" });
    const out = await r.assemble();
    expect(out).toContain("OK");
    expect(out).toContain("broken");
    expect(out).toContain("boom");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd plugins/llm-system-prompt && bun test test/registry.test.ts`
Expected: FAIL — `Cannot find module ../registry.ts`.

- [ ] **Step 3: Implement `registry.ts`**

Create `plugins/llm-system-prompt/registry.ts`:

```typescript
import type {
  RegisteredSection,
  SystemPromptSection,
  SystemPromptService,
} from "./public";

interface RegistryEntry {
  section: SystemPromptSection;
  /** Generation at which this entry was last (re-)registered or bumped. */
  registeredAtGen: number;
  /** Order of registration; tiebreak for equal priorities. */
  registrationOrder: number;
  /** Diagnostic toggle — when true, render() is skipped (renders ""). */
  disabled: boolean;
  /** True after handle.unregister() — used to make handle ops idempotent. */
  removed: boolean;
}

export interface CreateRegistryOptions {
  emit: (event: string, payload: unknown) => void | Promise<void>;
}

export interface SystemPromptServiceImpl extends SystemPromptService {
  /** Diagnostic — used by /prompt:disable. */
  disable(id: string): void;
  /** Diagnostic — used by /prompt:enable. */
  enable(id: string): void;
}

export function createRegistry(opts: CreateRegistryOptions): SystemPromptServiceImpl {
  const map = new Map<string, RegistryEntry>();
  let generation = 0;
  let order = 0;
  let cachedAssembly: string | null = null;
  let cachedAtGen = -1;

  function bump(): void {
    generation += 1;
    cachedAssembly = null;
    void opts.emit("prompt:rebuilt", { generation });
  }

  function register(section: SystemPromptSection): RegisteredSection {
    const existing = map.get(section.id);
    if (existing && !existing.removed) {
      // Owner check: a live handle for this id already exists.
      // Re-registration via the *same* handle path is allowed and is treated
      // as an update (replace render fn). Distinguishing "same caller" is
      // not possible from in-process JS without per-caller capabilities, so
      // the convention is: any caller can replace the render fn for an id
      // it can already reference, but the handle for the *prior* registration
      // is invalidated. To prevent silent overwrites, we throw — callers who
      // genuinely want to replace must unregister first.
      throw new Error(
        `prompt:system: section "${section.id}" already registered; unregister via the prior handle before re-registering`,
      );
    }
    const entry: RegistryEntry = {
      section,
      registeredAtGen: generation + 1,
      registrationOrder: order++,
      disabled: false,
      removed: false,
    };
    map.set(section.id, entry);
    bump();

    const handle: RegisteredSection = {
      unregister(): void {
        if (entry.removed) return;
        entry.removed = true;
        if (map.get(section.id) === entry) map.delete(section.id);
        bump();
      },
      bumpGeneration(): void {
        if (entry.removed) return;
        bump();
      },
    };
    return handle;
  }

  function disable(id: string): void {
    const e = map.get(id);
    if (!e || e.disabled) return;
    e.disabled = true;
    bump();
  }

  function enable(id: string): void {
    const e = map.get(id);
    if (!e || !e.disabled) return;
    e.disabled = false;
    bump();
  }

  function list(): ReadonlyArray<{ id: string; priority: number; title?: string }> {
    return Array.from(map.values()).map((e) => ({
      id: e.section.id,
      priority: e.section.priority,
      ...(e.section.title !== undefined ? { title: e.section.title } : {}),
    }));
  }

  async function assemble(): Promise<string> {
    if (cachedAssembly !== null && cachedAtGen === generation) return cachedAssembly;

    const ordered = Array.from(map.values())
      .filter((e) => !e.removed)
      .sort((a, b) => {
        if (a.section.priority !== b.section.priority) {
          return a.section.priority - b.section.priority;
        }
        return a.registrationOrder - b.registrationOrder;
      });

    const parts: string[] = [];
    for (const e of ordered) {
      if (e.disabled) continue;
      let body: string;
      try {
        const r = e.section.render();
        body = r instanceof Promise ? await r : r;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        body = `<!-- prompt:system render error in "${e.section.id}": ${msg} -->`;
      }
      if (!body || body.length === 0) continue;
      const heading = e.section.title ? `## ${e.section.title}\n` : "";
      parts.push(`${heading}${body}`);
    }

    cachedAssembly = parts.join("\n\n");
    cachedAtGen = generation;
    return cachedAssembly;
  }

  return {
    register,
    assemble,
    list,
    generation: () => generation,
    disable,
    enable,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd plugins/llm-system-prompt && bun test test/registry.test.ts`
Expected: PASS — all registry suites green.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-system-prompt/registry.ts plugins/llm-system-prompt/test/registry.test.ts
git commit -m "feat(llm-system-prompt): registry with handle-scoped ownership and generation cache"
```

---

## Task 3: Implement `identity.ts` — global+project file resolution with fallback

**Files:**
- Create: `plugins/llm-system-prompt/identity.ts`
- Create: `plugins/llm-system-prompt/test/identity.test.ts`
- Create: `plugins/llm-system-prompt/test/fixtures/identity-global-only/system-prompt.md`
- Create: `plugins/llm-system-prompt/test/fixtures/identity-project-only/system-prompt.md`
- Create: `plugins/llm-system-prompt/test/fixtures/identity-both/global/system-prompt.md`
- Create: `plugins/llm-system-prompt/test/fixtures/identity-both/project/system-prompt.md`

- [ ] **Step 1: Create fixtures**

Create `plugins/llm-system-prompt/test/fixtures/identity-global-only/system-prompt.md`:

```markdown
You are GlobalAssistant. Answer concisely.
```

Create `plugins/llm-system-prompt/test/fixtures/identity-project-only/system-prompt.md`:

```markdown
This repo is a Rust kernel. Treat unsafe blocks with extra care.
```

Create `plugins/llm-system-prompt/test/fixtures/identity-both/global/system-prompt.md`:

```markdown
You are GlobalAssistant. Answer concisely.
```

Create `plugins/llm-system-prompt/test/fixtures/identity-both/project/system-prompt.md`:

```markdown
This repo is a Rust kernel. Treat unsafe blocks with extra care.
```

- [ ] **Step 2: Write the failing tests**

Create `plugins/llm-system-prompt/test/identity.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { resolveIdentity, FALLBACK_PREFIX } from "../identity.ts";

const FIXTURES = join(import.meta.dir, "fixtures");

describe("identity — file resolution", () => {
  it("returns the global file body when only the global file exists", async () => {
    const r = resolveIdentity({
      globalPath: join(FIXTURES, "identity-global-only", "system-prompt.md"),
      projectPath: join(FIXTURES, "does-not-exist", "system-prompt.md"),
    });
    await r.reload();
    const out = await r.section.render();
    expect(out).toContain("GlobalAssistant");
    expect(out).not.toContain("Project context");
  });

  it("returns the project file body when only the project file exists", async () => {
    const r = resolveIdentity({
      globalPath: join(FIXTURES, "does-not-exist", "system-prompt.md"),
      projectPath: join(FIXTURES, "identity-project-only", "system-prompt.md"),
    });
    await r.reload();
    const out = await r.section.render();
    expect(out).toContain("Rust kernel");
    expect(out).not.toContain("Project context"); // no header when global is absent
  });

  it("concatenates both with a `## Project context` header when both exist", async () => {
    const r = resolveIdentity({
      globalPath: join(FIXTURES, "identity-both/global/system-prompt.md"),
      projectPath: join(FIXTURES, "identity-both/project/system-prompt.md"),
    });
    await r.reload();
    const out = await r.section.render();
    const globalIdx = out.indexOf("GlobalAssistant");
    const headerIdx = out.indexOf("## Project context");
    const projectIdx = out.indexOf("Rust kernel");
    expect(globalIdx).toBeGreaterThanOrEqual(0);
    expect(headerIdx).toBeGreaterThan(globalIdx);
    expect(projectIdx).toBeGreaterThan(headerIdx);
  });

  it("uses the hard-coded fallback when neither file exists", async () => {
    const r = resolveIdentity({
      globalPath: join(FIXTURES, "does-not-exist", "system-prompt.md"),
      projectPath: join(FIXTURES, "does-not-exist", "system-prompt.md"),
    });
    await r.reload();
    const out = await r.section.render();
    expect(out).toContain(FALLBACK_PREFIX);
  });
});

describe("identity — date interpolation", () => {
  it("the fallback contains today's ISO date (YYYY-MM-DD)", async () => {
    const r = resolveIdentity({
      globalPath: join(FIXTURES, "does-not-exist", "system-prompt.md"),
      projectPath: join(FIXTURES, "does-not-exist", "system-prompt.md"),
    });
    await r.reload();
    const out = await r.section.render();
    const today = new Date().toISOString().slice(0, 10);
    expect(out).toContain(today);
  });
});

describe("identity — section shape", () => {
  it("registers id 'identity' at priority 10 with no title", async () => {
    const r = resolveIdentity({
      globalPath: join(FIXTURES, "identity-global-only", "system-prompt.md"),
      projectPath: join(FIXTURES, "does-not-exist", "system-prompt.md"),
    });
    expect(r.section.id).toBe("identity");
    expect(r.section.priority).toBe(10);
    expect(r.section.title).toBeUndefined();
  });
});

describe("identity — env disable", () => {
  it("KAIZEN_SYSTEM_PROMPT_DISABLE=1 renders empty", async () => {
    const r = resolveIdentity({
      globalPath: join(FIXTURES, "identity-global-only", "system-prompt.md"),
      projectPath: join(FIXTURES, "does-not-exist", "system-prompt.md"),
      env: { KAIZEN_SYSTEM_PROMPT_DISABLE: "1" },
    });
    await r.reload();
    const out = await r.section.render();
    expect(out).toBe("");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd plugins/llm-system-prompt && bun test test/identity.test.ts`
Expected: FAIL — `Cannot find module ../identity.ts`.

- [ ] **Step 4: Implement `identity.ts`**

Create `plugins/llm-system-prompt/identity.ts`:

```typescript
import { readFile } from "node:fs/promises";
import type { SystemPromptSection } from "./public";

export const FALLBACK_PREFIX =
  "You are a helpful assistant running locally via the kaizen openai-compatible harness.";

const FALLBACK_TEMPLATE = (date: string): string =>
  `${FALLBACK_PREFIX} Today is ${date}. The user prefers concise answers and direct action; avoid unnecessary preamble. When tools are available, prefer calling them over guessing. When skills are listed below, load them on demand rather than guessing their contents.`;

const PROJECT_HEADER = "## Project context";

export interface ResolveIdentityOptions {
  globalPath: string;
  projectPath: string;
  /** Override env for tests. Defaults to process.env. */
  env?: Record<string, string | undefined>;
}

export interface IdentityHandle {
  section: SystemPromptSection;
  /** Re-read both files from disk. Called at startup and on /prompt:reload. */
  reload(): Promise<void>;
}

async function readOrUndefined(path: string): Promise<string | undefined> {
  try {
    const t = await readFile(path, "utf8");
    return t.trim().length === 0 ? undefined : t.replace(/\s+$/, "");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

export function resolveIdentity(opts: ResolveIdentityOptions): IdentityHandle {
  const env = opts.env ?? process.env;
  let cachedGlobal: string | undefined;
  let cachedProject: string | undefined;

  async function reload(): Promise<void> {
    cachedGlobal = await readOrUndefined(opts.globalPath);
    cachedProject = await readOrUndefined(opts.projectPath);
  }

  function render(): string {
    if (env.KAIZEN_SYSTEM_PROMPT_DISABLE === "1") return "";

    const today = new Date().toISOString().slice(0, 10);

    if (cachedGlobal && cachedProject) {
      return `${cachedGlobal}\n\n${PROJECT_HEADER}\n\n${cachedProject}`;
    }
    if (cachedGlobal) return cachedGlobal;
    if (cachedProject) return cachedProject;

    return FALLBACK_TEMPLATE(today);
  }

  const section: SystemPromptSection = {
    id: "identity",
    priority: 10,
    render,
  };

  return { section, reload };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd plugins/llm-system-prompt && bun test test/identity.test.ts`
Expected: PASS — all identity suites green.

- [ ] **Step 6: Commit**

```bash
git add plugins/llm-system-prompt/identity.ts plugins/llm-system-prompt/test/identity.test.ts plugins/llm-system-prompt/test/fixtures
git commit -m "feat(llm-system-prompt): identity section with global+project merge and fallback"
```

---

## Task 4: Implement `slash.ts` — `/prompt:show`, `/prompt:reload`, `/prompt:disable`, `/prompt:enable`

**Files:**
- Create: `plugins/llm-system-prompt/slash.ts`
- Create: `plugins/llm-system-prompt/test/slash.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `plugins/llm-system-prompt/test/slash.test.ts`:

```typescript
import { describe, expect, it, mock } from "bun:test";
import { createRegistry } from "../registry.ts";
import { makePromptSlashHandlers } from "../slash.ts";

function makeCtx(args = "") {
  const printed: string[] = [];
  return {
    args,
    raw: `/prompt:show ${args}`.trim(),
    signal: new AbortController().signal,
    emit: mock(async () => {}),
    print: mock(async (t: string) => { printed.push(t); }),
    printed,
  };
}

describe("slash /prompt:show", () => {
  it("prints assembled prompt with section headers when no args", async () => {
    const reg = createRegistry({ emit: mock(() => Promise.resolve()) });
    reg.register({ id: "identity", priority: 10, render: () => "I AM" });
    reg.register({ id: "x:y", priority: 100, render: () => "BODY", title: "TitleY" });

    const handlers = makePromptSlashHandlers({
      registry: reg,
      reloadIdentity: async () => {},
    });

    const ctx = makeCtx("");
    await handlers.show(ctx);
    const out = ctx.printed.join("\n");
    expect(out).toContain("[identity, p=10]");
    expect(out).toContain("I AM");
    expect(out).toContain("[x:y, p=100, title=TitleY]");
    expect(out).toContain("BODY");
  });

  it("--stats appends per-section length and rebuild count", async () => {
    const reg = createRegistry({ emit: mock(() => Promise.resolve()) });
    reg.register({ id: "a", priority: 100, render: () => "AAAAA" });

    const handlers = makePromptSlashHandlers({
      registry: reg,
      reloadIdentity: async () => {},
    });

    const ctx = makeCtx("--stats");
    await handlers.show(ctx);
    const out = ctx.printed.join("\n");
    expect(out).toMatch(/a:\s*\d+ chars/);
    expect(out).toMatch(/generation: \d+/);
  });
});

describe("slash /prompt:reload", () => {
  it("calls the reload callback and prints confirmation", async () => {
    const reg = createRegistry({ emit: mock(() => Promise.resolve()) });
    const reload = mock(async () => {});

    const handlers = makePromptSlashHandlers({
      registry: reg,
      reloadIdentity: reload,
    });

    const ctx = makeCtx("");
    await handlers.reload(ctx);
    expect(reload).toHaveBeenCalled();
    expect(ctx.printed.join("\n")).toMatch(/reloaded/i);
  });
});

describe("slash /prompt:disable + /prompt:enable", () => {
  it("disable hides the section's body from /prompt:show", async () => {
    const reg = createRegistry({ emit: mock(() => Promise.resolve()) });
    reg.register({ id: "a", priority: 100, render: () => "SHOULD-NOT-APPEAR" });

    const handlers = makePromptSlashHandlers({
      registry: reg,
      reloadIdentity: async () => {},
    });

    await handlers.disable(makeCtx("a"));
    const ctx = makeCtx("");
    await handlers.show(ctx);
    expect(ctx.printed.join("\n")).not.toContain("SHOULD-NOT-APPEAR");
  });

  it("enable restores the section", async () => {
    const reg = createRegistry({ emit: mock(() => Promise.resolve()) });
    reg.register({ id: "a", priority: 100, render: () => "RESTORED" });

    const handlers = makePromptSlashHandlers({
      registry: reg,
      reloadIdentity: async () => {},
    });

    await handlers.disable(makeCtx("a"));
    await handlers.enable(makeCtx("a"));
    const ctx = makeCtx("");
    await handlers.show(ctx);
    expect(ctx.printed.join("\n")).toContain("RESTORED");
  });

  it("disable with unknown id prints a friendly error", async () => {
    const reg = createRegistry({ emit: mock(() => Promise.resolve()) });

    const handlers = makePromptSlashHandlers({
      registry: reg,
      reloadIdentity: async () => {},
    });

    const ctx = makeCtx("nope");
    await handlers.disable(ctx);
    expect(ctx.printed.join("\n")).toMatch(/no section/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd plugins/llm-system-prompt && bun test test/slash.test.ts`
Expected: FAIL — `Cannot find module ../slash.ts`.

- [ ] **Step 3: Implement `slash.ts`**

Create `plugins/llm-system-prompt/slash.ts`:

```typescript
import type { SystemPromptServiceImpl } from "./registry.ts";

interface SlashCtx {
  args: string;
  raw: string;
  signal: AbortSignal;
  emit: (event: string, payload: unknown) => Promise<void>;
  print: (text: string) => Promise<void>;
}

export interface PromptSlashOptions {
  registry: SystemPromptServiceImpl;
  reloadIdentity: () => Promise<void>;
}

export interface PromptSlashHandlers {
  show: (ctx: SlashCtx) => Promise<void>;
  reload: (ctx: SlashCtx) => Promise<void>;
  disable: (ctx: SlashCtx) => Promise<void>;
  enable: (ctx: SlashCtx) => Promise<void>;
}

export function makePromptSlashHandlers(opts: PromptSlashOptions): PromptSlashHandlers {
  const { registry, reloadIdentity } = opts;

  async function show(ctx: SlashCtx): Promise<void> {
    const stats = ctx.args.trim() === "--stats";
    const sections = registry.list().slice().sort((a, b) => a.priority - b.priority);

    const lines: string[] = [];
    lines.push(`# system prompt (generation: ${registry.generation()})`);
    lines.push("");

    for (const s of sections) {
      const header = s.title ? `[${s.id}, p=${s.priority}, title=${s.title}]` : `[${s.id}, p=${s.priority}]`;
      lines.push(`### ${header}`);
      // Render this section in isolation by calling assemble() and slicing —
      // simpler for v0 is to re-call render() through the registry helper.
      const body = await registry.renderSection(s.id);
      if (body === undefined) {
        lines.push("(disabled or unknown)");
      } else {
        lines.push(body);
      }
      if (stats) lines.push(`-- ${s.id}: ${body?.length ?? 0} chars --`);
      lines.push("");
    }

    if (stats) lines.push(`generation: ${registry.generation()}`);
    await ctx.print(lines.join("\n"));
  }

  async function reload(ctx: SlashCtx): Promise<void> {
    await reloadIdentity();
    // Identity is registered through the registry; bumping is handled by the
    // identity reload path inside index.ts via handle.bumpGeneration().
    await ctx.print("identity reloaded");
  }

  async function disable(ctx: SlashCtx): Promise<void> {
    const id = ctx.args.trim();
    if (!id) {
      await ctx.print("usage: /prompt:disable <section-id>");
      return;
    }
    if (!registry.has(id)) {
      await ctx.print(`no section with id "${id}"`);
      return;
    }
    registry.disable(id);
    await ctx.print(`disabled section "${id}"`);
  }

  async function enable(ctx: SlashCtx): Promise<void> {
    const id = ctx.args.trim();
    if (!id) {
      await ctx.print("usage: /prompt:enable <section-id>");
      return;
    }
    if (!registry.has(id)) {
      await ctx.print(`no section with id "${id}"`);
      return;
    }
    registry.enable(id);
    await ctx.print(`enabled section "${id}"`);
  }

  return { show, reload, disable, enable };
}
```

- [ ] **Step 4: Extend `registry.ts` with `has()` and `renderSection()`**

The slash handlers above call two helpers not yet present on the registry. Add them.

In `plugins/llm-system-prompt/registry.ts`, add to the `SystemPromptServiceImpl` interface:

```typescript
export interface SystemPromptServiceImpl extends SystemPromptService {
  disable(id: string): void;
  enable(id: string): void;
  has(id: string): boolean;
  /** Render a single section (or undefined if absent/disabled). For diagnostics. */
  renderSection(id: string): Promise<string | undefined>;
}
```

And add the implementations at the bottom of `createRegistry` (just before the `return`):

```typescript
  function has(id: string): boolean {
    const e = map.get(id);
    return Boolean(e && !e.removed);
  }

  async function renderSection(id: string): Promise<string | undefined> {
    const e = map.get(id);
    if (!e || e.removed || e.disabled) return undefined;
    try {
      const r = e.section.render();
      return r instanceof Promise ? await r : r;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `<!-- render error: ${msg} -->`;
    }
  }
```

And include them in the returned object:

```typescript
  return {
    register,
    assemble,
    list,
    generation: () => generation,
    disable,
    enable,
    has,
    renderSection,
  };
```

- [ ] **Step 5: Run all tests**

Run: `cd plugins/llm-system-prompt && bun test`
Expected: PASS — registry, identity, and slash suites all green.

- [ ] **Step 6: Commit**

```bash
git add plugins/llm-system-prompt/slash.ts plugins/llm-system-prompt/test/slash.test.ts plugins/llm-system-prompt/registry.ts
git commit -m "feat(llm-system-prompt): /prompt:show, /prompt:reload, /prompt:disable, /prompt:enable"
```

---

## Task 5: Finalize `public.d.ts` exports

**Files:**
- Modify: `plugins/llm-system-prompt/public.d.ts`

- [ ] **Step 1: Write the public surface tests**

Add to `plugins/llm-system-prompt/test/index.test.ts` (append to existing file):

```typescript
import type {
  SystemPromptSection,
  SystemPromptService,
  RegisteredSection,
} from "../public";

describe("public.d.ts type surface", () => {
  it("exports SystemPromptSection / SystemPromptService / RegisteredSection", () => {
    // Compile-time check: if this file compiles, the types are exported.
    const _section: SystemPromptSection = {
      id: "x",
      priority: 100,
      render: () => "",
    };
    const _h: RegisteredSection = { unregister: () => {}, bumpGeneration: () => {} };
    const _svc = null as unknown as SystemPromptService;
    expect(_section.id).toBe("x");
    expect(_h).toBeTruthy();
    expect(_svc).toBeNull();
  });
});
```

- [ ] **Step 2: Verify `public.d.ts` is the canonical contract**

`public.d.ts` was scaffolded in Task 1 with the right shape. Re-confirm it exactly matches Spec 14 § *Service contract*:

```typescript
export interface SystemPromptSection {
  id: string;
  priority: number;
  render(): string | Promise<string>;
  title?: string;
}

export interface RegisteredSection {
  unregister(): void;
  bumpGeneration(): void;
}

export interface SystemPromptService {
  register(section: SystemPromptSection): RegisteredSection;
  assemble(): Promise<string>;
  list(): ReadonlyArray<{ id: string; priority: number; title?: string }>;
  generation(): number;
}
```

- [ ] **Step 3: Run tests**

Run: `cd plugins/llm-system-prompt && bun test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add plugins/llm-system-prompt/public.d.ts plugins/llm-system-prompt/test/index.test.ts
git commit -m "feat(llm-system-prompt): finalize public.d.ts and type surface tests"
```

---

## Task 6: Wire `index.ts` — plugin lifecycle, service, identity, slash

**Files:**
- Modify: `plugins/llm-system-prompt/index.ts`
- Modify: `plugins/llm-system-prompt/test/index.test.ts`

- [ ] **Step 1: Write the lifecycle integration test**

Append to `plugins/llm-system-prompt/test/index.test.ts`:

```typescript
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function makeFakeCtx() {
  const services: Record<string, unknown> = {};
  const provided: Record<string, unknown> = {};
  const consumed: string[] = [];
  const events: string[] = [];
  const emitted: Array<{ name: string; payload: unknown }> = [];
  const slashRegistrations: Array<{ name: string; description: string }> = [];

  const slashRegistry = {
    register(manifest: { name: string; description: string }, _h: unknown) {
      slashRegistrations.push(manifest);
      return () => {};
    },
    get: () => undefined,
    list: () => [],
  };

  return {
    cwd: tmpdir(),
    env: {} as Record<string, string | undefined>,
    log: (_m: string) => {},
    defineService: (n: string, _o: unknown) => { services[n] = _o; },
    provideService: <T,>(n: string, v: T) => { provided[n] = v; },
    consumeService: (n: string) => { consumed.push(n); },
    useService: (n: string) => {
      if (n === "slash:registry") return slashRegistry;
      return undefined;
    },
    defineEvent: (n: string) => { events.push(n); },
    emit: async (n: string, p: unknown) => { emitted.push({ name: n, payload: p }); },
    on: (_n: string, _h: unknown) => {},
    config: {},
    services, provided, consumed, events, emitted, slashRegistrations, slashRegistry,
  };
}

describe("index.ts — plugin lifecycle", () => {
  it("setup defines and provides prompt:system", async () => {
    const ctx = makeFakeCtx();
    await plugin.setup!(ctx as any);
    expect(ctx.consumed).toContain("slash:registry");
    expect("prompt:system" in ctx.services).toBe(true);
    expect("prompt:system" in ctx.provided).toBe(true);
  });

  it("setup defines prompt:rebuilt and prompt:reload events", async () => {
    const ctx = makeFakeCtx();
    await plugin.setup!(ctx as any);
    expect(ctx.events).toContain("prompt:rebuilt");
    expect(ctx.events).toContain("prompt:reload");
  });

  it("setup registers identity section at priority 10", async () => {
    const ctx = makeFakeCtx();
    await plugin.setup!(ctx as any);
    const svc = ctx.provided["prompt:system"] as any;
    const sections = svc.list();
    expect(sections.find((s: any) => s.id === "identity")).toBeTruthy();
    expect(sections.find((s: any) => s.id === "identity")!.priority).toBe(10);
  });

  it("setup registers /prompt:show, /prompt:reload, /prompt:disable, /prompt:enable", async () => {
    const ctx = makeFakeCtx();
    await plugin.setup!(ctx as any);
    const names = ctx.slashRegistrations.map((m) => m.name).sort();
    expect(names).toEqual(["prompt:disable", "prompt:enable", "prompt:reload", "prompt:show"]);
  });

  it("setup with global file present picks it up", async () => {
    const dir = join(tmpdir(), `kaizen-sysprompt-test-${Date.now()}`);
    mkdirSync(join(dir, "global"), { recursive: true });
    writeFileSync(join(dir, "global", "system-prompt.md"), "GLOBAL-MARKER");

    const ctx = makeFakeCtx();
    ctx.env.KAIZEN_SYSTEM_PROMPT_GLOBAL = join(dir, "global", "system-prompt.md");
    await plugin.setup!(ctx as any);
    const svc = ctx.provided["prompt:system"] as any;
    const out = await svc.assemble();
    expect(out).toContain("GLOBAL-MARKER");
    rmSync(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/llm-system-prompt && bun test test/index.test.ts`
Expected: FAIL — index.ts is still the placeholder.

- [ ] **Step 3: Implement `index.ts`**

Replace `plugins/llm-system-prompt/index.ts` with:

```typescript
import { homedir } from "node:os";
import { join } from "node:path";
import type { KaizenPlugin } from "kaizen/types";
import { createRegistry, type SystemPromptServiceImpl } from "./registry.ts";
import { resolveIdentity } from "./identity.ts";
import { makePromptSlashHandlers } from "./slash.ts";
import type { SystemPromptService } from "./public";

function readEnv(ctx: any, key: string): string | undefined {
  const fromCtx = ctx.env && typeof ctx.env === "object" ? (ctx.env as any)[key] : undefined;
  if (typeof fromCtx === "string" && fromCtx.length > 0) return fromCtx;
  const fromProc = process.env[key];
  return fromProc && fromProc.length > 0 ? fromProc : undefined;
}

function resolveGlobalPath(ctx: any): string {
  const override = readEnv(ctx, "KAIZEN_SYSTEM_PROMPT_GLOBAL");
  if (override !== undefined) return override; // empty string means "no global" — handled by readOrUndefined
  const home = readEnv(ctx, "HOME") ?? homedir();
  return join(home, ".kaizen", "system-prompt.md");
}

function resolveProjectPath(ctx: any): string {
  const override = readEnv(ctx, "KAIZEN_SYSTEM_PROMPT_PROJECT");
  if (override !== undefined) return override;
  const cwd = typeof ctx.cwd === "string" && ctx.cwd.length > 0 ? ctx.cwd : process.cwd();
  return join(cwd, ".kaizen", "system-prompt.md");
}

const plugin: KaizenPlugin = {
  name: "llm-system-prompt",
  apiVersion: "3.0.0",
  permissions: { tier: "trusted" },
  services: {
    provides: ["prompt:system"],
    consumes: ["slash:registry"],
  },

  async setup(ctx) {
    ctx.consumeService("slash:registry");

    ctx.defineEvent("prompt:rebuilt");
    ctx.defineEvent("prompt:reload");

    const registry: SystemPromptServiceImpl = createRegistry({
      emit: (event, payload) => ctx.emit(event, payload),
    });

    ctx.defineService("prompt:system", {
      description: "Assembles the assistant's system prompt from registered sections.",
    });
    ctx.provideService<SystemPromptService>("prompt:system", registry);

    // Identity section.
    const identity = resolveIdentity({
      globalPath: resolveGlobalPath(ctx),
      projectPath: resolveProjectPath(ctx),
      env: (ctx.env ?? process.env) as Record<string, string | undefined>,
    });
    await identity.reload();
    const identityHandle = registry.register(identity.section);

    // Slash commands.
    const slashRegistry = ctx.useService?.("slash:registry") as
      | { register(m: { name: string; description: string; usage?: string; source: "plugin" }, h: any): () => void }
      | undefined;
    if (slashRegistry) {
      const handlers = makePromptSlashHandlers({
        registry,
        reloadIdentity: async () => {
          await identity.reload();
          identityHandle.bumpGeneration();
          await ctx.emit("prompt:reload", {});
        },
      });
      slashRegistry.register(
        { name: "prompt:show", description: "Show the current assembled system prompt.", usage: "[--stats]", source: "plugin" },
        handlers.show,
      );
      slashRegistry.register(
        { name: "prompt:reload", description: "Re-read identity files from disk.", source: "plugin" },
        handlers.reload,
      );
      slashRegistry.register(
        { name: "prompt:disable", description: "Disable a section by id (diagnostic).", usage: "<id>", source: "plugin" },
        handlers.disable,
      );
      slashRegistry.register(
        { name: "prompt:enable", description: "Enable a previously-disabled section.", usage: "<id>", source: "plugin" },
        handlers.enable,
      );
    }
  },
};

export default plugin;
```

- [ ] **Step 4: Run all tests**

Run: `cd plugins/llm-system-prompt && bun test`
Expected: PASS — all suites including index.test.ts green.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-system-prompt/index.ts plugins/llm-system-prompt/test/index.test.ts
git commit -m "feat(llm-system-prompt): wire setup() — service, identity, slash, events"
```

---

## Task 7: Add `prompt:rebuilt` + `prompt:reload` to `llm-events` VOCAB

**Files:**
- Modify: `plugins/llm-events/index.ts`
- Modify: `plugins/llm-events/public.d.ts`
- Modify: `plugins/llm-events/index.test.ts`

- [ ] **Step 1: Read the current vocab**

Run: `cat plugins/llm-events/index.ts`
Confirm `VOCAB` has no `PROMPT_*` keys yet.

- [ ] **Step 2: Write the failing test**

Append to `plugins/llm-events/index.test.ts`:

```typescript
it("VOCAB includes prompt:rebuilt and prompt:reload", () => {
  expect(VOCAB.PROMPT_REBUILT).toBe("prompt:rebuilt");
  expect(VOCAB.PROMPT_RELOAD).toBe("prompt:reload");
});
```

(`VOCAB` is the existing import — no new import needed.)

- [ ] **Step 3: Run test to verify it fails**

Run: `cd plugins/llm-events && bun test`
Expected: FAIL — `Cannot read property PROMPT_REBUILT of ...`.

- [ ] **Step 4: Update `public.d.ts`**

In `plugins/llm-events/public.d.ts`, find the `Vocab` interface and add two keys (alphabetical order with surrounding entries — likely after `LLM_TOKEN` block, but exact location matches the existing alphabetical/group convention):

```typescript
PROMPT_REBUILT: "prompt:rebuilt";
PROMPT_RELOAD: "prompt:reload";
```

If `Vocab` defines payload types separately, also add:

```typescript
"prompt:rebuilt": { generation: number };
"prompt:reload": Record<string, never>;
```

(If the file has no payload-types map, the literal-string keys are sufficient.)

- [ ] **Step 5: Update `index.ts`**

In `plugins/llm-events/index.ts`, add to the `VOCAB` object literal (preserving existing style, before the closing `} as const)`):

```typescript
  PROMPT_REBUILT: "prompt:rebuilt",
  PROMPT_RELOAD: "prompt:reload",
```

- [ ] **Step 6: Run tests**

Run: `cd plugins/llm-events && bun test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add plugins/llm-events/index.ts plugins/llm-events/public.d.ts plugins/llm-events/index.test.ts
git commit -m "feat(llm-events): add prompt:rebuilt and prompt:reload to VOCAB"
```

---

## Task 8: Driver integration — consume `prompt:system` with generation-keyed cache

**Files:**
- Modify: `plugins/llm-driver/loop.ts`
- Modify: `plugins/llm-driver/index.ts`

- [ ] **Step 1: Read current driver state**

Run: `grep -n "systemPrompt\|prompt:system" plugins/llm-driver/loop.ts plugins/llm-driver/index.ts`

Note the locations of:
- `loop.ts:30-41` (`RunConversationInput.systemPrompt`)
- `loop.ts:49-57` (`RunConversationDeps.defaultSystemPrompt`)
- `loop.ts:67-71` (`appendSystemAppend`)
- `loop.ts:99-110` (per-turn assembly)
- `index.ts:125` (passing `defaultSystemPrompt` into deps)

- [ ] **Step 2: Write the failing integration test**

Create `plugins/llm-driver/test/system-prompt-integration.test.ts`:

```typescript
import { describe, expect, it, mock } from "bun:test";
import { runConversation, type RunConversationDeps } from "../loop.ts";

function makeDeps(overrides: Partial<RunConversationDeps>): RunConversationDeps {
  const base: RunConversationDeps = {
    emit: mock(async () => {}),
    llmComplete: {
      complete: async function* () {
        yield { type: "done", response: { content: "ok", finishReason: "stop" } };
      },
      listModels: async () => [],
    } as any,
    registry: undefined,
    strategy: undefined,
    log: () => {},
    idGen: () => "turn-1",
    defaultSystemPrompt: "",
  };
  return { ...base, ...overrides };
}

describe("driver — prompt:system consumption", () => {
  it("uses promptSystem.assemble() when promptSystem is provided in deps", async () => {
    const assembled = "ASSEMBLED-FROM-SERVICE";
    const promptSystem = {
      assemble: mock(async () => assembled),
      generation: () => 1,
      register: () => ({ unregister: () => {}, bumpGeneration: () => {} }),
      list: () => [],
    } as any;

    const captured: any[] = [];
    const deps = makeDeps({
      promptSystem,
      llmComplete: {
        complete: async function* (req: any) {
          captured.push(req.systemPrompt);
          yield { type: "done", response: { content: "x", finishReason: "stop" } };
        },
        listModels: async () => [],
      } as any,
    } as any);

    await runConversation(
      { systemPrompt: "", messages: [{ role: "user", content: "hi" }] },
      deps,
    );

    expect(captured[0]).toBe(assembled);
    expect(promptSystem.assemble).toHaveBeenCalled();
  });

  it("caches assembly across turns when generation is unchanged", async () => {
    let gen = 1;
    let assembleCalls = 0;
    const promptSystem = {
      assemble: async () => { assembleCalls++; return "X"; },
      generation: () => gen,
      register: () => ({ unregister: () => {}, bumpGeneration: () => {} }),
      list: () => [],
    } as any;

    const deps = makeDeps({ promptSystem } as any);
    await runConversation({ systemPrompt: "", messages: [{ role: "user", content: "1" }] }, deps);
    await runConversation({ systemPrompt: "", messages: [{ role: "user", content: "2" }] }, deps);

    expect(assembleCalls).toBe(1);
  });

  it("re-assembles when generation increments", async () => {
    let gen = 1;
    let assembleCalls = 0;
    const promptSystem = {
      assemble: async () => { assembleCalls++; return `gen-${gen}`; },
      generation: () => gen,
      register: () => ({ unregister: () => {}, bumpGeneration: () => {} }),
      list: () => [],
    } as any;

    const deps = makeDeps({ promptSystem } as any);
    await runConversation({ systemPrompt: "", messages: [{ role: "user", content: "1" }] }, deps);
    gen = 2;
    await runConversation({ systemPrompt: "", messages: [{ role: "user", content: "2" }] }, deps);

    expect(assembleCalls).toBe(2);
  });

  it("falls back to legacy systemPromptAppend path when promptSystem is undefined", async () => {
    const captured: any[] = [];
    const deps = makeDeps({
      strategy: {
        prepareRequest: () => ({ systemPromptAppend: "STRATEGY-APPEND" }),
        handleResponse: async () => [],
      } as any,
      llmComplete: {
        complete: async function* (req: any) {
          captured.push(req.systemPrompt);
          yield { type: "done", response: { content: "x", finishReason: "stop" } };
        },
        listModels: async () => [],
      } as any,
    });

    await runConversation(
      { systemPrompt: "BASE", messages: [{ role: "user", content: "hi" }] },
      deps,
    );

    expect(captured[0]).toContain("BASE");
    expect(captured[0]).toContain("STRATEGY-APPEND");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd plugins/llm-driver && bun test test/system-prompt-integration.test.ts`
Expected: FAIL — `promptSystem` is not yet a known property of `RunConversationDeps`.

- [ ] **Step 4: Extend `RunConversationDeps` to accept `promptSystem`**

In `plugins/llm-driver/loop.ts`, modify the `RunConversationDeps` interface (around line 49):

```typescript
export interface PromptSystemServiceLike {
  assemble(): Promise<string>;
  generation(): number;
}

export interface RunConversationDeps {
  emit: (name: string, payload?: unknown) => Promise<void>;
  llmComplete: LLMCompleteService;
  registry: ToolsRegistryService | undefined;
  strategy: ToolDispatchStrategy | undefined;
  log: (msg: string) => void;
  idGen: () => string;
  defaultSystemPrompt: string;
  /** Optional. When present, the driver consumes the assembled prompt instead of the legacy `appendSystemAppend` path. */
  promptSystem?: PromptSystemServiceLike;
}
```

- [ ] **Step 5: Add the per-deps cache in `loop.ts`**

The cache must live across `runConversation` calls. Add a `WeakMap` keyed on `deps` at module scope in `plugins/llm-driver/loop.ts`, just below the `appendSystemAppend` function:

```typescript
interface AssemblyCache {
  generation: number;
  prompt: string;
}
const assemblyCache = new WeakMap<RunConversationDeps, AssemblyCache>();

async function resolveSystemPrompt(
  input: RunConversationInput,
  deps: RunConversationDeps,
  legacyAppend: string | undefined,
): Promise<string | undefined> {
  if (deps.promptSystem) {
    const gen = deps.promptSystem.generation();
    const cached = assemblyCache.get(deps);
    if (!cached || cached.generation !== gen) {
      const prompt = await deps.promptSystem.assemble();
      assemblyCache.set(deps, { generation: gen, prompt });
      return prompt;
    }
    return cached.prompt;
  }
  // Legacy path: input.systemPrompt + strategy.systemPromptAppend.
  return appendSystemAppend(input.systemPrompt, legacyAppend);
}
```

- [ ] **Step 6: Use `resolveSystemPrompt` in the per-turn build**

In `plugins/llm-driver/loop.ts` around line 105, replace the `request: LLMRequest = { ... systemPrompt: appendSystemAppend(...) ... }` construction with:

```typescript
    const request: LLMRequest = {
      model: input.model,
      messages: workingMessages.slice(),
      systemPrompt: await resolveSystemPrompt(input, deps, additions.systemPromptAppend),
      tools: additions.tools,
    };
```

And the second occurrence (around line 206 — the post-tool-dispatch second LLM call) likewise:

```typescript
      const request2: LLMRequest = {
        model: input.model,
        messages: workingMessages.slice(),
        systemPrompt: await resolveSystemPrompt(input, deps, additions2.systemPromptAppend),
        tools: additions2.tools,
      };
```

- [ ] **Step 7: Wire `promptSystem` into `index.ts` deps**

In `plugins/llm-driver/index.ts`:

1. Add `"prompt:system"` to the `services.consumes` array (around line 68).
2. In `setup`, call `ctx.consumeService("prompt:system")` next to the others.
3. In the `start` hook (where `buildDeps` is created — search for `defaultSystemPrompt: state.systemPrompt`), resolve the optional service and include it in deps:

```typescript
const promptSystem = ctx.useService?.("prompt:system") as
  | { assemble(): Promise<string>; generation(): number }
  | undefined;

// inside the deps object literal:
{
  // ... existing fields
  defaultSystemPrompt: state.systemPrompt || (ctx.config as DriverConfig)?.defaultSystemPrompt || DEFAULTS.defaultSystemPrompt,
  promptSystem,
}
```

4. Also subscribe to `prompt:rebuilt` to drop the WeakMap cache. Since the cache lives in `loop.ts` keyed on `deps`, the simplest invalidator is to mutate generation tracking — but the `WeakMap` in loop.ts already keys on the live `deps` object whose `promptSystem.generation()` is checked every turn. Therefore, no explicit `prompt:rebuilt` listener is required in the driver — the next turn naturally observes the new generation and re-assembles. (Document this in a comment in `index.ts`.)

- [ ] **Step 8: Run all tests**

Run: `bun test` (from repo root)
Expected: all driver and system-prompt tests PASS.

- [ ] **Step 9: Commit**

```bash
git add plugins/llm-driver
git commit -m "feat(llm-driver): consume prompt:system with generation-keyed cache; legacy fallback preserved"
```

---

## Task 9: Marketplace + harness wiring

**Files:**
- Modify: `.kaizen/marketplace.json`
- Modify: `harnesses/openai-compatible.json`

- [ ] **Step 1: Read the current marketplace**

Run: `grep -n '"name":' .kaizen/marketplace.json | head -30`

Find the alphabetical position where `llm-system-prompt` goes (between `llm-status-items` and `llm-tools-registry`).

- [ ] **Step 2: Add the catalog entry**

In `.kaizen/marketplace.json`, in the `entries` array, insert (preserving the existing two-space indent):

```json
{
  "kind": "plugin",
  "name": "llm-system-prompt",
  "description": "System-prompt assembler service (prompt:system).",
  "categories": ["prompt", "system"],
  "versions": [{ "version": "0.1.0", "source": { "type": "file", "path": "plugins/llm-system-prompt" } }]
},
```

- [ ] **Step 3: Add to harness**

In `harnesses/openai-compatible.json`, add `"official/llm-system-prompt@0.1.0"` to the `plugins` array. Place it BEFORE `official/llm-driver@0.1.0` so the service is available when the driver's `start` hook runs:

```json
{
  "plugins": [
    "official/llm-events@0.2.0",
    "official/openai-llm@0.1.0",
    "official/llm-tools-registry@0.1.0",
    "official/llm-local-tools@0.1.0",
    "official/llm-mcp-bridge@0.1.0",
    "official/llm-skills@0.1.0",
    "official/llm-memory@0.1.0",
    "official/llm-agents@0.1.0",
    "official/llm-slash-commands@0.1.0",
    "official/llm-codemode-dispatch@0.1.0",
    "official/llm-system-prompt@0.1.0",
    "official/llm-driver@0.1.0",
    "official/llm-status-items@0.1.0",
    "official/llm-hooks-shell@0.1.0",
    "official/llm-tui@0.1.0"
  ]
}
```

- [ ] **Step 4: Verify JSON is valid**

Run: `node -e 'JSON.parse(require("fs").readFileSync(".kaizen/marketplace.json"))' && node -e 'JSON.parse(require("fs").readFileSync("harnesses/openai-compatible.json"))'`
Expected: no output, exit 0.

- [ ] **Step 5: Commit**

```bash
git add .kaizen/marketplace.json harnesses/openai-compatible.json
git commit -m "chore: register llm-system-prompt@0.1.0 in marketplace and harness"
```

---

## Task 10: End-to-end smoke test (manual)

**Files:**
- (no file changes — this verifies the deployed plugin actually runs in the harness)

This task uses the local-deploy workflow from the user's `kaizen_local_plugin_deploy.md` memory.

- [ ] **Step 1: Install the new plugin into the local kaizen marketplace**

Run:
```bash
mkdir -p ~/.kaizen/marketplaces/official/plugins/llm-system-prompt@0.1.0
cp -R plugins/llm-system-prompt/. ~/.kaizen/marketplaces/official/plugins/llm-system-prompt@0.1.0/
cd ~/.kaizen/marketplaces/official/plugins/llm-system-prompt@0.1.0 && bun build --target=bun --outfile=dist/index.js index.ts
grep -c "prompt:system" dist/index.js
```
Expected: bundle built, `grep -c` ≥ 1.

- [ ] **Step 2: Deploy modified llm-driver and llm-events**

Run:
```bash
for p in llm-events llm-driver; do
  cp -R plugins/$p/. ~/.kaizen/marketplaces/official/plugins/$p@*/
  cd ~/.kaizen/marketplaces/official/plugins/$p@*/ && bun build --target=bun --outfile=dist/index.js index.ts
  cd -
done
```

- [ ] **Step 3: Create a test global identity file**

```bash
mkdir -p ~/.kaizen
cat > ~/.kaizen/system-prompt.md <<'EOF'
You are a TestAssistant. Always respond with the word "ack".
EOF
```

- [ ] **Step 4: Run the harness and inspect the assembled prompt**

Re-add the temporary debug dump used previously (or use a new one):

In `~/.kaizen/marketplaces/official/plugins/openai-llm@0.1.0/dist/index.js`, find the `buildChatBody` function and add a `writeFileSync` after the messages are assembled (or use a logging proxy).

Then:
```bash
kaizen --harness official/openai-compatible
# in the TUI, send: "hello"
# then in another shell:
cat ~/.kaizen/debug/last-request.txt | head -40
```

Expected: the SYSTEM PROMPT block contains `TestAssistant` (from the global file) AND the kaizen.tools API surface (still emitted by the existing code-mode dispatch as a strategy `systemPromptAppend` because Spec 15 has not landed yet).

- [ ] **Step 5: Test `/prompt:show`**

In the harness TUI, type `/prompt:show` and press enter. Expected: the assembled prompt is printed with `[identity, p=10]` header and the file contents.

- [ ] **Step 6: Test `/prompt:reload`**

Edit `~/.kaizen/system-prompt.md` to change a word, then in the TUI type `/prompt:reload`. Send a new message; verify the next request reflects the new content.

- [ ] **Step 7: Clean up the test identity file**

```bash
rm ~/.kaizen/system-prompt.md
```

- [ ] **Step 8: Commit nothing (smoke test only)**

If everything worked, the plan is complete. If any step failed, file an issue or fix forward.

---

## Self-Review

**Spec coverage:**
- Service contract (Spec 14 § *Service contract*) → Tasks 2, 5, 6.
- Identity sourcing + fallback + date interpolation (Spec 14 § *Identity section*) → Task 3.
- Slash commands (Spec 14 § *Operational surfaces*) → Tasks 4, 6.
- Driver integration + cache (Spec 14 § *Driver integration*) → Task 8.
- Migration from `llm:before-call` mutation (Spec 14 § *Migration*) → not in this plan; covered by Spec 15's plan and a follow-up plan to migrate `llm-skills` and `llm-memory`. Documented as out-of-scope below.
- Event vocabulary (Spec 14 § *Events*) → Task 7.
- Marketplace + harness wiring → Task 9.
- E2E verification → Task 10.

**Out of scope (covered by other plans):**
- Migrating `llm-skills` and `llm-memory` to register sections instead of mutating `llm:before-call` — separate follow-up plan.
- Code-mode API surface registration as a `prompt:system` section — Spec 15's plan.

**Acceptance criteria mapping (from Spec 14):**
1. Edit `~/.kaizen/system-prompt.md` + `/prompt:reload` → Task 10 step 6.
2. Test harness can register N sections → Task 2 tests.
3. Driver caches across turns → Task 8 tests.
4. `KAIZEN_SYSTEM_PROMPT_DISABLE=1` → Task 3 tests.
5. `/prompt:show` renders with section headers → Task 4 + Task 10 step 5.
6. Plugins no longer mutate `request.systemPrompt` in `llm:before-call` → out of scope (separate migration plan); Task 8 makes this possible by giving them the new path.
