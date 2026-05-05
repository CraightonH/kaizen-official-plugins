# `prompt:system` Migration Plan — llm-mcp-bridge, llm-agents, llm-skills, llm-memory

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Finish the migration started by Spec 14 (`prompt:system`) and Spec 15 (code-mode API surface). Today the four plugins below still mutate `request.systemPrompt` in `llm:before-call` and/or call legacy `registry.register(schema, handler)` — so their tools all collapse into `kaizen.tools.*` instead of the proper grouped namespaces. After this plan: each plugin contributes its prompt content via a `prompt:system` section and tags its tool registrations with the right `ToolSource`. Also wires the `mcp:registration-conflict` event deferred from Spec 11.

**Prerequisite:** `worktree-llm-codemode-api-surface` (or its merge to main) — provides `prompt:system` service, `tools:registered`/`unregistered` events, `registerWith()`, and `groupBySource().conflicts`.

---

## Tier-for-Parallelism Map

- **Tier A** (parallel, no shared state): Task 1 (`llm-mcp-bridge`), Task 2 (`llm-agents`), Task 3 (`llm-skills`), Task 4 (`llm-memory`).
- **Tier B** (depends on Tier A's mcp-bridge changes): Task 5 (`mcp:registration-conflict` event wiring).
- **Tier C** (sequential, after all migrations): Task 6 (drop the four `llm:before-call` injectors permanently), Task 7 (e2e smoke).

Each Tier-A task is independent and follows the same shape: register the section, switch to `registerWith()`, drop the `llm:before-call` mutation. They can be implemented concurrently in different sessions or sequentially in one.

---

## Task 1: Migrate `llm-mcp-bridge`

**Files:**
- Modify: `plugins/llm-mcp-bridge/lifecycle.ts`
- Modify: `plugins/llm-mcp-bridge/service.ts`
- Modify: `plugins/llm-mcp-bridge/package.json` (add `llm-tools-registry` workspace dep if not present)

`llm-mcp-bridge` registers MCP tools dynamically as servers connect. Today it calls `registry.register(schema, handler)` — defaulting source to `{ kind: "local" }`. We need each tool to carry `{ kind: "mcp", server: <serverName> }` so the assembler groups them under `kaizen.mcp.<server>.<tool>`.

- [ ] **Step 1: Update `RegistryDep` type** in `lifecycle.ts` to also accept `registerWith`:

```typescript
import type { ToolRegistration } from "llm-tools-registry/public";

interface RegistryDep {
  register(schema, handler): () => void;        // legacy, kept for transition
  registerWith(reg: ToolRegistration): () => void;
}
```

- [ ] **Step 2: Carry the server name through registration**. The lifecycle code path that builds `newReg.schema` already knows which server the tool came from (passed as a parameter or held in scope). Replace `this.deps.registry.register(newReg.schema, newReg.handler)` with:

```typescript
this.deps.registry.registerWith({
  schema: newReg.schema,
  handler: newReg.handler,
  source: { kind: "mcp", server: serverName },
});
```

- [ ] **Step 3: Same change in `service.ts`** for `read_mcp_resource` / `list_mcp_resources` — these are *meta* tools owned by the bridge itself, not specific to one server. Keep them as `kind: "local"` (they're proxies that operate over multiple servers, so they belong under `kaizen.tools`). Leave the existing `register(schema, handler)` calls alone OR switch to `registerWith({ ..., source: { kind: "local" } })` for explicitness.

- [ ] **Step 4: Tests** — extend `plugins/llm-mcp-bridge/test/lifecycle.test.ts` (or create one) to assert that registration of a server-owned tool calls `registerWith` with `source: { kind: "mcp", server: "<name>" }`. Mock the registry to capture the source.

- [ ] **Step 5: Commit:**
```
feat(llm-mcp-bridge): tag MCP tools with source: { kind: "mcp", server } for grouped namespaces
```

## Task 2: Migrate `llm-agents`

**Files:**
- Modify: `plugins/llm-agents/index.ts`
- Modify: `plugins/llm-agents/injector.ts` (drop the `llm:before-call` mutation; replace with a `prompt:system` section)
- Modify: `plugins/llm-agents/registry.ts` (the `dispatch_agent` tool registration)

Two changes:

### 2a. Tag the `dispatch_agent` tool with `kind: "agent"`

- [ ] Find where `dispatch_agent` is registered via `registry.register(...)`. Switch to `registerWith({ schema, handler, source: { kind: "agent" } })`. After this, the tool appears under `kaizen.agents.dispatch_agent` instead of `kaizen.tools.dispatch_agent`.

### 2b. Replace the `llm:before-call` injector with a section

`injector.ts:37-45` currently mutates `request.systemPrompt` to append the available-agents list. Replace this with:

- [ ] Add `"prompt:system"` to consumed services in `index.ts`.
- [ ] In `setup`, resolve `prompt:system` and register a section:

```typescript
const promptSystem = ctx.useService<SystemPromptService>("prompt:system");
const handle = promptSystem.register({
  id: "llm-agents:available",
  priority: 150,
  title: "Available agents",
  render: () => buildAgentsBlock(state.agents),  // existing logic from injector
});
// On agent list mutation: handle.bumpGeneration();
```

Where `state.agents` already exists (it's what the injector reads). Anywhere the agents list mutates today, also call `handle.bumpGeneration()`.

- [ ] Delete the `llm:before-call` subscription. `defineService("driver:run-conversation", ...)` should no longer depend on injector wiring.

### Tests + commit

- [ ] Update `plugins/llm-agents/test/...` to assert: section registered at id `llm-agents:available` priority 150; `dispatch_agent` registered with `source: { kind: "agent" }`; no `llm:before-call` subscription.
- [ ] Commit:
```
feat(llm-agents): contribute available-agents block via prompt:system; tag dispatch_agent as kind:"agent"
```

## Task 3: Migrate `llm-skills`

**Files:**
- Modify: `plugins/llm-skills/index.ts`
- Modify: `plugins/llm-skills/registry.ts`

Same shape as Task 2.

### 3a. Tag `load_skill` with `kind: "skill"`

- [ ] Replace the `tools.register(LOAD_SKILL_SCHEMA, handler)` call (currently at `index.ts:103`) with `tools.registerWith({ schema: LOAD_SKILL_SCHEMA, handler, source: { kind: "skill" } })`.

### 3b. Replace the `llm:before-call` injector with a section

`index.ts:75` currently subscribes to `llm:before-call` and rewrites `request.systemPrompt` to append the available-skills list. Replace with:

- [ ] Consume `prompt:system` and register a section:
```typescript
promptSystem.register({
  id: "llm-skills:available",
  priority: 160,
  title: "Available skills",
  render: () => buildSkillsBlock(skills),
});
```
- [ ] Bump generation when skills are added/removed (at the existing call sites that fire when `load_skill` registers a new skill or when `rescan` discovers new manifests).
- [ ] Delete the `llm:before-call` subscription.

### Tests + commit

- [ ] Section registered at `llm-skills:available` priority 160.
- [ ] `load_skill` registered with `source: { kind: "skill" }`.
- [ ] No `llm:before-call` subscription.
- [ ] Commit:
```
feat(llm-skills): contribute available-skills block via prompt:system; tag load_skill as kind:"skill"
```

## Task 4: Migrate `llm-memory`

**Files:**
- Modify: `plugins/llm-memory/index.ts`
- Modify: `plugins/llm-memory/tools.ts`

### 4a. Tag `memory_save` and `memory_recall` with `kind: "memory"`

- [ ] In `tools.ts` (lines 79 and 96), replace `registry.register(...)` with `registry.registerWith({ schema, handler, source: { kind: "memory" } })` for both tools.

### 4b. Replace the `llm:before-call` injector with a section

`index.ts:42-61` currently mutates `request.systemPrompt` to append a memory block. Replace with:

- [ ] Consume `prompt:system`. Register a section:
```typescript
promptSystem.register({
  id: "llm-memory:auto",
  priority: 170,
  title: "Saved memories",
  render: async () => buildMemoryBlock(...),  // existing logic from injector
});
```
- [ ] Bump generation when memories change (after `memory_save` succeeds, after deletion, etc.).
- [ ] Delete the `llm:before-call` subscription.

### Tests + commit

- [ ] Section registered at `llm-memory:auto` priority 170.
- [ ] `memory_save` and `memory_recall` registered with `source: { kind: "memory" }`.
- [ ] No `llm:before-call` subscription.
- [ ] Commit:
```
feat(llm-memory): contribute saved-memories block via prompt:system; tag memory tools as kind:"memory"
```

---

## Task 5: Wire `mcp:registration-conflict` event

**Files:**
- Modify: `plugins/llm-events/index.ts` + `plugins/llm-events/public.d.ts` (add `MCP_REGISTRATION_CONFLICT`)
- Modify: `plugins/llm-mcp-bridge/lifecycle.ts` (emit the event on collision)

Spec 11 / Spec 15 deferred this. `assembler.ts` already detects conflicts via `groupBySource().conflicts`, but no event fires when two MCP servers normalize to the same identifier (e.g. `foo-bar` and `foo.bar` both → `foo_bar`).

- [ ] **Step 1:** Add to `Vocab` interface and `VOCAB` literal:
```typescript
MCP_REGISTRATION_CONFLICT: "mcp:registration-conflict";
```

- [ ] **Step 2:** In `lifecycle.ts`, when a new server's normalized name collides with an existing one, emit:
```typescript
ctx.emit("mcp:registration-conflict", {
  normalized,
  servers: [...colliding],   // raw server names involved
});
```

- [ ] **Step 3:** Test in `llm-events/index.test.ts`: `VOCAB.MCP_REGISTRATION_CONFLICT === "mcp:registration-conflict"`.
- [ ] **Step 4:** Test in `llm-mcp-bridge`: registering two servers whose names normalize to the same identifier emits the event with both raw names.
- [ ] **Step 5:** Commit:
```
feat(llm-mcp-bridge,llm-events): emit mcp:registration-conflict on normalized-name collision
```

---

## Task 6: Sweep — confirm no `llm:before-call` mutations remain

**Files:**
- Read-only audit of `plugins/*/`

After Tasks 2-4, no plugin should be mutating `request.systemPrompt` in `llm:before-call`. The spec required eliminating that pattern.

- [ ] Run: `grep -rn "request.systemPrompt" plugins/ | grep -v node_modules | grep -v test/`
- [ ] Expected: only references inside `llm-driver` (which reads `input.systemPrompt` for the legacy fallback) and `openai-llm/http.ts` (which reads `req.systemPrompt` to build the wire body). No writes outside the driver/runtime.
- [ ] Run: `grep -rn 'on("llm:before-call"' plugins/ | grep -v node_modules`
- [ ] Expected: zero results from migrated plugins. If any remain, that plugin still has unmigrated injection logic — fix it.

If both checks are clean, no commit needed. If something remained, fix it and commit:
```
chore: drop final llm:before-call mutations after prompt:system migration
```

---

## Task 7: End-to-end smoke

- [ ] **Step 1:** Deploy all five modified plugins:
```bash
for p in llm-events llm-mcp-bridge llm-agents llm-skills llm-memory; do
  cp -R plugins/$p/. ~/.kaizen/marketplaces/official/plugins/$p@*/
  (cd ~/.kaizen/marketplaces/official/plugins/$p@*/ && bun build --target=bun --outfile=dist/index.js index.ts)
done
```
- [ ] **Step 2:** Sync the local repo to the migration branch (so `kaizen marketplace update` doesn't clobber):
```bash
cd ~/.kaizen/marketplaces/official/repo && git fetch <local> <branch> && git reset --hard FETCH_HEAD
```
- [ ] **Step 3:** `KAIZEN_DEBUG_REQUESTS=1 kaizen --harness official/openai-compatible`. Send a message.
- [ ] **Step 4:** `cat ~/.kaizen/debug/last-request.txt`. Verify the `declare const kaizen` block contains:
  - `tools: { ... }` for local tools (bash, glob, grep, read, write, edit, list_mcp_resources, read_mcp_resource).
  - `agents: { dispatch_agent }` (split out from `tools`).
  - `skills: { load_skill }` (split out).
  - `memory: { memory_save, memory_recall }` (split out).
  - `mcp: { <server>: { ... } }` if any MCP servers are configured.
- [ ] **Step 5:** Verify identity / available-agents / available-skills / saved-memories sections all appear under their priorities (10, 150, 160, 170) in `/prompt:show`.
- [ ] **Step 6:** Verify cache stability — diff two successive `request-*.txt` files; only the user-message lines should differ.

---

## Self-Review

**Spec coverage closed by this plan:**
- Spec 14 § *Migration* — eliminating `llm:before-call` mutations in `llm-skills` and `llm-memory` — Tasks 3, 4.
- Spec 14 § *Migration* — `llm-agents` available-agents injection via `prompt:system` — Task 2 (not explicitly called out in Spec 14 but the same pattern).
- Spec 15 § *Tool source provenance* — adopting `registerWith` across all consumers — Tasks 1-4.
- Spec 15 acceptance criterion 7 — `mcp:registration-conflict` event — Task 5.
- Spec 15 grouped-namespace acceptance — verified live in Task 7 step 4.

**Out of scope:**
- Token-budget pressure mitigations (just-in-time MCP expansion, per-server opt-out). Tracked under Spec 15 v1; not addressed here.
- Plugin teardown contract — `llm-codemode-dispatch` and the migrated plugins capture handle/detach but never invoke them. There's no Kaizen lifecycle hook for it today. Worth a separate spec.

**Acceptance criteria:**
1. `kaizen.agents`, `kaizen.skills`, `kaizen.memory`, `kaizen.mcp.<server>` all render under their proper namespaces in the assembled API surface — Task 7 step 4.
2. `/prompt:show` shows distinct sections for identity (p=10), available-agents (p=150), available-skills (p=160), saved-memories (p=170), and the API surface (p=100) — Task 7 step 5.
3. No plugin remains subscribed to `llm:before-call` for system-prompt mutation — Task 6 grep audit.
4. MCP normalized-name collisions emit `mcp:registration-conflict` with raw server names — Task 5 test.
5. Successive turns with no tool changes produce byte-identical SYSTEM PROMPT blocks — Task 7 step 6.
