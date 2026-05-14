# Agents Loader Parity Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring kaizen's `llm-agents` file format and discovery up to parity with the most impactful subset of Claude Code's custom-agent feature surface: recursive subdir discovery, parse-error visibility in `/agents:list`, and `disallowedTools`/`disallowedTags` denylist frontmatter fields.

**Architecture:** Three additive features, three plugins touched. `llm-contracts` gains optional `excludeNames`/`excludeTags` fields on `AgentManifest.toolFilter`. `llm-tools-registry`'s `matchesFilter` is extended (exact-name match, mirroring existing allowlist) to honor the new exclude fields. `llm-agents` extends the frontmatter parser, the loader (depth-first recursion with depth cap 8, hidden-dir skip, directory symlink-cycle guard), the dispatch builder (pass-through with always-on strip), the registry handle (`getErrors()` accessor), and the slash list handler (error footer).

**Tech Stack:** TypeScript / Bun, `bun:test`, kaizen plugin API v3, `llm-contracts/public` types.

**Spec:** `docs/superpowers/specs/2026-05-14-agents-loader-parity-phase1-design.md`

---

## File map

- **Modify** `plugins/llm-contracts/contracts/agents-registry.ts` — extend `AgentManifest.toolFilter` to add `excludeTags?` and `excludeNames?`.
- **Modify** `plugins/llm-tools-registry/registry.ts` — extend `matchesFilter` with denylist branches; symmetric tests in `test/registry.test.ts`.
- **Modify** `plugins/llm-agents/frontmatter.ts` — parse `disallowedTools` and `disallowedTags` into `toolFilter.excludeNames`/`excludeTags`.
- **Modify** `plugins/llm-agents/dispatch.ts` — pass exclude fields through, strip always-on names from `excludeNames`.
- **Modify** `plugins/llm-agents/loader.ts` — replace single-level loop with depth-first `walk()`; hidden-dir skip; directory symlink-cycle guard; depth cap 8.
- **Modify** `plugins/llm-agents/registry.ts` — `RegistryHandle.getErrors()`; `setInner(next, errors, onChange?)`.
- **Modify** `plugins/llm-agents/index.ts` — pass `result.errors` into `handle.setInner` after discovery.
- **Modify** `plugins/llm-agents/slash.ts` — `listHandler` appends error footer.
- **Modify** `plugins/llm-agents/CLAUDE.md` and `plugins/llm-tools-registry/CLAUDE.md` — module-map & invariant updates.
- **Extend tests** in `plugins/llm-agents/test/` (`frontmatter.test.ts`, `loader.test.ts`, `registry.test.ts`, `slash.test.ts`, `dispatch.test.ts`) and `plugins/llm-tools-registry/test/registry.test.ts`.

---

## Task 1: Contract — add `excludeNames` / `excludeTags` to `AgentManifest.toolFilter`

**Files:**
- Modify: `plugins/llm-contracts/contracts/agents-registry.ts`

- [ ] **Step 1: Apply the additive type change**

Replace the `AgentManifest` interface in `plugins/llm-contracts/contracts/agents-registry.ts` with:

```ts
export interface AgentManifest {
  name: string;
  description: string;
  systemPrompt: string;
  /** Restricts the tool view available to this agent's nested driver runs. */
  toolFilter?: {
    tags?: string[];
    names?: string[];
    excludeTags?: string[];
    excludeNames?: string[];
  };
}
```

- [ ] **Step 2: Build to verify the type compiles**

Run: `cd plugins/llm-contracts && bun test`
Expected: existing `llm-contracts` tests pass (this plugin's tests only check that `defineService` is called per contract — type compiles).

- [ ] **Step 3: Verify downstream consumers still compile**

Run: `cd plugins/llm-agents && bun test`
Expected: all existing tests pass. (Workspace deps via `workspace:*` give `llm-agents` the updated type. Existing `toolFilter` usages don't touch the new fields, so no break.)

- [ ] **Step 4: Commit**

```bash
git add plugins/llm-contracts/contracts/agents-registry.ts
git commit -m "feat(llm-contracts): add excludeNames/excludeTags to AgentManifest.toolFilter"
```

---

## Task 2: Frontmatter — parse `disallowedTools` / `disallowedTags`

**Files:**
- Modify: `plugins/llm-agents/frontmatter.ts`
- Modify: `plugins/llm-agents/test/frontmatter.test.ts`

- [ ] **Step 1: Add failing tests for the new fields**

Append to `plugins/llm-agents/test/frontmatter.test.ts`:

```typescript
describe("disallowedTools / disallowedTags", () => {
  it("parses disallowedTools into toolFilter.excludeNames", () => {
    const text = `---
name: a
description: An agent.
disallowedTools: ["edit_file", "write_file"]
---
body`;
    const r = parseAgentFile(text, "/x/a.md");
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.manifest.toolFilter?.excludeNames).toEqual(["edit_file", "write_file"]);
  });

  it("parses disallowedTags into toolFilter.excludeTags", () => {
    const text = `---
name: a
description: An agent.
disallowedTags: ["destructive", "network"]
---
body`;
    const r = parseAgentFile(text, "/x/a.md");
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.manifest.toolFilter?.excludeTags).toEqual(["destructive", "network"]);
  });

  it("merges all four filter halves when present", () => {
    const text = `---
name: a
description: An agent.
tools: ["read_file"]
tags: ["read-only"]
disallowedTools: ["edit_file"]
disallowedTags: ["destructive"]
---
body`;
    const r = parseAgentFile(text, "/x/a.md");
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.manifest.toolFilter).toEqual({
      names: ["read_file"],
      tags: ["read-only"],
      excludeNames: ["edit_file"],
      excludeTags: ["destructive"],
    });
  });

  it("rejects malformed disallowedTools (non-array)", () => {
    const text = `---
name: a
description: An agent.
disallowedTools: "edit_file"
---
body`;
    const r = parseAgentFile(text, "/x/a.md");
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error).toBe("/x/a.md: 'disallowedTools' must be an array of strings");
  });

  it("rejects malformed disallowedTags (non-string element)", () => {
    const text = `---
name: a
description: An agent.
disallowedTags: ["ok", 42]
---
body`;
    const r = parseAgentFile(text, "/x/a.md");
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error).toBe("/x/a.md: 'disallowedTags' must be an array of strings");
  });

  it("treats absent disallowed fields as no denylist (no excludeNames/excludeTags in toolFilter)", () => {
    const text = `---
name: a
description: An agent.
tools: ["read_file"]
---
body`;
    const r = parseAgentFile(text, "/x/a.md");
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.manifest.toolFilter).toEqual({ names: ["read_file"], tags: undefined });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd plugins/llm-agents && bun test test/frontmatter.test.ts`
Expected: 6 new failures (`disallowedTools/excludeNames not parsed`, etc.). Existing frontmatter tests still pass.

- [ ] **Step 3: Implement the parser additions**

In `plugins/llm-agents/frontmatter.ts`, locate the block (around lines 45–60) that reads `toolNames` / `tags` and builds `toolFilter`. Replace that block with:

```typescript
  const toolNames = fields.tools;
  const tags = fields.tags;
  const disallowedTools = fields.disallowedTools;
  const disallowedTags = fields.disallowedTags;
  if (toolNames !== undefined && !isStringArray(toolNames)) {
    return { ok: false, error: `${sourcePath}: 'tools' must be an array of strings` };
  }
  if (tags !== undefined && !isStringArray(tags)) {
    return { ok: false, error: `${sourcePath}: 'tags' must be an array of strings` };
  }
  if (disallowedTools !== undefined && !isStringArray(disallowedTools)) {
    return { ok: false, error: `${sourcePath}: 'disallowedTools' must be an array of strings` };
  }
  if (disallowedTags !== undefined && !isStringArray(disallowedTags)) {
    return { ok: false, error: `${sourcePath}: 'disallowedTags' must be an array of strings` };
  }
  const modelOverride = fields.model;
  if (modelOverride !== undefined && typeof modelOverride !== "string") {
    return { ok: false, error: `${sourcePath}: 'model' must be a string` };
  }

  const toolFilter = (toolNames !== undefined || tags !== undefined || disallowedTools !== undefined || disallowedTags !== undefined)
    ? {
        names: toolNames as string[] | undefined,
        tags: tags as string[] | undefined,
        excludeNames: disallowedTools as string[] | undefined,
        excludeTags: disallowedTags as string[] | undefined,
      }
    : undefined;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd plugins/llm-agents && bun test test/frontmatter.test.ts`
Expected: all tests pass.

Run: `cd plugins/llm-agents && bun test`
Expected: full suite passes, no regressions.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-agents/frontmatter.ts plugins/llm-agents/test/frontmatter.test.ts
git commit -m "feat(llm-agents): parse disallowedTools/disallowedTags frontmatter"
```

---

## Task 3: Tools registry — denylist branch in `matchesFilter`

**Files:**
- Modify: `plugins/llm-tools-registry/registry.ts`
- Modify: `plugins/llm-tools-registry/test/registry.test.ts`

- [ ] **Step 1: Add failing tests for denylist behavior**

Append to `plugins/llm-tools-registry/test/registry.test.ts` (inside the existing `describe` covering `list()`/`matchesFilter`, or in a new block at the end of the file):

```typescript
describe("matchesFilter denylist", () => {
  it("excludeNames removes a tool the allowlist would have admitted", () => {
    const r = makeRegistry(captureEmit());
    r.register({ name: "a", description: "A", parameters: { type: "object", properties: {}, additionalProperties: false } }, async () => ({}));
    r.register({ name: "b", description: "B", parameters: { type: "object", properties: {}, additionalProperties: false } }, async () => ({}));
    const list = r.list({ names: ["a", "b"], excludeNames: ["b"] });
    expect(list.map((t) => t.name).sort()).toEqual(["a"]);
  });

  it("excludeTags removes a tool whose schema tag matches", () => {
    const r = makeRegistry(captureEmit());
    r.register({ name: "read_file", description: "", parameters: { type: "object", properties: {}, additionalProperties: false }, tags: ["fs", "read-only"] }, async () => ({}));
    r.register({ name: "edit_file", description: "", parameters: { type: "object", properties: {}, additionalProperties: false }, tags: ["fs", "destructive"] }, async () => ({}));
    const list = r.list({ excludeTags: ["destructive"] });
    expect(list.map((t) => t.name).sort()).toEqual(["read_file"]);
  });

  it("tool present only in excludeNames is filtered (no allowlist)", () => {
    const r = makeRegistry(captureEmit());
    r.register({ name: "a", description: "", parameters: { type: "object", properties: {}, additionalProperties: false } }, async () => ({}));
    r.register({ name: "b", description: "", parameters: { type: "object", properties: {}, additionalProperties: false } }, async () => ({}));
    const list = r.list({ excludeNames: ["a"] });
    expect(list.map((t) => t.name).sort()).toEqual(["b"]);
  });

  it("empty excludeNames / excludeTags arrays behave identically to absent", () => {
    const r = makeRegistry(captureEmit());
    r.register({ name: "a", description: "", parameters: { type: "object", properties: {}, additionalProperties: false }, tags: ["fs"] }, async () => ({}));
    expect(r.list({ excludeNames: [] }).map((t) => t.name)).toEqual(["a"]);
    expect(r.list({ excludeTags: [] }).map((t) => t.name)).toEqual(["a"]);
  });

  it("filter without exclude fields still works (backwards-compat regression)", () => {
    const r = makeRegistry(captureEmit());
    r.register({ name: "a", description: "", parameters: { type: "object", properties: {}, additionalProperties: false } }, async () => ({}));
    r.register({ name: "b", description: "", parameters: { type: "object", properties: {}, additionalProperties: false } }, async () => ({}));
    expect(r.list({ names: ["a"] }).map((t) => t.name)).toEqual(["a"]);
    expect(r.list().map((t) => t.name).sort()).toEqual(["a", "b"]);
  });
});
```

Note: `captureEmit` is the helper already used in this file. If you're unsure of its exact name, open `plugins/llm-tools-registry/test/registry.test.ts` and reuse whatever the existing tests call to construct a registry.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd plugins/llm-tools-registry && bun test test/registry.test.ts`
Expected: 4–5 new failures in the `matchesFilter denylist` block; existing tests still pass.

- [ ] **Step 3: Extend `matchesFilter` and the `list()` / `listRegistrations()` filter type**

In `plugins/llm-tools-registry/registry.ts`, replace the existing `matchesFilter` function (around lines 46–62) with:

```typescript
  function matchesFilter(
    entry: Entry,
    filter?: {
      tags?: string[];
      names?: string[];
      sources?: ToolSource["kind"][];
      excludeTags?: string[];
      excludeNames?: string[];
    },
  ): boolean {
    if (!filter) return true;
    const { tags, names, sources, excludeTags, excludeNames } = filter;
    if (names && !new Set(names).has(entry.schema.name)) return false;
    if (sources && !new Set(sources).has(entry.source.kind)) return false;
    if (tags) {
      const tagSet = new Set(tags);
      const schemaTags = entry.schema.tags ?? [];
      let any = false;
      for (const t of schemaTags) if (tagSet.has(t)) { any = true; break; }
      if (!any) return false;
    }
    if (excludeNames && new Set(excludeNames).has(entry.schema.name)) return false;
    if (excludeTags) {
      const exTagSet = new Set(excludeTags);
      const schemaTags = entry.schema.tags ?? [];
      for (const t of schemaTags) if (exTagSet.has(t)) return false;
    }
    return true;
  }
```

Also update the matching filter type on the public `list()` and `listRegistrations()` signatures (same file, around lines 64 and 72):

```typescript
  function list(filter?: { tags?: string[]; names?: string[]; sources?: ToolSource["kind"][]; excludeTags?: string[]; excludeNames?: string[] }): ToolSchema[] {
    // ... body unchanged
  }

  function listRegistrations(filter?: { tags?: string[]; names?: string[]; sources?: ToolSource["kind"][]; excludeTags?: string[]; excludeNames?: string[] }): ToolRegistration[] {
    // ... body unchanged
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd plugins/llm-tools-registry && bun test`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-tools-registry/registry.ts plugins/llm-tools-registry/test/registry.test.ts
git commit -m "feat(llm-tools-registry): add excludeNames/excludeTags to list() filter"
```

---

## Task 4: Dispatch — pass exclude fields through; strip always-on names from denylist

**Files:**
- Modify: `plugins/llm-agents/dispatch.ts`
- Modify: `plugins/llm-agents/test/dispatch.test.ts`

- [ ] **Step 1: Add failing tests for the pass-through and always-on strip**

Append to `plugins/llm-agents/test/dispatch.test.ts`:

```typescript
describe("dispatch exclude pass-through and always-on strip", () => {
  it("passes excludeNames and excludeTags through to the driver", async () => {
    const driverCalls: any[] = [];
    const fakeDriver = { runConversation: async (input: any) => { driverCalls.push(input); return { messages: [] }; } };
    const reg = makeRegistryHandle(makeRegistry([m("agent-with-deny")]));
    // Adjust the fixture to set the manifest's toolFilter denylist.
    (reg.getInternal("agent-with-deny") as any).toolFilter = {
      names: ["read_file"],
      excludeNames: ["edit_file"],
      excludeTags: ["destructive"],
    };
    const dispatch = makeDispatchTool({
      registry: reg,
      tracker: makeTurnTracker(),
      driver: fakeDriver as any,
      sessions: makeSessions(),
      maxDepth: 4,
      hasSkills: () => false,
      emit: async () => {},
    });
    await dispatch.handler({ agent: "agent-with-deny", prompt: "hi" }, makeCtx());
    expect(driverCalls).toHaveLength(1);
    const passedFilter = driverCalls[0].toolFilter;
    expect(passedFilter.excludeNames).toEqual(["edit_file"]);
    expect(passedFilter.excludeTags).toEqual(["destructive"]);
  });

  it("strips always-on tool names from excludeNames before passing to driver", async () => {
    const driverCalls: any[] = [];
    const fakeDriver = { runConversation: async (input: any) => { driverCalls.push(input); return { messages: [] }; } };
    const reg = makeRegistryHandle(makeRegistry([m("self-denying")]));
    (reg.getInternal("self-denying") as any).toolFilter = {
      excludeNames: ["dispatch_agent", "load_skill", "edit_file"],
    };
    const dispatch = makeDispatchTool({
      registry: reg,
      tracker: makeTurnTracker(),
      driver: fakeDriver as any,
      sessions: makeSessions(),
      maxDepth: 4,
      hasSkills: () => true,
      emit: async () => {},
    });
    await dispatch.handler({ agent: "self-denying", prompt: "hi" }, makeCtx());
    const passedFilter = driverCalls[0].toolFilter;
    expect(passedFilter.excludeNames).toEqual(["edit_file"]);
    expect(passedFilter.names).toContain("dispatch_agent");
    expect(passedFilter.names).toContain("load_skill");
  });

  it("defaults excludeNames/excludeTags to empty arrays when the manifest declares none", async () => {
    const driverCalls: any[] = [];
    const fakeDriver = { runConversation: async (input: any) => { driverCalls.push(input); return { messages: [] }; } };
    const reg = makeRegistryHandle(makeRegistry([m("plain")]));
    const dispatch = makeDispatchTool({
      registry: reg,
      tracker: makeTurnTracker(),
      driver: fakeDriver as any,
      sessions: makeSessions(),
      maxDepth: 4,
      hasSkills: () => false,
      emit: async () => {},
    });
    await dispatch.handler({ agent: "plain", prompt: "hi" }, makeCtx());
    const passedFilter = driverCalls[0].toolFilter;
    expect(passedFilter.excludeNames).toEqual([]);
    expect(passedFilter.excludeTags).toEqual([]);
  });
});
```

(The `m`, `makeCtx`, and `makeSessions` helpers are already defined at the top of `dispatch.test.ts`; reuse them.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd plugins/llm-agents && bun test test/dispatch.test.ts`
Expected: 3 new failures.

- [ ] **Step 3: Update the `toolFilter` assembly in `dispatch.ts`**

In `plugins/llm-agents/dispatch.ts`, locate the block (around lines 86–92) that builds the merged `toolFilter`. Replace it with:

```typescript
    // Build merged tool filter: manifest names + always-on (dispatch_agent, optionally load_skill); manifest tags pass through.
    const manifestNames = internal.toolFilter?.names ?? [];
    const manifestTags = internal.toolFilter?.tags ?? [];
    const manifestExcludeNames = internal.toolFilter?.excludeNames ?? [];
    const manifestExcludeTags = internal.toolFilter?.excludeTags ?? [];
    const alwaysOn: string[] = ["dispatch_agent"];
    if (deps.hasSkills()) alwaysOn.push("load_skill");
    const mergedNames = Array.from(new Set([...manifestNames, ...alwaysOn]));
    // Strip always-on tool names from the denylist — the always-on invariant
    // says these cannot be opted out of, even by an explicit disallowedTools entry.
    const alwaysOnSet = new Set(alwaysOn);
    const excludeNames = manifestExcludeNames.filter((n) => !alwaysOnSet.has(n));
    const toolFilter = { names: mergedNames, tags: manifestTags, excludeNames, excludeTags: manifestExcludeTags };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd plugins/llm-agents && bun test test/dispatch.test.ts`
Expected: all tests pass.

Run: `cd plugins/llm-agents && bun test`
Expected: full suite passes.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-agents/dispatch.ts plugins/llm-agents/test/dispatch.test.ts
git commit -m "feat(llm-agents): pass exclude fields through dispatch with always-on strip"
```

---

## Task 5: Loader — recursive walk with hidden-dir skip, dir symlink-cycle guard, depth cap 8

**Files:**
- Modify: `plugins/llm-agents/loader.ts`
- Modify: `plugins/llm-agents/test/loader.test.ts`

- [ ] **Step 1: Add failing tests for recursive walk**

Append to `plugins/llm-agents/test/loader.test.ts`:

```typescript
describe("recursive walk", () => {
  function makeFakeDeps(fs: Record<string, { kind: "dir"; entries: string[] } | { kind: "file"; text: string }>) {
    return {
      readDir: async (p: string) => {
        const node = fs[p];
        if (!node) { const e: any = new Error(`ENOENT: ${p}`); e.code = "ENOENT"; throw e; }
        if (node.kind !== "dir") throw new Error(`not a dir: ${p}`);
        return node.entries;
      },
      stat: async (p: string) => {
        const node = fs[p];
        if (!node) { const e: any = new Error(`ENOENT: ${p}`); e.code = "ENOENT"; throw e; }
        return {
          isFile: () => node.kind === "file",
          isDirectory: () => node.kind === "dir",
          isSymbolicLink: () => false,
          size: node.kind === "file" ? Buffer.byteLength(node.text, "utf8") : 0,
        };
      },
      realpath: async (p: string) => p,
      readFile: async (p: string) => {
        const node = fs[p];
        if (!node || node.kind !== "file") throw new Error(`not a file: ${p}`);
        return node.text;
      },
    };
  }

  const goodMd = (name: string) => `---
name: ${name}
description: An agent.
---
body for ${name}`;

  it("loads agents from nested subdirectories", async () => {
    const fs = {
      "/user": { kind: "dir" as const, entries: ["sub", "top.md"] },
      "/user/top.md": { kind: "file" as const, text: goodMd("top") },
      "/user/sub": { kind: "dir" as const, entries: ["deep.md"] },
      "/user/sub/deep.md": { kind: "file" as const, text: goodMd("deep") },
      "/project": { kind: "dir" as const, entries: [] },
    };
    const result = await loadFromDirs({ userDir: "/user", projectDir: "/project", deps: makeFakeDeps(fs) });
    expect(result.manifests.map((m) => m.name).sort()).toEqual(["deep", "top"]);
    expect(result.errors).toEqual([]);
  });

  it("identity comes from frontmatter name only — path does not influence identity", async () => {
    const fs = {
      "/user": { kind: "dir" as const, entries: ["a"] },
      "/user/a": { kind: "dir" as const, entries: ["x.md"] },
      "/user/a/x.md": { kind: "file" as const, text: goodMd("coder") },
      "/project": { kind: "dir" as const, entries: [] },
    };
    const result = await loadFromDirs({ userDir: "/user", projectDir: "/project", deps: makeFakeDeps(fs) });
    expect(result.manifests).toHaveLength(1);
    expect(result.manifests[0]!.name).toBe("coder");
    expect(result.manifests[0]!.sourcePath).toBe("/user/a/x.md");
  });

  it("skips hidden directories", async () => {
    const fs = {
      "/user": { kind: "dir" as const, entries: [".git", "good.md"] },
      "/user/good.md": { kind: "file" as const, text: goodMd("good") },
      "/user/.git": { kind: "dir" as const, entries: ["agents"] },
      "/user/.git/agents": { kind: "dir" as const, entries: ["hidden.md"] },
      "/user/.git/agents/hidden.md": { kind: "file" as const, text: goodMd("hidden") },
      "/project": { kind: "dir" as const, entries: [] },
    };
    const result = await loadFromDirs({ userDir: "/user", projectDir: "/project", deps: makeFakeDeps(fs) });
    expect(result.manifests.map((m) => m.name)).toEqual(["good"]);
    expect(result.errors).toEqual([]);
  });

  it("errors when directory depth exceeds 8", async () => {
    // Build a chain 10 dirs deep.
    const fs: any = { "/project": { kind: "dir", entries: [] } };
    let path = "/user";
    fs[path] = { kind: "dir", entries: ["sub"] };
    for (let depth = 1; depth <= 10; depth++) {
      const next = `${path}/sub`;
      fs[path] = { kind: "dir", entries: ["sub", "f.md"] };
      fs[`${path}/f.md`] = { kind: "file", text: goodMd(`level${depth - 1}`) };
      fs[next] = { kind: "dir", entries: [] };
      path = next;
    }
    fs[path] = { kind: "dir", entries: [] };
    const result = await loadFromDirs({ userDir: "/user", projectDir: "/project", deps: makeFakeDeps(fs) });
    // We expect files at depths 0..7 to load (8 levels admitted; level8 and beyond rejected).
    expect(result.manifests.length).toBeLessThanOrEqual(8);
    // And we expect at least one depth-cap error.
    expect(result.errors.some((e) => /directory depth exceeds 8/.test(e.message))).toBe(true);
  });

  it("falls back to lex-order across subdirs on name collision", async () => {
    const fs = {
      "/user": { kind: "dir" as const, entries: ["a", "b"] },
      "/user/a": { kind: "dir" as const, entries: ["coder.md"] },
      "/user/a/coder.md": { kind: "file" as const, text: goodMd("coder") },
      "/user/b": { kind: "dir" as const, entries: ["coder.md"] },
      "/user/b/coder.md": { kind: "file" as const, text: goodMd("coder") },
      "/project": { kind: "dir" as const, entries: [] },
    };
    const result = await loadFromDirs({ userDir: "/user", projectDir: "/project", deps: makeFakeDeps(fs) });
    expect(result.manifests).toHaveLength(1);
    expect(result.manifests[0]!.sourcePath).toBe("/user/a/coder.md");
    expect(result.errors.some((e) => /duplicate agent name 'coder'/.test(e.message))).toBe(true);
  });

  it("propagates per-file failures from inside subdirs", async () => {
    const oversized = "x".repeat(70 * 1024); // > 64 KiB
    const fs = {
      "/user": { kind: "dir" as const, entries: ["sub"] },
      "/user/sub": { kind: "dir" as const, entries: ["big.md", "missing-fm.md", "ok.md"] },
      "/user/sub/big.md": { kind: "file" as const, text: `---\nname: big\ndescription: x\n---\n${oversized}` },
      "/user/sub/missing-fm.md": { kind: "file" as const, text: "no frontmatter here" },
      "/user/sub/ok.md": { kind: "file" as const, text: goodMd("ok") },
      "/project": { kind: "dir" as const, entries: [] },
    };
    const result = await loadFromDirs({ userDir: "/user", projectDir: "/project", deps: makeFakeDeps(fs) });
    expect(result.manifests.map((m) => m.name)).toEqual(["ok"]);
    expect(result.errors.some((e) => /exceeds 64 KiB/.test(e.message))).toBe(true);
    expect(result.errors.some((e) => /missing YAML frontmatter/.test(e.message))).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd plugins/llm-agents && bun test test/loader.test.ts`
Expected: 6 new failures (only top-level loading works today; subdirs are unreachable).

- [ ] **Step 3: Replace `loadOneScope` in `plugins/llm-agents/loader.ts` with a recursive walker**

Replace the current `loadOneScope` (lines 30–82) with the version below. Keep `loadFromDirs` unchanged (it just calls `loadOneScope` per scope and dedupes across scopes).

```typescript
const MAX_DEPTH = 8;

async function loadOneScope(
  rootDir: string,
  scope: "user" | "project",
  deps: LoaderDeps,
  errors: LoaderError[],
): Promise<InternalAgentManifest[]> {
  // Collect all .md file paths first, then process them in lex order so the
  // duplicate-name collision rule remains deterministic across subdirs.
  const collected: string[] = [];
  const seenRealPaths = new Set<string>();

  async function walk(dir: string, depth: number): Promise<void> {
    let entries: string[];
    try { entries = await deps.readDir(dir); }
    catch (err: any) {
      if (err?.code === "ENOENT") return;
      errors.push({ path: dir, message: `failed to read dir: ${err?.message ?? err}` });
      return;
    }
    entries.sort();
    for (const entry of entries) {
      if (entry.startsWith(".")) continue; // skip hidden entries (files and dirs)
      const fullPath = `${dir}/${entry}`;
      let st;
      try { st = await deps.stat(fullPath); }
      catch (err: any) {
        errors.push({ path: fullPath, message: `stat failed: ${err?.message ?? err}` });
        continue;
      }
      if (st.isDirectory()) {
        if (depth >= MAX_DEPTH) {
          errors.push({ path: fullPath, message: `directory depth exceeds 8; skipped` });
          continue;
        }
        let real = fullPath;
        if (st.isSymbolicLink()) {
          try { real = await deps.realpath(fullPath); }
          catch (err: any) { errors.push({ path: fullPath, message: `realpath failed: ${err?.message ?? err}` }); continue; }
          if (seenRealPaths.has(real)) {
            errors.push({ path: fullPath, message: `symlink cycle detected; skipped` });
            continue;
          }
          seenRealPaths.add(real);
        } else {
          seenRealPaths.add(real);
        }
        await walk(fullPath, depth + 1);
        continue;
      }
      if (!st.isFile()) continue;
      if (!entry.endsWith(".md")) continue;
      collected.push(fullPath);
    }
  }

  await walk(rootDir, 0);

  // Sort the collected file list for deterministic dedupe; process per-file.
  collected.sort();

  const out: InternalAgentManifest[] = [];
  const seenNames = new Set<string>();
  for (const fullPath of collected) {
    let st;
    try { st = await deps.stat(fullPath); }
    catch (err: any) { errors.push({ path: fullPath, message: `stat failed: ${err?.message ?? err}` }); continue; }
    if (st.size > MAX_BYTES) {
      errors.push({ path: fullPath, message: `agent file exceeds 64 KiB cap (${st.size} bytes); skipped` });
      continue;
    }
    let real = fullPath;
    if (st.isSymbolicLink()) {
      try { real = await deps.realpath(fullPath); }
      catch (err: any) { errors.push({ path: fullPath, message: `realpath failed: ${err?.message ?? err}` }); continue; }
      if (real === fullPath || seenRealPaths.has(real)) {
        errors.push({ path: fullPath, message: `symlink cycle detected; skipped` });
        continue;
      }
      seenRealPaths.add(real);
    }
    let text: string;
    try { text = await deps.readFile(fullPath); }
    catch (err: any) { errors.push({ path: fullPath, message: `read failed: ${err?.message ?? err}` }); continue; }
    const parsed = parseAgentFile(text, fullPath);
    if (!parsed.ok) { errors.push({ path: fullPath, message: parsed.error }); continue; }
    if (seenNames.has(parsed.manifest.name)) {
      errors.push({ path: fullPath, message: `duplicate agent name '${parsed.manifest.name}' within ${scope} scope; lexicographic-first wins; this file skipped` });
      continue;
    }
    seenNames.add(parsed.manifest.name);
    out.push({ ...parsed.manifest, sourcePath: fullPath, scope });
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd plugins/llm-agents && bun test test/loader.test.ts`
Expected: all loader tests pass (existing + 6 new).

Run: `cd plugins/llm-agents && bun test`
Expected: full plugin suite passes.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-agents/loader.ts plugins/llm-agents/test/loader.test.ts
git commit -m "feat(llm-agents): recursive subdir discovery with hidden-skip + depth cap"
```

---

## Task 6: Registry handle — `getErrors()` and `setInner(next, errors, onChange?)`

**Files:**
- Modify: `plugins/llm-agents/registry.ts`
- Modify: `plugins/llm-agents/test/registry.test.ts`
- Modify: `plugins/llm-agents/index.ts`

- [ ] **Step 1: Add failing tests for the errors slot**

Append to `plugins/llm-agents/test/registry.test.ts`:

```typescript
describe("RegistryHandle errors slot", () => {
  it("initial handle has empty errors", () => {
    const handle = makeRegistryHandle(makeRegistry([]));
    expect(handle.getErrors()).toEqual([]);
  });

  it("setInner stores errors and getErrors returns a defensive copy", () => {
    const handle = makeRegistryHandle(makeRegistry([]));
    const errors = [{ path: "/x/a.md", message: "boom" }];
    handle.setInner(makeRegistry([]), errors);
    const out1 = handle.getErrors();
    expect(out1).toEqual([{ path: "/x/a.md", message: "boom" }]);
    // Mutating the returned array must not affect the handle.
    out1.push({ path: "/y", message: "leak" });
    expect(handle.getErrors()).toEqual([{ path: "/x/a.md", message: "boom" }]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd plugins/llm-agents && bun test test/registry.test.ts`
Expected: 2 new failures (`handle.getErrors is not a function`, `handle.setInner expects 3 args`).

- [ ] **Step 3: Update `registry.ts` to add the errors slot**

Replace the `RegistryHandle` interface and `makeRegistryHandle` function in `plugins/llm-agents/registry.ts` (lines 49–70) with:

```typescript
export interface LoadError { path: string; message: string }

export interface RegistryHandle {
  service: AgentsRegistryService;
  getInternal(name: string): InternalAgentManifest | undefined;
  getErrors(): LoadError[];
  setInner(next: AgentsRegistry, errors?: LoadError[], onChange?: () => void): void;
}

export function makeRegistryHandle(initial: AgentsRegistry): RegistryHandle {
  let inner = initial;
  let errors: LoadError[] = [];
  return {
    get service() {
      return {
        list: () => inner.service.list(),
        register: (m: AgentManifest) => inner.service.register(m),
      } as AgentsRegistryService;
    },
    getInternal(name) { return inner.getInternal(name); },
    getErrors() { return [...errors]; },
    setInner(next, nextErrors, onChange) {
      inner = next;
      if (nextErrors !== undefined) errors = [...nextErrors];
      onChange?.();
    },
  } as RegistryHandle;
}
```

- [ ] **Step 4: Update `index.ts` to pass `result.errors` into the handle**

In `plugins/llm-agents/index.ts`, locate the line in the discovery microtask that calls `handle.setInner(...)` (around line 119). Replace it with:

```typescript
        handle.setInner(makeRegistry(result.manifests, bumpSection), result.errors, bumpSection);
```

(The third positional argument was the `onChange` callback before; it stays the same. The second argument is the new errors array.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd plugins/llm-agents && bun test`
Expected: full suite passes (registry tests + everything else).

- [ ] **Step 6: Commit**

```bash
git add plugins/llm-agents/registry.ts plugins/llm-agents/test/registry.test.ts plugins/llm-agents/index.ts
git commit -m "feat(llm-agents): plumb loader errors through registry handle"
```

---

## Task 7: Slash list handler — error footer

**Files:**
- Modify: `plugins/llm-agents/slash.ts`
- Modify: `plugins/llm-agents/test/slash.test.ts`

- [ ] **Step 1: Add failing tests for the footer**

Append to `plugins/llm-agents/test/slash.test.ts`:

```typescript
describe("listHandler error footer", () => {
  function regWithErrors(manifests: InternalAgentManifest[], errors: { path: string; message: string }[]) {
    const byName = new Map(manifests.map((m) => [m.name, m]));
    return {
      service: {
        list: () => manifests.map(({ sourcePath, scope, modelOverride, ...rest }) => rest),
        register: () => () => {},
      },
      getInternal: (name: string) => byName.get(name),
      getErrors: () => [...errors],
    };
  }

  it("renders an Errors footer below the agent list when errors exist", async () => {
    const reg = regWithErrors(
      [mkManifest({ name: "code-reviewer", description: "Reviews diffs." })],
      [
        { path: "/u/.kaizen/agents/coder.md", message: "missing YAML frontmatter (file must begin with '---')" },
      ],
    );
    const { listHandler } = makeSlashHandlers({ registry: reg });
    const ctx = fakeCmdCtx();
    await listHandler(ctx);
    expect(ctx.printed).toHaveLength(1);
    expect(ctx.printed[0]).toBe(
      "- **`code-reviewer`** [user] — Reviews diffs.\n" +
      "\n" +
      "**Errors loading agents (1):**\n" +
      "- /u/.kaizen/agents/coder.md: missing YAML frontmatter (file must begin with '---')",
    );
  });

  it("renders the Errors footer below 'No agents registered.' when registry is empty + errors exist", async () => {
    const reg = regWithErrors(
      [],
      [
        { path: "/p/.kaizen/agents/coder.md", message: "missing YAML frontmatter (file must begin with '---')" },
        { path: "/p/.kaizen/agents/reviewer.md", message: "missing YAML frontmatter (file must begin with '---')" },
      ],
    );
    const { listHandler } = makeSlashHandlers({ registry: reg });
    const ctx = fakeCmdCtx();
    await listHandler(ctx);
    expect(ctx.printed[0]).toBe(
      "No agents registered.\n" +
      "\n" +
      "**Errors loading agents (2):**\n" +
      "- /p/.kaizen/agents/coder.md: missing YAML frontmatter (file must begin with '---')\n" +
      "- /p/.kaizen/agents/reviewer.md: missing YAML frontmatter (file must begin with '---')",
    );
  });

  it("does not render a footer when errors are empty", async () => {
    const reg = regWithErrors([mkManifest({ name: "a", description: "A." })], []);
    const { listHandler } = makeSlashHandlers({ registry: reg });
    const ctx = fakeCmdCtx();
    await listHandler(ctx);
    expect(ctx.printed[0]).toBe("- **`a`** [user] — A.");
  });
});
```

(The existing `mkManifest` and `fakeCmdCtx` helpers in `slash.test.ts` are reused.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd plugins/llm-agents && bun test test/slash.test.ts`
Expected: 3 new failures (footer not present in output).

Note: existing `slash.test.ts` tests use a `fakeRegistry` that does not implement `getErrors`. Update that helper (top of file) to also expose `getErrors: () => []` so existing tests still pass. Apply this small change in Step 3.

- [ ] **Step 3: Update `slash.ts` and the existing `fakeRegistry` helper**

In `plugins/llm-agents/slash.ts`, replace the `listHandler` implementation with:

```typescript
  const listHandler: SlashCommandHandler = async (cmdCtx) => {
    try {
      const items = deps.registry.service.list();
      const errors = deps.registry.getErrors();
      const lines: string[] = [];
      if (items.length === 0) {
        lines.push("No agents registered.");
      } else {
        for (const pub of [...items].sort((a, b) => a.name.localeCompare(b.name))) {
          const internal = deps.registry.getInternal(pub.name);
          if (!internal) continue;
          lines.push(`- **\`${pub.name}\`** [${scopeTag(internal)}] — ${pub.description}`);
        }
      }
      const body = items.length === 0 ? lines[0]! : lines.join("\n");
      if (errors.length > 0) {
        const footer = [
          `**Errors loading agents (${errors.length}):**`,
          ...errors.map((e) => `- ${e.path}: ${e.message}`),
        ].join("\n");
        await cmdCtx.print(`${body}\n\n${footer}`);
      } else {
        await cmdCtx.print(body);
      }
    } catch (err) {
      await cmdCtx.print(`Error: ${(err as Error).message}`);
    }
  };
```

Also update `SlashHandlerDeps` at the top of `slash.ts` to declare the new `getErrors` capability:

```typescript
export interface SlashHandlerDeps {
  registry: {
    service: { list(): Array<Pick<InternalAgentManifest, "name" | "description" | "systemPrompt" | "toolFilter">> };
    getInternal(name: string): InternalAgentManifest | undefined;
    getErrors(): Array<{ path: string; message: string }>;
  };
}
```

Finally, in `plugins/llm-agents/test/slash.test.ts`, locate the existing `fakeRegistry` helper near the top of the file. Add `getErrors: () => []` to the returned object so the existing tests continue to satisfy the updated `SlashHandlerDeps` type:

```typescript
function fakeRegistry(manifests: InternalAgentManifest[]) {
  const byName = new Map(manifests.map((m) => [m.name, m]));
  return {
    service: {
      list: () => manifests.map(({ sourcePath, scope, modelOverride, ...rest }) => rest),
      register: () => () => {},
    },
    getInternal: (name: string) => byName.get(name),
    getErrors: () => [],
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd plugins/llm-agents && bun test test/slash.test.ts`
Expected: 12 tests pass (9 pre-existing + 3 new).

Run: `cd plugins/llm-agents && bun test`
Expected: full suite passes.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-agents/slash.ts plugins/llm-agents/test/slash.test.ts
git commit -m "feat(llm-agents): render parse-error footer in /agents:list"
```

---

## Task 8: Documentation updates

**Files:**
- Modify: `plugins/llm-agents/CLAUDE.md`
- Modify: `plugins/llm-tools-registry/CLAUDE.md`

- [ ] **Step 1: Update `plugins/llm-agents/CLAUDE.md`**

In the fenced module map, update the entries for `loader.ts`, `registry.ts`, and `slash.ts`:

- `loader.ts`: change description to: `loadFromDirs({ userDir, projectDir, deps }) → { manifests, errors }. Depth-first recursive walk per scope (max depth 8). Hidden dirs (dot-prefix) skipped. Per-scope dedupe by lex-first full path. Directory symlink-cycle guard via realpath + seenRealPaths.`
- `registry.ts`: change description to: `makeRegistry(initial) and makeRegistryHandle(initial). The handle exposes service/getInternal/getErrors and lets index.ts swap the inner registry and load-errors slot via setInner(next, errors?, onChange?).`
- `slash.ts`: change description to: `makeSlashHandlers({ registry }) → { listHandler, showHandler }. Pure factory; no ctx. listHandler renders agents from registry.service.list() and appends a parse-error footer from registry.getErrors() when non-empty.`

In the "Invariants" section, append three new bullets:

```
- **Recursive walk has a depth cap.** `loader.ts` walks each scope depth-first with a hard cap of 8 levels. Entries beyond the cap emit a `directory depth exceeds 8; skipped` error and do not load. Hidden entries (names starting with `.`) are skipped entirely. This bound exists to fail loud on accidental symlink loops or misplaced agent roots.
- **Identity comes from frontmatter `name`, not path.** Two files at different paths declaring the same `name` collide; lex-first full path wins, the other emits `duplicate agent name 'X'`. Subdir layout is purely organizational.
- **Tool denylist cannot strip always-on tools.** `dispatch.ts` removes always-on tool names (`dispatch_agent`, `load_skill`) from a manifest's `excludeNames` before constructing the merged `toolFilter`. A manifest cannot opt out of these via `disallowedTools`.
```

- [ ] **Step 2: Update `plugins/llm-tools-registry/CLAUDE.md`**

In the module map, update the `registry.ts` description to mention the denylist support:

```
registry.ts     makeRegistry(emit) → ToolsRegistryService. Pure logic. Owns the
                Map<name, { schema, handler }> and the invoke() event sequencing.
                list()/listRegistrations() accept an optional filter with
                names/tags/sources allowlist halves and excludeNames/excludeTags
                denylist halves (exact-name match for names/excludeNames).
```

In the "Invariants" section, append:

```
- **Filter is allow-then-deny.** `matchesFilter` first applies the allowlist halves (names, sources, tags) — if any allowlist gate rejects, the entry is out. Then it applies the denylist halves (excludeNames, excludeTags) — any match denies. A tool in both `names` and `excludeNames` is denied (denylist wins). Matching is by exact tool name (`Set.has`), not glob; this is consistent across both halves.
```

- [ ] **Step 3: Commit**

```bash
git add plugins/llm-agents/CLAUDE.md plugins/llm-tools-registry/CLAUDE.md
git commit -m "docs: document recursive walk, error footer, and denylist filter"
```

---

## Task 9: Local deploy + smoke test

**Files:** none modified — verification only.

- [ ] **Step 1: Build and deploy `llm-contracts` first**

```bash
PLUGIN=llm-contracts
VERSION=$(jq -r .version plugins/$PLUGIN/package.json)
INSTALL_DIR=~/.kaizen/marketplaces/official/plugins/${PLUGIN}@${VERSION}
(cd plugins/$PLUGIN && bun build --target=bun --outfile=dist/index.js index.ts)
mkdir -p "$INSTALL_DIR/dist"
cp plugins/$PLUGIN/dist/index.js "$INSTALL_DIR/dist/index.js"
rsync -a --exclude='node_modules' --exclude='dist' plugins/$PLUGIN/ "$INSTALL_DIR/"
```

- [ ] **Step 2: Build and deploy `llm-tools-registry`**

```bash
PLUGIN=llm-tools-registry
VERSION=$(jq -r .version plugins/$PLUGIN/package.json)
INSTALL_DIR=~/.kaizen/marketplaces/official/plugins/${PLUGIN}@${VERSION}
(cd plugins/$PLUGIN && bun build --target=bun --outfile=dist/index.js index.ts)
mkdir -p "$INSTALL_DIR/dist"
cp plugins/$PLUGIN/dist/index.js "$INSTALL_DIR/dist/index.js"
rsync -a --exclude='node_modules' --exclude='dist' plugins/$PLUGIN/ "$INSTALL_DIR/"
```

- [ ] **Step 3: Build and deploy `llm-agents`**

```bash
PLUGIN=llm-agents
VERSION=$(jq -r .version plugins/$PLUGIN/package.json)
INSTALL_DIR=~/.kaizen/marketplaces/official/plugins/${PLUGIN}@${VERSION}
(cd plugins/$PLUGIN && bun build --target=bun --outfile=dist/index.js index.ts)
mkdir -p "$INSTALL_DIR/dist"
cp plugins/$PLUGIN/dist/index.js "$INSTALL_DIR/dist/index.js"
rsync -a --exclude='node_modules' --exclude='dist' plugins/$PLUGIN/ "$INSTALL_DIR/"
```

- [ ] **Step 4: Verify bundles contain the new code**

```bash
grep -c "directory depth exceeds 8" ~/.kaizen/marketplaces/official/plugins/llm-agents@*/dist/index.js
grep -c "excludeNames" ~/.kaizen/marketplaces/official/plugins/llm-tools-registry@*/dist/index.js
grep -c "Errors loading agents" ~/.kaizen/marketplaces/official/plugins/llm-agents@*/dist/index.js
```
Expected: each grep returns a count >= 1.

- [ ] **Step 5: Launch the harness and verify (manual)**

```bash
kaizen --harness ./harnesses/openai-compatible.json
```

At the TUI prompt:

1. `/agents:list` — verify the new error footer shows for the existing bare-markdown files at `.kaizen/agents/coder.md` and `.kaizen/agents/reviewer.md`. Expected: `No agents registered.` followed by `**Errors loading agents (2):**` with two lines naming each file and `missing YAML frontmatter (file must begin with '---')`.

2. Optional — create a valid agent and verify it loads:

   ```bash
   cat > ~/.kaizen/agents/listme.md <<'MD'
   ---
   name: listme
   description: A trivial agent used to verify recursive discovery works.
   tools: ["dispatch_agent"]
   ---
   You exist only to be listed.
   MD
   mkdir -p ~/.kaizen/agents/nested/deep
   cat > ~/.kaizen/agents/nested/deep/buried.md <<'MD'
   ---
   name: buried
   description: A nested agent used to verify recursive discovery.
   ---
   You exist deep in the tree.
   MD
   ```

   Restart the harness, run `/agents:list` — expected: both `listme` and `buried` appear with `[user]` scope.

3. Optional — verify denylist by adding `disallowedTools: ["edit_file"]` to a valid agent and dispatching it; observe the agent does not see `edit_file` in its tool view. This is a deeper smoke test; skip unless you want full end-to-end verification.

- [ ] **Step 6: No commit required**

Smoke testing produces no file changes. Done.

---

## Self-review summary

**Spec coverage:**

- Recursive subdir discovery, hidden-dir skip, depth cap 8, directory symlink-cycle guard → Task 5.
- Parse-error footer in `/agents:list`, both with and without registered agents → Task 7 (footer rendering), Task 6 (errors plumbed through handle), Task 5 (errors collected by loader).
- `disallowedTools` / `disallowedTags` frontmatter parsing → Task 2.
- Contract change (`excludeNames` / `excludeTags`) → Task 1.
- `matchesFilter` denylist branches in `llm-tools-registry` → Task 3.
- `dispatch.ts` pass-through + always-on strip → Task 4.
- Docs (both plugins) → Task 8.
- Local deploy + smoke test → Task 9.

**Type consistency:**

- `LoadError = { path: string; message: string }` defined in Task 6 (`registry.ts`) matches the error record shape `loader.ts` produces (`LoaderError = { path: string; message: string }`).
- `SlashHandlerDeps.registry` gains `getErrors()` in Task 7 — the existing `fakeRegistry` test helper is updated in the same task to satisfy the new type.
- `RegistryHandle.setInner(next, errors?, onChange?)` is called with `(makeRegistry(...), result.errors, bumpSection)` in Task 6 step 4 — matches the new signature.

**Placeholders:** none — every code step shows complete code; every command shows expected output.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-14-agents-loader-parity-phase1.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — fresh subagent per task, two-stage review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using executing-plans with batched checkpoints.

**Which approach?**
