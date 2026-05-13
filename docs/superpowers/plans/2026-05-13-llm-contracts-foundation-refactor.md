# `llm-contracts` Foundation Refactor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Centralize every cross-plugin service contract in a new `llm-contracts` plugin so that any implementation plugin in the openai-compatible harness can be replaced by inserting a substitute without modifying any other plugin.

**Architecture:** A new pure type+declaration plugin (`llm-contracts`) defines all 17 service contracts and exports their TypeScript types. Implementation plugins keep their `provideService` calls but stop calling `defineService`, and import contract types from `llm-contracts/public` rather than from each other.

**Tech Stack:** Bun, TypeScript, Kaizen plugin runtime (`KaizenPlugin` from `kaizen/types`), `bun:test`.

**Spec:** `docs/superpowers/specs/2026-05-13-llm-contracts-foundation-refactor-design.md`

---

## Reference: Migration Procedure

Every Phase 2 task instantiates this procedure with specific values. Read this once; each task lists its parameters.

**Inputs per task:**
- `NEW_ID` — target contract ID (e.g. `events:vocabulary`)
- `OLD_ID` — current contract ID (may equal `NEW_ID`)
- `CONTRACT_MODULE` — filename in `plugins/llm-contracts/contracts/` (e.g. `events.ts`)
- `TYPE_NAMES` — TypeScript type names that move (e.g. `Vocab`, `EventName`)
- `TYPE_SOURCE` — file the types currently live in
- `DESCRIPTION` — short description string for `defineService`
- `IMPL_PLUGIN` — directory under `plugins/` that owns the provider
- `CONSUMERS` — list of plugin directories that consume the contract

**Procedure steps:**

1. **Create the contracts module.** Write `plugins/llm-contracts/contracts/<CONTRACT_MODULE>` containing the relocated type declarations (copied verbatim from `<TYPE_SOURCE>`, with all imports adjusted to point inside `llm-contracts` or to upstream packages — never back to the implementation plugin).
2. **Re-export from public.** Add `export type { <TYPE_NAMES> } from "./contracts/<bare-module-name>";` to `plugins/llm-contracts/public.d.ts`.
3. **Register the contract.** In `plugins/llm-contracts/index.ts`, inside the plugin's `setup(ctx)`, add `ctx.defineService("<NEW_ID>", { description: "<DESCRIPTION>" });`.
4. **Update the implementation plugin.**
   - In `plugins/<IMPL_PLUGIN>/index.ts`: delete the `ctx.defineService("<OLD_ID>", ...)` line.
   - Change `ctx.provideService<X>("<OLD_ID>", impl)` → `ctx.provideService<X>("<NEW_ID>", impl)`.
   - Change the import of `<TYPE_NAMES>` from its current source to `import type { <TYPE_NAMES> } from "llm-contracts/public";`.
   - Update `services.provides` array: replace `"<OLD_ID>"` with `"<NEW_ID>"`.
   - If the implementation plugin's `public.d.ts` re-exports the contract types, delete those re-exports (the canonical source is `llm-contracts/public` now). Update any internal imports in the plugin's own modules accordingly.
   - In `package.json`, add `"llm-contracts": "workspace:*"` to `dependencies` if not already present.
5. **Update consumers.** For each plugin in `<CONSUMERS>`:
   - Change `ctx.consumeService("<OLD_ID>")` → `ctx.consumeService("<NEW_ID>")`.
   - Change every `ctx.useService<X>("<OLD_ID>")` → `ctx.useService<X>("<NEW_ID>")`.
   - Change type imports for `<TYPE_NAMES>` to `import type { <TYPE_NAMES> } from "llm-contracts/public";`.
   - Update `services.consumes` array entries: replace `"<OLD_ID>"` with `"<NEW_ID>"`.
   - In `package.json`, add `"llm-contracts": "workspace:*"` to `dependencies` if not already present.
6. **Build affected plugins.** From repo root: `bun install`, then `bun --filter '<IMPL_PLUGIN>' run typecheck` and the same for each consumer (use `bun run typecheck` directly inside each plugin dir if no workspace filter exists — see "Per-plugin build" below).
7. **Run tests for affected plugins.** `cd plugins/<IMPL_PLUGIN> && bun test`; same for each consumer.
8. **Verify the harness boots.** Local-deploy `llm-contracts` and every affected plugin (see "Local deploy" below). Launch the harness once via the user's normal entry point and confirm no boot errors.
9. **Run the substitutability acid test for this contract.** See "Acid test" below — only the abbreviated form is required per contract; the full Phase 4 verification covers cross-cutting cases.
10. **Commit.** `git add -A && git commit -m "refactor: migrate <NEW_ID> to llm-contracts"`.

## Reference: Per-plugin build

Each plugin uses Bun and TypeScript. Inside a plugin directory:

```bash
bun install                        # rare; only needed when package.json changed
bun tsc --noEmit                   # typecheck
bun test                           # run unit tests
```

If a plugin lacks a `typecheck` script, run `bun tsc --noEmit` directly.

## Reference: Local deploy

The Kaizen runtime loads `dist/index.js` (the bundle) in preference to source. After editing a plugin, re-bundle into the local marketplace install path:

```bash
PLUGIN=llm-contracts
VERSION=$(jq -r .version plugins/$PLUGIN/package.json)
INSTALL_DIR=~/.kaizen/marketplaces/official/plugins/${PLUGIN}@${VERSION}

mkdir -p "$INSTALL_DIR"
cp -R plugins/$PLUGIN/. "$INSTALL_DIR/"
(cd "$INSTALL_DIR" && bun build --target=bun --outfile=dist/index.js index.ts)
```

Do this for every plugin modified in a task before validating the harness boots.

## Reference: Acid test (abbreviated, per task)

After completing a contract migration, prove substitutability minimally:

1. Create a throwaway file `plugins/_acidtest/<NEW_ID-slugged>/index.ts` containing a no-op plugin that calls `ctx.provideService("<NEW_ID>", <minimal-stub>)`.
2. In `harnesses/openai-compatible.json`, temporarily swap the implementation plugin entry for `official/_acidtest-<slug>@0.1.0`.
3. Boot the harness. Confirm it does not error during plugin setup (the affected feature will not work; that is expected).
4. Restore the original manifest entry. Delete the throwaway plugin directory. **Do not commit acid-test scaffolding.**

The full acid test for every plugin runs in Phase 4 against a more rigorous test fixture.

---

## File Structure

**New files (Phase 1):**

```
plugins/llm-contracts/
  package.json
  tsconfig.json
  README.md
  CLAUDE.md
  index.ts
  public.d.ts
  contracts/                       # populated incrementally by Phase 2 tasks
    .gitkeep
```

**New file (Phase 1 manifest update):**

```
harnesses/openai-compatible.json   # MODIFIED: prepend llm-contracts entry
```

**Files modified per Phase 2 task** — listed individually in each task.

**Files modified in Phase 3:**

```
plugins/llm-codemode/index.ts          # role audit outcome
plugins/llm-codemode/README.md         # role documentation
docs/superpowers/specs/2026-05-13-llm-contracts-foundation-refactor-design.md  # add hard-vs-optional table
plugins/<each>/README.md               # documentation sweep
plugins/<each>/CLAUDE.md               # documentation sweep
plugins/llm-contracts/README.md        # full pattern description
```

**Phase 4 produces no committed code changes** — only a verified-passing acid test report appended to the spec or this plan.

---

## Phase 1 — Scaffolding

### Task 1: Create the `llm-contracts` plugin scaffold

**Files:**
- Create: `plugins/llm-contracts/package.json`
- Create: `plugins/llm-contracts/tsconfig.json`
- Create: `plugins/llm-contracts/index.ts`
- Create: `plugins/llm-contracts/public.d.ts`
- Create: `plugins/llm-contracts/README.md`
- Create: `plugins/llm-contracts/CLAUDE.md`
- Create: `plugins/llm-contracts/contracts/.gitkeep`
- Modify: `harnesses/openai-compatible.json`

- [ ] **Step 1: Create the package.json.**

Write `plugins/llm-contracts/package.json`:

```json
{
  "name": "llm-contracts",
  "version": "0.1.0",
  "description": "Service contract definitions for the openai-compatible harness. Pure types + defineService; no runtime behavior.",
  "type": "module",
  "exports": {
    ".": "./index.ts",
    "./public": "./public.d.ts"
  },
  "keywords": ["kaizen-plugin"],
  "devDependencies": {
    "@types/bun": "latest",
    "@types/json-schema": "^7.0.15",
    "typescript": "^5.4.0"
  }
}
```

- [ ] **Step 2: Create the tsconfig.json.**

Write `plugins/llm-contracts/tsconfig.json` (matches the convention used by `llm-tools-registry` and others):

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

- [ ] **Step 3: Create the empty contracts directory.**

```bash
mkdir -p plugins/llm-contracts/contracts
touch plugins/llm-contracts/contracts/.gitkeep
```

- [ ] **Step 4: Create the public.d.ts stub.**

Write `plugins/llm-contracts/public.d.ts`:

```typescript
// Public type surface for llm-contracts.
// Each Phase 2 task adds one export line corresponding to its migrated contract.
export {};
```

- [ ] **Step 5: Create the index.ts skeleton.**

Write `plugins/llm-contracts/index.ts`:

```typescript
import type { KaizenPlugin } from "kaizen/types";

const plugin: KaizenPlugin = {
  name: "llm-contracts",
  apiVersion: "3.0.0",
  permissions: { tier: "unscoped" },
  services: { provides: [], consumes: [] },

  async setup(ctx) {
    // Contract definitions are added by Phase 2 migration tasks.
    // Each migration adds one `ctx.defineService("<id>", { description: "..." });` line here.
    void ctx;
  },
};

export default plugin;
```

- [ ] **Step 6: Write the README.**

Write `plugins/llm-contracts/README.md`:

```markdown
# llm-contracts

The contract foundation for the openai-compatible Kaizen harness. This plugin
defines every cross-plugin service contract and exports their TypeScript
types. It has zero runtime behavior — no `provideService` calls, no event
subscriptions, no UI mutation.

## Why this exists

Service contracts are the integration surface between plugins. If a contract
is defined inside the plugin that provides it, replacing that plugin with a
different implementation also removes the contract definition — every
consumer breaks. By centralizing definitions here, any implementation plugin
in the harness can be replaced by inserting a substitute that imports the
same types from `llm-contracts/public` and calls `provideService` with the
same contract IDs.

## What's inside

- `contracts/<topic>.ts` — one file per contract. Contains the TypeScript
  interface(s), the contract ID constant, and the description string.
- `index.ts` — calls `defineService` for every contract at plugin setup.
- `public.d.ts` — re-exports every contract type for consumers and providers
  to import.

## How to add a new contract

1. Add `plugins/llm-contracts/contracts/<topic>.ts` with the type, the
   contract ID, and the description.
2. Re-export the type from `public.d.ts`.
3. Add a `defineService` call in `index.ts`.
4. Ship implementation and consumer plugins that import from
   `llm-contracts/public`.

## Naming convention for contract IDs

`<domain>:<role>` — both halves lowercase, kebab-case allowed, exactly one
colon, no plugin-name prefixes. See the design spec for the full convention.
```

- [ ] **Step 7: Write the CLAUDE.md.**

Write `plugins/llm-contracts/CLAUDE.md`:

```markdown
# Working in `llm-contracts`

Notes for agents editing this plugin. See `README.md` for the user-facing contract.

## Invariants

- **Zero runtime behavior.** No `provideService`, no `ctx.on(...)`, no
  `useService`. Only `defineService` calls and type declarations.
- **No dependency on any other plugin.** Importing types from
  `llm-events/public` or `llm-driver/public` is forbidden — those types live
  here now.
- **One contracts/*.ts module per contract.** Don't merge unrelated contracts
  into one file even if they're short. The 1:1 mapping makes substitution and
  audit easier.
- **Every type a non-provider plugin needs lives in `public.d.ts`.** If a
  consumer plugin imports a type from anywhere other than `llm-contracts/public`,
  that type belongs here.

## Adding a contract

1. Create `contracts/<topic>.ts` with the interface(s), an exported
   `CONTRACT_ID` constant, and an exported `DESCRIPTION` constant.
2. Re-export the type(s) from `public.d.ts`.
3. In `index.ts`, import the module and add
   `ctx.defineService(<topic>.CONTRACT_ID, { description: <topic>.DESCRIPTION });`.

## Testing

This plugin has no runtime to test. Tests verify only that `defineService` is
called for every declared contract at setup time. Add cases to
`test/index.test.ts` as contracts are added.

## Local deploy

```bash
cp -R plugins/llm-contracts/. ~/.kaizen/marketplaces/official/plugins/llm-contracts@0.1.0/
(cd ~/.kaizen/marketplaces/official/plugins/llm-contracts@0.1.0 \
  && bun build --target=bun --outfile=dist/index.js index.ts)
```
```

- [ ] **Step 8: Add the plugin to the harness manifest.**

Edit `harnesses/openai-compatible.json` to prepend `llm-contracts` as the first plugin in the array:

```json
{
  "plugins": [
    "official/llm-contracts@0.1.0",
    "official/llm-events@0.7.0",
    "official/llm-session-manager@0.1.1",
    "official/openai-llm@0.1.0",
    "official/llm-tools-registry@0.3.0",
    "official/llm-local-tools@0.2.0",
    "official/llm-tavily-search@0.1.0",
    "official/llm-mcp-bridge@0.1.2",
    "official/llm-skills@0.1.2",
    "official/llm-memory@0.1.2",
    "official/llm-agents@0.2.1",
    "official/llm-slash-commands@0.2.1",
    "official/llm-system-prompt@0.1.0",
    "official/llm-native-dispatch@0.3.1",
    "official/llm-codemode@0.3.0",
    "official/llm-driver@0.2.1",
    "official/llm-status-items@0.1.1",
    "official/llm-hooks-shell@0.1.1",
    "official/llm-tui@0.2.0"
  ]
}
```

- [ ] **Step 9: Run typecheck.**

```bash
cd plugins/llm-contracts && bun tsc --noEmit
```

Expected: passes with no output.

- [ ] **Step 10: Local-deploy the new plugin.**

```bash
mkdir -p ~/.kaizen/marketplaces/official/plugins/llm-contracts@0.1.0
cp -R plugins/llm-contracts/. ~/.kaizen/marketplaces/official/plugins/llm-contracts@0.1.0/
(cd ~/.kaizen/marketplaces/official/plugins/llm-contracts@0.1.0 \
  && bun build --target=bun --outfile=dist/index.js index.ts)
```

Expected: bundle created at `dist/index.js`.

- [ ] **Step 11: Boot the harness to confirm no regression.**

Launch the harness once via the user's normal entry. The plugin should load with no defines yet; behavior is unchanged from baseline.

- [ ] **Step 12: Commit.**

```bash
git add plugins/llm-contracts harnesses/openai-compatible.json
git commit -m "feat(llm-contracts): scaffold contract foundation plugin"
```

---

## Phase 2 — Per-contract migration

Each task instantiates the migration procedure. The full procedure is in "Reference: Migration Procedure" above. Per-task content lists only what differs.

### Task 2: Migrate `events:vocabulary`

**Files:**
- Create: `plugins/llm-contracts/contracts/events.ts`
- Modify: `plugins/llm-contracts/index.ts`
- Modify: `plugins/llm-contracts/public.d.ts`
- Modify: `plugins/llm-events/index.ts`
- Modify: `plugins/llm-events/public.d.ts`
- Modify: `plugins/llm-events/package.json`
- Modify in every consumer: `index.ts`, `package.json` (see consumer list)
- Modify: `plugins/llm-driver/public.d.ts` (drops the re-export from llm-events/public for `Vocab` if present)

**Migration inputs:**
- `NEW_ID`: `events:vocabulary`
- `OLD_ID`: `llm-events:vocabulary`
- `CONTRACT_MODULE`: `events.ts`
- `TYPE_NAMES`: `Vocab`, `EventName`
- `TYPE_SOURCE`: `plugins/llm-events/public.d.ts` (the `Vocab` interface and `EventName` type)
- `DESCRIPTION`: `"Canonical event-name vocabulary for the harness."`
- `IMPL_PLUGIN`: `llm-events`
- `CONSUMERS`: `llm-tools-registry`, `llm-session-manager`, `llm-driver`, `openai-llm`, `llm-hooks-shell`, `llm-status-items`, `llm-system-prompt`

- [ ] **Step 1: Create `plugins/llm-contracts/contracts/events.ts`.**

Copy the `Vocab` interface and `EventName` type from `plugins/llm-events/public.d.ts` (the entire `interface Vocab { ... }` block and the `export type EventName = Vocab[keyof Vocab];` line) into the new file. Then add at the bottom:

```typescript
export const CONTRACT_ID = "events:vocabulary" as const;
export const DESCRIPTION = "Canonical event-name vocabulary for the harness.";
```

- [ ] **Step 2: Add to `plugins/llm-contracts/public.d.ts`.**

```typescript
export type { Vocab, EventName } from "./contracts/events";
```

- [ ] **Step 3: Add `defineService` to `plugins/llm-contracts/index.ts`.**

Add to the top of the file:

```typescript
import * as eventsContract from "./contracts/events";
```

Inside `setup(ctx)`, add:

```typescript
ctx.defineService(eventsContract.CONTRACT_ID, { description: eventsContract.DESCRIPTION });
```

Also update the descriptor:

```typescript
services: { provides: [], consumes: [] },   // unchanged — llm-contracts itself doesn't provide or consume
```

- [ ] **Step 4: Update `plugins/llm-events/index.ts`.**

Open the file. Locate the `setup(ctx)` body. Remove the line `ctx.defineService("llm-events:vocabulary", { ... });`. Change `ctx.provideService<Vocab>("llm-events:vocabulary", VOCAB)` → `ctx.provideService<Vocab>("events:vocabulary", VOCAB)`. Change the `import { Vocab }` line to `import type { Vocab } from "llm-contracts/public";`. Update the descriptor: `services.provides` becomes `["events:vocabulary"]`.

**Leave the `ctx.defineService("llm:complete", ...)` line intact for now.** That contract is migrated in Task 3; removing its definition here before Task 3 has added it to `llm-contracts` would leave it undefined between commits.

- [ ] **Step 5: Update `plugins/llm-events/public.d.ts`.**

Remove the `Vocab` interface and `EventName` type from this file. Replace with a re-export from `llm-contracts/public`:

```typescript
export type { Vocab, EventName } from "llm-contracts/public";
```

Keep the other types (`ChatMessage`, `ToolCall`, `ToolSchema`, `LLMRequest`, `LLMResponse`, `LLMStreamEvent`, `LLMCompleteService`, `ModelInfo`) in this file — they are migrated in Task 3.

- [ ] **Step 6: Update `plugins/llm-events/package.json`.**

Add `"llm-contracts": "workspace:*"` to `dependencies`.

- [ ] **Step 7: Update every consumer's `index.ts`.**

For each plugin in `CONSUMERS`:

1. Open `plugins/<consumer>/index.ts`.
2. Change `ctx.consumeService("llm-events:vocabulary")` → `ctx.consumeService("events:vocabulary")` (if present).
3. Change `ctx.useService<Vocab>("llm-events:vocabulary")` → `ctx.useService<Vocab>("events:vocabulary")` (and all variants).
4. Change `services.consumes` array entries: replace `"llm-events:vocabulary"` with `"events:vocabulary"`.

The grep `grep -rn 'llm-events:vocabulary' plugins/<consumer>/` will surface every reference.

- [ ] **Step 8: Update every consumer's `package.json`.**

Add `"llm-contracts": "workspace:*"` to `dependencies` if not already present.

- [ ] **Step 9: Update consumer type imports.**

For each consumer that imports `Vocab` or `EventName`: change `import { Vocab } from "llm-events/public"` (or similar) → `import type { Vocab } from "llm-contracts/public"`. Same for `EventName`. Grep first: `grep -rn 'from "llm-events/public"' plugins/<consumer>/`.

- [ ] **Step 10: Re-install workspace dependencies.**

```bash
bun install
```

- [ ] **Step 11: Typecheck each affected plugin.**

```bash
for p in llm-contracts llm-events llm-tools-registry llm-session-manager llm-driver openai-llm llm-hooks-shell llm-status-items llm-system-prompt; do
  echo "=== $p ==="
  (cd plugins/$p && bun tsc --noEmit) || break
done
```

Expected: each passes with no output.

- [ ] **Step 12: Run tests for each affected plugin.**

```bash
for p in llm-contracts llm-events llm-tools-registry llm-session-manager llm-driver openai-llm llm-hooks-shell llm-status-items llm-system-prompt; do
  echo "=== $p ==="
  (cd plugins/$p && bun test) || break
done
```

Expected: each passes.

- [ ] **Step 13: Local-deploy every modified plugin.**

```bash
for p in llm-contracts llm-events llm-tools-registry llm-session-manager llm-driver openai-llm llm-hooks-shell llm-status-items llm-system-prompt; do
  VERSION=$(jq -r .version plugins/$p/package.json)
  INSTALL_DIR=~/.kaizen/marketplaces/official/plugins/${p}@${VERSION}
  mkdir -p "$INSTALL_DIR"
  cp -R plugins/$p/. "$INSTALL_DIR/"
  (cd "$INSTALL_DIR" && bun build --target=bun --outfile=dist/index.js index.ts)
done
```

- [ ] **Step 14: Boot the harness.**

Launch via the user's normal entry. Confirm clean boot.

- [ ] **Step 15: Commit.**

```bash
git add -A
git commit -m "refactor: migrate events:vocabulary to llm-contracts"
```

---

### Task 3: Migrate `llm:complete`

**Files:**
- Create: `plugins/llm-contracts/contracts/llm-complete.ts`
- Modify: `plugins/llm-contracts/index.ts`
- Modify: `plugins/llm-contracts/public.d.ts`
- Modify: `plugins/llm-events/public.d.ts` (remove migrated types)
- Modify: `plugins/openai-llm/index.ts` (already provides — only updates imports)
- Modify: `plugins/openai-llm/package.json`
- Modify in every consumer that uses `LLMCompleteService`: `llm-driver`, `llm-status-items` (verify via grep)

**Migration inputs:**
- `NEW_ID`: `llm:complete`
- `OLD_ID`: `llm:complete` (unchanged)
- `CONTRACT_MODULE`: `llm-complete.ts`
- `TYPE_NAMES`: `LLMCompleteService`, `LLMRequest`, `LLMResponse`, `LLMStreamEvent`, `ModelInfo`
- `TYPE_SOURCE`: `plugins/llm-events/public.d.ts`
- `DESCRIPTION`: `"LLM completion service — request/stream/response interface."`
- `IMPL_PLUGIN`: `openai-llm`
- `CONSUMERS`: `llm-driver`, `llm-status-items`

Also migrate `ChatMessage`, `ToolCall`, `ToolSchema` here — they are LLM-vocabulary types used everywhere and naturally live with `LLMCompleteService`. Update the inputs:
- Additional `TYPE_NAMES`: `ChatMessage`, `ToolCall`, `ToolSchema`
- Additional consumers (because everything imports `ChatMessage` etc. from `llm-events/public` today): `llm-tools-registry`, `llm-session-manager`, `llm-skills`, `llm-memory`, `llm-agents`, `llm-mcp-bridge`, `llm-slash-commands`, `llm-system-prompt`, `llm-native-dispatch`, `llm-codemode`, `llm-tui`, `llm-local-tools`, `llm-tavily-search`, `llm-hooks-shell`

- [ ] **Step 1: Create `plugins/llm-contracts/contracts/llm-complete.ts`.**

Copy from `plugins/llm-events/public.d.ts` the following declarations verbatim into the new file: `ChatMessage`, `ToolCall`, `ToolSchema`, `ModelInfo`, `LLMRequest`, `LLMResponse`, `LLMStreamEvent`, `LLMCompleteService`. Preserve the `import type { JSONSchema7 } from "json-schema";` at the top if it's referenced by `ToolSchema`. Append:

```typescript
export const CONTRACT_ID = "llm:complete" as const;
export const DESCRIPTION = "LLM completion service — request/stream/response interface.";
```

- [ ] **Step 2: Add to `plugins/llm-contracts/public.d.ts`.**

```typescript
export type {
  ChatMessage,
  ToolCall,
  ToolSchema,
  ModelInfo,
  LLMRequest,
  LLMResponse,
  LLMStreamEvent,
  LLMCompleteService,
} from "./contracts/llm-complete";
```

- [ ] **Step 3: Register the contract in `plugins/llm-contracts/index.ts`.**

Add import:

```typescript
import * as llmCompleteContract from "./contracts/llm-complete";
```

Inside `setup(ctx)`:

```typescript
ctx.defineService(llmCompleteContract.CONTRACT_ID, { description: llmCompleteContract.DESCRIPTION });
```

- [ ] **Step 4: Update `plugins/llm-events/public.d.ts`.**

Remove the type declarations for `ChatMessage`, `ToolCall`, `ToolSchema`, `ModelInfo`, `LLMRequest`, `LLMResponse`, `LLMStreamEvent`, `LLMCompleteService`. Replace with re-exports:

```typescript
export type {
  Vocab,
  EventName,
  ChatMessage,
  ToolCall,
  ToolSchema,
  ModelInfo,
  LLMRequest,
  LLMResponse,
  LLMStreamEvent,
  LLMCompleteService,
} from "llm-contracts/public";
```

(`Vocab` / `EventName` were already re-exported in Task 2; combine into one export block.)

- [ ] **Step 5: Update `plugins/openai-llm/index.ts`.**

The plugin already calls `provideService<LLMCompleteService>("llm:complete", ...)`. The only changes are:

1. Change the type import: `import type { LLMCompleteService } from "llm-events/public"` (or wherever) → `import type { LLMCompleteService } from "llm-contracts/public";`.
2. Update `services.consumes` if `"llm-events:vocabulary"` appears — change to `"events:vocabulary"` (already done in Task 2 but verify).

- [ ] **Step 6: Update `plugins/openai-llm/package.json`.**

Add `"llm-contracts": "workspace:*"` to `dependencies`.

- [ ] **Step 7: Update every consumer.**

For each plugin in the full consumer list:

1. Grep for `from "llm-events/public"` and `from "llm-events"`. Each import that references one of the migrated types should be split or rewritten so the migrated types come from `llm-contracts/public`.

   Example before:
   ```typescript
   import type { ChatMessage, Vocab } from "llm-events/public";
   ```
   Example after:
   ```typescript
   import type { ChatMessage, Vocab } from "llm-contracts/public";
   ```

   Both `ChatMessage` and `Vocab` are re-exported from `llm-events/public` after Task 2/3, so technically the old import still resolves. Prefer the direct import: it is the spec's stated type-ownership rule.

2. `package.json`: add `"llm-contracts": "workspace:*"` if not present.

- [ ] **Step 8: Update `plugins/llm-driver/public.d.ts`.**

`llm-driver/public.d.ts` re-exports `ChatMessage`, `ToolCall`, `ToolSchema`, `LLMRequest`, `LLMResponse`, `LLMStreamEvent`, `LLMCompleteService` from `llm-events/public`. Change the source:

```typescript
export type {
  ChatMessage,
  ToolCall,
  ToolSchema,
  LLMRequest,
  LLMResponse,
  LLMStreamEvent,
  LLMCompleteService,
} from "llm-contracts/public";
```

Same for the internal `import type` line lower in the file that imports `ChatMessage`, `LLMResponse`, `ToolSchema` from `llm-events/public` — change to `llm-contracts/public`.

- [ ] **Step 9: Re-install, typecheck, test, deploy, boot, commit.**

```bash
bun install
for p in llm-contracts llm-events openai-llm llm-driver llm-status-items llm-tools-registry llm-session-manager llm-skills llm-memory llm-agents llm-mcp-bridge llm-slash-commands llm-system-prompt llm-native-dispatch llm-codemode llm-tui llm-local-tools llm-tavily-search llm-hooks-shell; do
  echo "=== $p ==="
  (cd plugins/$p && bun tsc --noEmit && bun test) || break
done
```

If all pass: local-deploy each (script from Task 2 Step 13, applied to this plugin list), boot the harness, and commit:

```bash
git add -A
git commit -m "refactor: migrate llm:complete and core message types to llm-contracts"
```

---

### Task 4: Migrate `sessions:store`

**Files:**
- Create: `plugins/llm-contracts/contracts/sessions-store.ts`
- Modify: `plugins/llm-contracts/index.ts`
- Modify: `plugins/llm-contracts/public.d.ts`
- Modify: `plugins/llm-session-manager/index.ts`
- Modify: `plugins/llm-session-manager/public.d.ts`
- Modify: `plugins/llm-session-manager/package.json`
- Modify in consumers: `plugins/llm-driver/index.ts`, `plugins/llm-driver/public.d.ts`, `plugins/llm-agents/index.ts`, `plugins/llm-status-items/index.ts`, any other consumer

**Migration inputs:**
- `NEW_ID`: `sessions:store`
- `OLD_ID`: `sessions:store`
- `CONTRACT_MODULE`: `sessions-store.ts`
- `TYPE_NAMES`: `SessionsStoreService`, `SessionRecord`, `TurnHandle`
- `TYPE_SOURCE`: `plugins/llm-session-manager/store.ts` (the file `public.d.ts` re-exports from)
- `DESCRIPTION`: `"Persistent session store — CRUD over conversation messages and metadata."`
- `IMPL_PLUGIN`: `llm-session-manager`
- `CONSUMERS`: `llm-driver`, `llm-agents`, `llm-status-items` (and any others — grep first: `grep -rn 'sessions:store' plugins/ --include='*.ts' | grep -v node_modules`)

- [ ] **Step 1: Identify the exact type shape.**

Read `plugins/llm-session-manager/store.ts` and extract `SessionsStoreService`, `SessionRecord`, `TurnHandle` interface declarations.

- [ ] **Step 2: Create `plugins/llm-contracts/contracts/sessions-store.ts`.**

Paste the extracted interfaces verbatim. Replace any imports of `ChatMessage` or other migrated types with `import type { ChatMessage } from "../public";` (relative inside `llm-contracts` — the type already lives in `public.d.ts`). Append:

```typescript
export const CONTRACT_ID = "sessions:store" as const;
export const DESCRIPTION = "Persistent session store — CRUD over conversation messages and metadata.";
```

- [ ] **Step 3: Re-export from `plugins/llm-contracts/public.d.ts`.**

```typescript
export type { SessionsStoreService, SessionRecord, TurnHandle } from "./contracts/sessions-store";
```

- [ ] **Step 4: Register in `plugins/llm-contracts/index.ts`.**

```typescript
import * as sessionsStoreContract from "./contracts/sessions-store";
// inside setup():
ctx.defineService(sessionsStoreContract.CONTRACT_ID, { description: sessionsStoreContract.DESCRIPTION });
```

- [ ] **Step 5: Update `plugins/llm-session-manager/index.ts`.**

- Remove the `ctx.defineService("sessions:store", { ... });` line.
- Keep the `ctx.provideService<SessionsStoreService>("sessions:store", store);` line.
- Change the `import type { SessionsStoreService }` source to `import type { SessionsStoreService } from "llm-contracts/public";`.
- `services.provides`: unchanged (already `["sessions:store"]`).

- [ ] **Step 6: Update `plugins/llm-session-manager/public.d.ts`.**

Replace local re-exports of `SessionsStoreService`, `SessionRecord`, `TurnHandle` with re-exports from `llm-contracts/public`:

```typescript
export type { SessionsStoreService, SessionRecord, TurnHandle } from "llm-contracts/public";
export type { EventLogEntry } from "./events-log";
export { harnessKey } from "./harness-key";
```

Keep the non-contract exports.

- [ ] **Step 7: Update `plugins/llm-session-manager/store.ts` and any other internal files.**

Internal files in this plugin that define `SessionsStoreService` / `SessionRecord` / `TurnHandle` should now either delete those declarations (use them from `llm-contracts/public`) or keep them only if they are internal-implementation-specific. The exported public ones must come from `llm-contracts`.

- [ ] **Step 8: Add `llm-contracts` to `package.json` dependencies.**

```json
"dependencies": {
  ...,
  "llm-contracts": "workspace:*"
}
```

- [ ] **Step 9: Update each consumer.**

For each consumer plugin (run `grep -rln 'sessions:store\|SessionsStoreService\|SessionRecord\|TurnHandle' plugins/ --include='*.ts' | grep -v node_modules | grep -v llm-session-manager | grep -v llm-contracts` to enumerate):

1. Change type imports for `SessionsStoreService`, `SessionRecord`, `TurnHandle` to come from `llm-contracts/public`.
2. `services.consumes` / `consumeService` / `useService` calls already use `"sessions:store"` — no string change.
3. `package.json`: add `"llm-contracts": "workspace:*"`.

`llm-driver/public.d.ts` imports `TurnHandle` from `llm-session-manager/public`. Update that line to import from `llm-contracts/public`.

- [ ] **Step 10: bun install, typecheck, test, deploy, boot, commit.**

```bash
bun install
# typecheck and test each affected plugin (llm-contracts + llm-session-manager + every consumer)
# local-deploy each
git add -A
git commit -m "refactor: migrate sessions:store to llm-contracts"
```

---

### Task 5: Migrate `tools:registry`

**Files:**
- Create: `plugins/llm-contracts/contracts/tools-registry.ts`
- Modify: `plugins/llm-contracts/index.ts`
- Modify: `plugins/llm-contracts/public.d.ts`
- Modify: `plugins/llm-tools-registry/index.ts`
- Modify: `plugins/llm-tools-registry/public.d.ts`
- Modify: `plugins/llm-tools-registry/registry.ts` (move contract types out)
- Modify: `plugins/llm-tools-registry/package.json`
- Modify in consumers: `llm-local-tools`, `llm-tavily-search`, `llm-mcp-bridge`, `llm-skills`, `llm-memory`, `llm-agents`, `llm-native-dispatch`, `llm-codemode`, `llm-driver`

**Migration inputs:**
- `NEW_ID`: `tools:registry`
- `OLD_ID`: `tools:registry`
- `CONTRACT_MODULE`: `tools-registry.ts`
- `TYPE_NAMES`: `ToolsRegistryService`, `ToolHandler`, `ToolExecutionContext`, `CANCEL_TOOL`
- `TYPE_SOURCE`: `plugins/llm-tools-registry/registry.ts` (per the plugin's CLAUDE.md, types are defined here)
- `DESCRIPTION`: `"Central tool registry — registration, lookup, and single tool-execution chokepoint."`
- `IMPL_PLUGIN`: `llm-tools-registry`
- `CONSUMERS`: enumerate via grep

- [ ] **Step 1: Read source types.**

Read `plugins/llm-tools-registry/registry.ts` for the `ToolsRegistryService`, `ToolHandler`, `ToolExecutionContext` exported types and the `CANCEL_TOOL` constant.

- [ ] **Step 2: Create contracts module.**

Write `plugins/llm-contracts/contracts/tools-registry.ts`. Copy the type declarations and the `CANCEL_TOOL` constant verbatim. Replace `import { ToolSchema, ToolCall } from "llm-events/public"` (or similar) with `import type { ToolSchema, ToolCall } from "../public";`. Append:

```typescript
export const CONTRACT_ID = "tools:registry" as const;
export const DESCRIPTION = "Central tool registry — registration, lookup, and single tool-execution chokepoint.";
```

Note: `CANCEL_TOOL` is a runtime value (`Symbol.for("kaizen.cancel")`), not a type. Export it as a `const` from this contracts module so consumers import it from `llm-contracts/public` (you'll need to widen `public.d.ts` to also surface values; see Step 3).

- [ ] **Step 3: Re-export from `public.d.ts`.**

Add to `plugins/llm-contracts/public.d.ts`:

```typescript
export type { ToolsRegistryService, ToolHandler, ToolExecutionContext } from "./contracts/tools-registry";
export { CANCEL_TOOL } from "./contracts/tools-registry";
```

Since `public.d.ts` is now exporting a runtime value (`CANCEL_TOOL`), rename it to `public.ts` if Bun/TS module resolution refuses `.d.ts` runtime exports. Test resolution with `bun tsc --noEmit` before committing.

If a rename is needed, also update `plugins/llm-contracts/package.json`:

```json
"exports": {
  ".": "./index.ts",
  "./public": "./public.ts"
}
```

- [ ] **Step 4: Register in `plugins/llm-contracts/index.ts`.**

```typescript
import * as toolsRegistryContract from "./contracts/tools-registry";
// inside setup():
ctx.defineService(toolsRegistryContract.CONTRACT_ID, { description: toolsRegistryContract.DESCRIPTION });
```

- [ ] **Step 5: Update `plugins/llm-tools-registry/index.ts`.**

- Remove the `ctx.defineService("tools:registry", { ... });` line.
- Keep `ctx.provideService<ToolsRegistryService>("tools:registry", registry);`.
- Change `import type { ToolsRegistryService } from "./registry.ts"` → `import type { ToolsRegistryService } from "llm-contracts/public";`.
- `services.provides` unchanged.

- [ ] **Step 6: Update `plugins/llm-tools-registry/registry.ts`.**

Remove the `export interface ToolsRegistryService`, `export type ToolHandler`, `export interface ToolExecutionContext`, and `export const CANCEL_TOOL = ...` declarations. Import them from `llm-contracts/public` and use them internally as needed:

```typescript
import type { ToolsRegistryService, ToolHandler, ToolExecutionContext } from "llm-contracts/public";
import { CANCEL_TOOL } from "llm-contracts/public";
```

Keep the implementation function `makeRegistry(emit): ToolsRegistryService` and any internal-only types.

- [ ] **Step 7: Update `plugins/llm-tools-registry/public.d.ts`.**

Replace the contract re-exports with re-exports from `llm-contracts/public`:

```typescript
export type { ToolsRegistryService, ToolHandler, ToolExecutionContext } from "llm-contracts/public";
export { CANCEL_TOOL } from "llm-contracts/public";
export type { ToolSchema, ToolCall, ChatMessage } from "llm-contracts/public";
```

- [ ] **Step 8: Add `llm-contracts` to package.json.**

- [ ] **Step 9: Update each consumer.**

For each in the consumer list:

- Change type imports from `llm-tools-registry/public` to `llm-contracts/public` (for the contract types — `ToolsRegistryService` etc.).
- Plugin-internal types not in the contract (e.g. `SlashRegistryLike` if any) stay with their original source.
- Change runtime imports of `CANCEL_TOOL` from `llm-tools-registry/public` → `llm-contracts/public`.
- `package.json`: add `"llm-contracts": "workspace:*"`.

- [ ] **Step 10: bun install, typecheck, test, deploy, boot, commit.**

```bash
git commit -m "refactor: migrate tools:registry to llm-contracts"
```

---

### Task 6: Migrate `prompt:registry` (renamed from `prompt:system`)

**Files:**
- Create: `plugins/llm-contracts/contracts/prompt-registry.ts`
- Modify: `plugins/llm-contracts/index.ts`, `public.d.ts`
- Modify: `plugins/llm-system-prompt/index.ts`, `public.d.ts`, `package.json`
- Modify in consumers: `llm-skills`, `llm-memory`, `llm-agents`, any other (grep first)

**Migration inputs:**
- `NEW_ID`: `prompt:registry`
- `OLD_ID`: `prompt:system`
- `CONTRACT_MODULE`: `prompt-registry.ts`
- `TYPE_NAMES`: `SystemPromptService`, `SystemPromptSection`, `RegisteredSection`
- `TYPE_SOURCE`: `plugins/llm-system-prompt/public.d.ts`
- `DESCRIPTION`: `"System prompt section registry — plugins register prompt contributors; consumers assemble the final prompt."`
- `IMPL_PLUGIN`: `llm-system-prompt`
- `CONSUMERS`: enumerate via `grep -rn 'prompt:system\|SystemPromptService' plugins/ --include='*.ts' | grep -v node_modules`

- [ ] **Step 1: Create contracts module.** Copy `SystemPromptService`, `SystemPromptSection`, `RegisteredSection` from `plugins/llm-system-prompt/public.d.ts` into `plugins/llm-contracts/contracts/prompt-registry.ts`. Append `CONTRACT_ID = "prompt:registry"` and `DESCRIPTION`.

- [ ] **Step 2: Re-export from `llm-contracts/public`.**

- [ ] **Step 3: Register `defineService` in `llm-contracts/index.ts`.**

- [ ] **Step 4: Update `plugins/llm-system-prompt/index.ts`.**

- Remove `ctx.defineService("prompt:system", { ... });`.
- Change `ctx.provideService<SystemPromptService>("prompt:system", registry)` → `ctx.provideService<SystemPromptService>("prompt:registry", registry)`.
- Update `services.provides`: `["prompt:system"]` → `["prompt:registry"]`.
- Change `SystemPromptService` import to `llm-contracts/public`.

- [ ] **Step 5: Update `plugins/llm-system-prompt/public.d.ts`** to re-export contract types from `llm-contracts/public`.

- [ ] **Step 6: Update consumers.** For each: change `useService<SystemPromptService>("prompt:system")` → `useService<SystemPromptService>("prompt:registry")`. Update `services.consumes` and `consumeService` strings the same way. Change type imports to `llm-contracts/public`. Add `llm-contracts` to dependencies.

- [ ] **Step 7: bun install, typecheck, test, deploy, boot, commit.**

```bash
git commit -m "refactor: migrate prompt:system to prompt:registry on llm-contracts"
```

---

### Task 7: Migrate `slash:registry`

**Files:** Mirrors Task 4 shape with these inputs:
- `NEW_ID`: `slash:registry`
- `OLD_ID`: `slash:registry`
- `CONTRACT_MODULE`: `slash-registry.ts`
- `TYPE_NAMES`: `SlashRegistryService`, `SlashCommandContext`, `SlashCommandHandler`, `SlashCommandManifest`, `SlashRegistryEntry`, `RegistryEntry`
- `TYPE_SOURCE`: `plugins/llm-slash-commands/registry.ts` (per the re-exports in its public.d.ts)
- `DESCRIPTION`: `"Slash-command registry — register, list, and dispatch user-typed slash commands."`
- `IMPL_PLUGIN`: `llm-slash-commands`
- `CONSUMERS`: `llm-tools-registry`, `llm-session-manager`, `llm-mcp-bridge`, `llm-status-items` (grep first)

The error classes (`BareNamePluginError`, `ReentrantSlashEmitError`, `DuplicateRegistrationError`, `InvalidNameError`) are runtime values — they stay in `plugins/llm-slash-commands/errors.ts` because they are part of the implementation's error vocabulary, not the contract surface. If consumers throw or catch these, document the dependency in the plugin's README.

- [ ] **Step 1: Read source types** from `plugins/llm-slash-commands/registry.ts`.

- [ ] **Step 2: Create `plugins/llm-contracts/contracts/slash-registry.ts`.** Copy interface declarations. Append `CONTRACT_ID` and `DESCRIPTION`.

- [ ] **Step 3: Re-export from `llm-contracts/public`.**

- [ ] **Step 4: Register in `llm-contracts/index.ts`.**

- [ ] **Step 5: Update `plugins/llm-slash-commands/index.ts`.** Remove `defineService`. Update type import. `services.provides` unchanged.

- [ ] **Step 6: Update `plugins/llm-slash-commands/public.d.ts`.** Re-export contract types from `llm-contracts/public`. Keep the error-class exports as-is.

- [ ] **Step 7: Update consumers.** Change type imports for the contract types to `llm-contracts/public`. Add `llm-contracts` to dependencies.

- [ ] **Step 8: bun install, typecheck, test, deploy, boot, commit.**

```bash
git commit -m "refactor: migrate slash:registry to llm-contracts"
```

---

### Task 8: Migrate `skills:registry`

**Inputs:**
- `NEW_ID`: `skills:registry`
- `OLD_ID`: `skills:registry`
- `CONTRACT_MODULE`: `skills-registry.ts`
- `TYPE_NAMES`: `SkillsRegistryService`, `SkillManifest`, `SkillRescanResult`
- `TYPE_SOURCE`: `plugins/llm-skills/public.d.ts`
- `DESCRIPTION`: `"Skills registry — skill discovery, on-demand loading, manifest listing."`
- `IMPL_PLUGIN`: `llm-skills`
- `CONSUMERS`: `llm-agents` (per the `hasSkills` lookup), and any others (grep)

- [ ] Steps 1-8 follow the standard migration procedure with the inputs above. Commit:

```bash
git commit -m "refactor: migrate skills:registry to llm-contracts"
```

---

### Task 9: Migrate `memory:store`

**Inputs:**
- `NEW_ID`: `memory:store`
- `OLD_ID`: `memory:store`
- `CONTRACT_MODULE`: `memory-store.ts`
- `TYPE_NAMES`: `MemoryStoreService`, `MemoryEntry`, `MemoryType`, `MemoryScope`
- `TYPE_SOURCE`: `plugins/llm-memory/public.d.ts`
- `DESCRIPTION`: `"File-backed persistent memory store — CRUD over user memories."`
- `IMPL_PLUGIN`: `llm-memory`
- `CONSUMERS`: enumerate via grep

- [ ] Steps 1-8 standard. Commit:

```bash
git commit -m "refactor: migrate memory:store to llm-contracts"
```

---

### Task 10: Migrate `agents:registry`

**Inputs:**
- `NEW_ID`: `agents:registry`
- `OLD_ID`: `agents:registry`
- `CONTRACT_MODULE`: `agents-registry.ts`
- `TYPE_NAMES`: `AgentsRegistryService`, `AgentManifest`
- `TYPE_SOURCE`: `plugins/llm-agents/public.d.ts`
- `DESCRIPTION`: `"Agent manifest registry — subagent definitions discoverable by drivers."`
- `IMPL_PLUGIN`: `llm-agents`
- `CONSUMERS`: enumerate via grep

- [ ] Steps 1-8 standard. Commit:

```bash
git commit -m "refactor: migrate agents:registry to llm-contracts"
```

---

### Task 11: Migrate `mcp:bridge`

**Inputs:**
- `NEW_ID`: `mcp:bridge`
- `OLD_ID`: `mcp:bridge`
- `CONTRACT_MODULE`: `mcp-bridge.ts`
- `TYPE_NAMES`: `McpBridgeService`, `ServerInfo`, `ServerStatus`
- `TYPE_SOURCE`: `plugins/llm-mcp-bridge/public.d.ts`
- `DESCRIPTION`: `"MCP server bridge — lifecycle for connected MCP servers; surfaces their tools and resources."`
- `IMPL_PLUGIN`: `llm-mcp-bridge`
- `CONSUMERS`: enumerate via grep

Note: `McpBridgeService.reload()` references `ResolvedServerConfig` from `./config.ts`. Decide during this task whether `ResolvedServerConfig` is part of the public contract (move to `llm-contracts`) or an implementation detail (then the contract method takes a generic `unknown`/dropped from public surface). Default: drop `newConfig` param from the contract type if no consumer calls it externally; verify with `grep -rn 'reload(' plugins/ --include='*.ts'`. Adjust during implementation.

- [ ] Steps 1-8 standard. Commit:

```bash
git commit -m "refactor: migrate mcp:bridge to llm-contracts"
```

---

### Task 12: Migrate `dispatch:strategy` (renamed from `tool-dispatch:strategy`)

**Files:**
- Create: `plugins/llm-contracts/contracts/dispatch.ts`
- Modify: `plugins/llm-contracts/index.ts`, `public.d.ts`
- Modify: `plugins/llm-native-dispatch/index.ts`, `public.d.ts`, `package.json`
- Modify: `plugins/llm-driver/index.ts` (consume the renamed ID), `public.d.ts` (no longer owns `ToolDispatchStrategy`)

**Inputs:**
- `NEW_ID`: `dispatch:strategy`
- `OLD_ID`: `tool-dispatch:strategy`
- `CONTRACT_MODULE`: `dispatch.ts`
- `TYPE_NAMES`: `ToolDispatchStrategy`, `ToolDispatchRegistry`
- `TYPE_SOURCE`: `plugins/llm-driver/public.d.ts`
- `DESCRIPTION`: `"Tool dispatch strategy — translates LLM tool calls into registry.invoke() sequences."`
- `IMPL_PLUGIN`: `llm-native-dispatch`
- `CONSUMERS`: `llm-driver` (consumes via safeUse), `llm-codemode` (audit pending — Task 19)

- [ ] **Step 1: Create `plugins/llm-contracts/contracts/dispatch.ts`.** Copy `ToolDispatchStrategy` and `ToolDispatchRegistry` interfaces from `plugins/llm-driver/public.d.ts`. Imports (`ChatMessage`, `LLMResponse`, `ToolSchema`) come from `../public`. Append `CONTRACT_ID = "dispatch:strategy"` and `DESCRIPTION`. Add a comment:

```typescript
// Cardinality-one contract: exactly one provider (llm-native-dispatch OR llm-codemode,
// not both) is loaded per harness. Mutual exclusion enforced by manifest selection.
```

- [ ] **Step 2: Re-export from `llm-contracts/public`.**

- [ ] **Step 3: Register in `llm-contracts/index.ts`.**

- [ ] **Step 4: Update `plugins/llm-native-dispatch/index.ts`.**
- Remove `ctx.defineService("tool-dispatch:strategy", { ... });`.
- Change `ctx.provideService<ToolDispatchStrategy>("tool-dispatch:strategy", makeStrategy())` → `ctx.provideService<ToolDispatchStrategy>("dispatch:strategy", makeStrategy())`.
- Update `services.provides`: `["tool-dispatch:strategy"]` → `["dispatch:strategy"]`.
- Change `import type { ToolDispatchStrategy } from "llm-driver/public"` → `import type { ToolDispatchStrategy } from "llm-contracts/public";`.

- [ ] **Step 5: Update `plugins/llm-native-dispatch/public.d.ts`.**

Replace the re-export `export type { ToolDispatchStrategy } from "llm-driver/public";` with `export type { ToolDispatchStrategy } from "llm-contracts/public";`.

- [ ] **Step 6: Update `plugins/llm-native-dispatch/strategy.ts`.**

Change `import type { ToolDispatchStrategy } from "llm-driver/public";` → `import type { ToolDispatchStrategy } from "llm-contracts/public";`.

- [ ] **Step 7: Update `plugins/llm-driver/public.d.ts`.**

Remove the `ToolDispatchStrategy` and `ToolDispatchRegistry` interface declarations. Add a re-export from `llm-contracts/public`:

```typescript
export type { ToolDispatchStrategy, ToolDispatchRegistry } from "llm-contracts/public";
```

- [ ] **Step 8: Update `plugins/llm-driver/index.ts`.**

- Change `ctx.consumeService("tool-dispatch:strategy")` (if present) → not present today; driver uses optional `safeUse`. Confirm no hard consume edge exists for this contract.
- Change `safeUse<ToolDispatchStrategy>("tool-dispatch:strategy")` → `safeUse<ToolDispatchStrategy>("dispatch:strategy")`.
- Type import already comes from local `public` after Step 7 — verify or update to `llm-contracts/public`.

- [ ] **Step 9: Update `plugins/llm-driver/loop.ts`.**

Change `import { ToolDispatchStrategy } from "..."` source to `llm-contracts/public` if not already.

- [ ] **Step 10: Add `llm-contracts` to package.json for both plugins.**

- [ ] **Step 11: bun install, typecheck, test, deploy, boot, commit.**

```bash
git commit -m "refactor: migrate tool-dispatch:strategy to dispatch:strategy on llm-contracts"
```

---

### Task 13: Migrate `ui:channel` (renamed from `llm-tui:channel`)

**Files:**
- Create: `plugins/llm-contracts/contracts/ui-channel.ts`
- Modify: `plugins/llm-contracts/index.ts`, `public.d.ts`
- Modify: `plugins/llm-tui/index.tsx`, `public.d.ts`, `package.json`
- Modify in consumers: `plugins/llm-driver/index.ts`, anywhere else (grep)

**Inputs:**
- `NEW_ID`: `ui:channel`
- `OLD_ID`: `llm-tui:channel`
- `CONTRACT_MODULE`: `ui-channel.ts`
- `TYPE_NAMES`: `TuiChannelService` (consider renaming to `UiChannelService` for symmetry — see decision note below)
- `TYPE_SOURCE`: `plugins/llm-tui/public.d.ts`
- `DESCRIPTION`: `"Pull-style chat I/O channel between driver and UI."`
- `IMPL_PLUGIN`: `llm-tui`
- `CONSUMERS`: `llm-driver` (and possibly others — grep)

**Type name decision:** The current type is `TuiChannelService`. Since the contract no longer ties to "TUI", consider renaming to `UiChannelService`. **Decision: rename the type.** Update every reference. The plan continues using `UiChannelService` below.

- [ ] **Step 1: Create `plugins/llm-contracts/contracts/ui-channel.ts`.** Copy the `TuiChannelService` interface from `plugins/llm-tui/public.d.ts`. Rename to `UiChannelService`. Append CONTRACT_ID/DESCRIPTION.

- [ ] **Step 2: Re-export from `llm-contracts/public`** with the new name.

- [ ] **Step 3: Register in `llm-contracts/index.ts`.**

- [ ] **Step 4: Update `plugins/llm-tui/index.tsx`.**
- Remove `ctx.defineService("llm-tui:channel", { ... });`.
- Change both `ctx.provideService<TuiChannelService>("llm-tui:channel", channel)` calls to `ctx.provideService<UiChannelService>("ui:channel", channel)`.
- Update `services.provides`: `"llm-tui:channel"` → `"ui:channel"`.
- Change type import: `TuiChannelService` (local) → `UiChannelService` from `llm-contracts/public`.

- [ ] **Step 5: Update `plugins/llm-tui/public.d.ts`.**

Remove the local `TuiChannelService` interface declaration. Add:

```typescript
export type { UiChannelService } from "llm-contracts/public";
```

- [ ] **Step 6: Update `plugins/llm-driver/index.ts`.**
- Change `ctx.consumeService("llm-tui:channel")` → `ctx.consumeService("ui:channel")`.
- Change `ctx.useService<UiChannel>("llm-tui:channel")` (both occurrences) → `ctx.useService<UiChannelService>("ui:channel")`.
- Update `services.consumes`: `"llm-tui:channel"` → `"ui:channel"`.
- Change the import of `UiChannel` (current local type alias) to `import type { UiChannelService } from "llm-contracts/public";`. Update every reference in the file.

- [ ] **Step 7: Add `llm-contracts` to package.json for both plugins.**

- [ ] **Step 8: bun install, typecheck, test, deploy, boot, commit.**

```bash
git commit -m "refactor: migrate llm-tui:channel to ui:channel on llm-contracts"
```

---

### Task 14: Migrate `ui:theme` (renamed from `llm-tui:theme`)

**Inputs:**
- `NEW_ID`: `ui:theme`
- `OLD_ID`: `llm-tui:theme`
- `CONTRACT_MODULE`: `ui-theme.ts`
- `TYPE_NAMES`: `TuiThemeService` (rename to `UiThemeService`), `TuiTheme` (rename to `UiTheme`)
- `TYPE_SOURCE`: `plugins/llm-tui/public.d.ts` (re-exported from `plugins/llm-tui/theme/loader.ts`)
- `DESCRIPTION`: `"Read-only UI theme tokens."`
- `IMPL_PLUGIN`: `llm-tui`
- `CONSUMERS`: enumerate via grep

The `TuiTheme` type definition lives in `plugins/llm-tui/theme/loader.ts`. Move the interface (not the loader code) to `plugins/llm-contracts/contracts/ui-theme.ts`. The loader stays in `llm-tui` and produces a value matching the moved type.

- [ ] Steps 1-8 standard. Rename types in lockstep. Commit:

```bash
git commit -m "refactor: migrate llm-tui:theme to ui:theme on llm-contracts"
```

---

### Task 15: Migrate `ui:status` (renamed from `llm-tui:status`)

**Inputs:**
- `NEW_ID`: `ui:status`
- `OLD_ID`: `llm-tui:status`
- `CONTRACT_MODULE`: `ui-status.ts`
- `TYPE_NAMES`: `TuiStatusService` (rename to `UiStatusService`)
- `TYPE_SOURCE`: `plugins/llm-tui/public.d.ts`
- `DESCRIPTION`: `"Marker service — signals that a status renderer is present in the harness."`
- `IMPL_PLUGIN`: `llm-tui`
- `CONSUMERS`: enumerate via grep (likely none — marker only)

The interface is empty. Migration is mechanical.

- [ ] Steps 1-8 standard. Commit:

```bash
git commit -m "refactor: migrate llm-tui:status to ui:status on llm-contracts"
```

---

### Task 16: Migrate `ui:completion-source` (renamed from `llm-tui:completion`)

**Inputs:**
- `NEW_ID`: `ui:completion-source`
- `OLD_ID`: `llm-tui:completion`
- `CONTRACT_MODULE`: `ui-completion.ts`
- `TYPE_NAMES`: `TuiCompletionService` (rename to `UiCompletionService`), `CompletionItem`, `CompletionSource`
- `TYPE_SOURCE`: `plugins/llm-tui/public.d.ts`
- `DESCRIPTION`: `"Registry of completion sources for input popups."`
- `IMPL_PLUGIN`: `llm-tui`
- `CONSUMERS`: `llm-slash-commands` (optional consumer — see Section 4.3 in spec)

- [ ] Steps 1-8 standard. The `llm-slash-commands` consumer uses optional `useService` in a try/catch; preserve that pattern after the rename. Commit:

```bash
git commit -m "refactor: migrate llm-tui:completion to ui:completion-source on llm-contracts"
```

---

### Task 17: Migrate `ui:tool-renderer` (renamed from `llm-tui:tool-renderer`)

**Inputs:**
- `NEW_ID`: `ui:tool-renderer`
- `OLD_ID`: `llm-tui:tool-renderer`
- `CONTRACT_MODULE`: `ui-tool-renderer.ts`
- `TYPE_NAMES`: `TuiToolRendererService` (rename to `UiToolRendererService`), `TuiToolRenderer` (rename to `UiToolRenderer`), `ToolCallStatus`
- `TYPE_SOURCE`: `plugins/llm-tui/public.d.ts` (re-exports from `plugins/llm-tui/tool-renderers/registry.ts` and `plugins/llm-tui/state/store.ts`)
- `DESCRIPTION`: `"Per-tool UI rendering registry — pluggable presentation of tool calls in the chat surface."`
- `IMPL_PLUGIN`: `llm-tui`
- `CONSUMERS`: `llm-codemode` (optional consumer via `useService?.`)

- [ ] Steps 1-8 standard. The `ToolCallStatus` type currently lives in `plugins/llm-tui/state/store.ts` — move only the public type to `llm-contracts/contracts/ui-tool-renderer.ts`, leave any state-machine implementation in place. Commit:

```bash
git commit -m "refactor: migrate llm-tui:tool-renderer to ui:tool-renderer on llm-contracts"
```

---

### Task 18: Migrate `driver:run-conversation`

**Files:**
- Create: `plugins/llm-contracts/contracts/driver.ts`
- Modify: `plugins/llm-contracts/index.ts`, `public.d.ts`
- Modify: `plugins/llm-driver/index.ts`, `public.d.ts`, `package.json`
- Modify in consumers: `plugins/llm-agents/index.ts`, `plugins/llm-slash-commands/index.ts`, `plugins/llm-memory/index.ts`

**Inputs:**
- `NEW_ID`: `driver:run-conversation`
- `OLD_ID`: `driver:run-conversation`
- `CONTRACT_MODULE`: `driver.ts`
- `TYPE_NAMES`: `DriverService`, `RunConversationInput`, `RunConversationOutput`
- `TYPE_SOURCE`: `plugins/llm-driver/public.d.ts`
- `DESCRIPTION`: `"Conversation driver — runs one LLM-mediated turn including tool dispatch and session handoff."`
- `IMPL_PLUGIN`: `llm-driver`
- `CONSUMERS`: `llm-agents`, `llm-slash-commands`, `llm-memory` (and any others — grep)

- [ ] **Step 1: Create `plugins/llm-contracts/contracts/driver.ts`.** Copy `DriverService`, `RunConversationInput`, `RunConversationOutput` from `plugins/llm-driver/public.d.ts`. The complex `RunConversationInput` type imports `ChatMessage`, `LLMResponse`, `ToolSchema`, `TurnHandle` — adjust those imports to `../public`. Append `CONTRACT_ID = "driver:run-conversation"` and `DESCRIPTION`.

- [ ] **Step 2: Re-export from `llm-contracts/public`.**

- [ ] **Step 3: Register in `llm-contracts/index.ts`.**

- [ ] **Step 4: Update `plugins/llm-driver/index.ts`.**
- Remove `ctx.defineService("driver:run-conversation", { ... });`.
- Keep `ctx.provideService<DriverService>("driver:run-conversation", driverService);`.
- Change `import type { DriverService, RunConversationInput, RunConversationOutput, ToolDispatchStrategy }` to import contract types from `llm-contracts/public`.

- [ ] **Step 5: Update `plugins/llm-driver/public.d.ts`.**

After Tasks 3 and 12 the file already re-exports several types from `llm-contracts/public`. Now also re-export the driver contract types:

```typescript
export type {
  ChatMessage, ToolCall, ToolSchema, LLMRequest, LLMResponse, LLMStreamEvent, LLMCompleteService,
  ToolDispatchStrategy, ToolDispatchRegistry,
  DriverService, RunConversationInput, RunConversationOutput,
  TurnHandle,
} from "llm-contracts/public";
```

Remove the local declarations of `DriverService`, `RunConversationInput`, `RunConversationOutput`.

- [ ] **Step 6: Update `plugins/llm-driver/loop.ts` and internal modules.** Change any `import { ... } from "./public"` that pulls a contract type to import from `llm-contracts/public` directly. (Going through `./public` re-exports also works but adds an indirection.)

- [ ] **Step 7: Update consumers.** Each of `llm-agents`, `llm-slash-commands`, `llm-memory` uses `useService<DriverService>("driver:run-conversation")` — keep the string. Change the type import to `llm-contracts/public`. Add `llm-contracts` to package.json.

- [ ] **Step 8: bun install, typecheck, test, deploy, boot, commit.**

```bash
git commit -m "refactor: migrate driver:run-conversation to llm-contracts"
```

---

## Phase 3 — Audits and cleanup

### Task 19: Audit `llm-codemode`'s role re `dispatch:strategy`

**Files:**
- Modify (possibly): `plugins/llm-codemode/index.ts`
- Modify: `plugins/llm-codemode/README.md`
- Modify (if needed): `harnesses/openai-compatible.json`

- [ ] **Step 1: Read `plugins/llm-codemode/index.ts` and any related modules** to determine whether codemode:
  - (a) Is an alternative `dispatch:strategy` provider that is currently missing the `provideService` wiring, OR
  - (b) Registers an `execute_javascript` (or similar) sandbox tool into `tools:registry` and is consumed alongside whichever `dispatch:strategy` is loaded.

  Read `plugins/llm-codemode/CLAUDE.md` first for context.

- [ ] **Step 2: Decision tree.**

  - **If (a):** Add `ctx.provideService<ToolDispatchStrategy>("dispatch:strategy", makeCodemodeStrategy())` in setup. Update `services.provides: ["dispatch:strategy"]`. Update `harnesses/openai-compatible.json` to remove `llm-native-dispatch` OR `llm-codemode` (cardinality-one — they cannot both load). Document the mutual exclusion in both plugins' READMEs.
  - **If (b):** Document the role in `plugins/llm-codemode/README.md` as "tool-registration plugin, not a dispatch strategy. Loads alongside any `dispatch:strategy` provider."

- [ ] **Step 3: If (a), run end-to-end smoke** by switching the manifest to codemode-only and confirming a conversation that uses tools still completes.

- [ ] **Step 4: Commit.**

```bash
git add -A
git commit -m "audit: clarify llm-codemode's role re dispatch:strategy"
```

---

### Task 20: Hard-vs-optional consumption audit

**Files:**
- Modify: `plugins/<each>/index.ts` where consumption category changes
- Modify: `docs/superpowers/specs/2026-05-13-llm-contracts-foundation-refactor-design.md` (append the table)

- [ ] **Step 1: Enumerate every consume edge.**

```bash
grep -rn -E 'consumeService\(|useService[^a-z]' plugins/ --include='*.ts' --include='*.tsx' | grep -v node_modules | grep -v dist | grep -v '.test.'
```

Produce a table: `{plugin}, {contract-id}, {call-site}, {current-category}, {target-category}`.

- [ ] **Step 2: Categorize each edge.**

For each call site, decide hard or optional per AGENTS.md:

- **Hard** (`consumeService` + `services.consumes` array entry): plugin cannot meaningfully run without the contract. The harness should fail to boot if absent.
- **Optional** (guarded `useService` lookup, returns `undefined` if absent; no `consumeService`/`services.consumes` entry): plugin degrades gracefully.

Document the decision and the reasoning in the spec table.

- [ ] **Step 3: Apply changes.**

For each edge where the current and target categories differ:

- If promoting optional→hard: add `ctx.consumeService(id)` near the top of `setup()` and add to `services.consumes`. Replace guarded `useService` with `useService<T>(id)!` (or `consumeService` semantics if the harness pre-resolves).
- If demoting hard→optional: remove `ctx.consumeService(id)` and the `services.consumes` entry. Wrap the `useService` call in a guard (check `undefined` and skip the feature).

- [ ] **Step 4: Commit the spec update and the code changes together.**

```bash
git add -A
git commit -m "audit: align consume categories with AGENTS.md (hard vs optional)"
```

---

### Task 21: Documentation sweep

**Files:**
- Modify: `plugins/<each>/README.md` — every plugin whose contract IDs changed
- Modify: `plugins/<each>/CLAUDE.md` — every plugin whose contract IDs changed
- Modify: `plugins/llm-contracts/README.md` — add the full pattern guide (this may already be in Task 1 — review and expand)
- Modify: `plugins/llm-contracts/CLAUDE.md` — same

- [ ] **Step 1: Enumerate documents that reference old contract IDs.**

```bash
grep -rn -E 'llm-events:vocabulary|llm-tui:|prompt:system|tool-dispatch:strategy' plugins/ --include='*.md' --include='*.MD'
```

- [ ] **Step 2: Replace old IDs with new IDs across every README.md and CLAUDE.md.**

- [ ] **Step 3: Update `plugins/llm-contracts/README.md`** to include the full pattern guide: when to add a new contract, how to migrate a contract, the substitutability test, the naming convention.

- [ ] **Step 4: Update each implementation plugin's CLAUDE.md `Module map`** section to reflect that contract types now come from `llm-contracts/public` rather than the plugin's own `public.d.ts`.

- [ ] **Step 5: Commit.**

```bash
git add -A
git commit -m "docs: update plugin READMEs and CLAUDE.md files for llm-contracts refactor"
```

---

## Phase 4 — End-to-end verification

### Task 22: Full-harness substitutability acid test

**Goal:** Prove that every implementation plugin in the harness is substitutable by a stub that imports from `llm-contracts/public` and provides the same contract IDs.

**Files:**
- Create (temporarily): `plugins/_acidtest/stub-<plugin>/` for each implementation plugin under test
- No permanent file changes — this task ends with the directory tree deleted

- [ ] **Step 1: Enumerate implementation plugins.**

```
llm-events, openai-llm, llm-session-manager, llm-tools-registry, llm-system-prompt,
llm-slash-commands, llm-skills, llm-memory, llm-agents, llm-mcp-bridge,
llm-native-dispatch, llm-driver, llm-tui
```

`llm-codemode` is included only if Task 19 concluded it provides `dispatch:strategy`.

- [ ] **Step 2: For each plugin, build a minimal stub** in `plugins/_acidtest/stub-<plugin>/`. The stub:
  - Has `package.json` (`name: "stub-<plugin>"`, depends on `llm-contracts`).
  - Has an `index.ts` that exports a `KaizenPlugin` with the same `services.provides` array as the real plugin, and `setup(ctx)` that calls `ctx.provideService(<id>, <minimal-stub-implementation>)` for each.
  - Minimal stub implementation = no-op functions returning sensible default values (empty arrays, resolved promises, undefined where allowed by the type).

  Example for `llm-skills` stub:

  ```typescript
  import type { KaizenPlugin } from "kaizen/types";
  import type { SkillsRegistryService } from "llm-contracts/public";

  const stub: SkillsRegistryService = {
    list: () => [],
    load: async () => "",
    register: () => () => {},
    rescan: async () => ({ changed: false, count: 0 }),
  };

  const plugin: KaizenPlugin = {
    name: "stub-llm-skills",
    apiVersion: "3.0.0",
    permissions: { tier: "unscoped" },
    services: { provides: ["skills:registry"], consumes: [] },
    async setup(ctx) {
      ctx.provideService<SkillsRegistryService>("skills:registry", stub);
    },
  };

  export default plugin;
  ```

- [ ] **Step 3: For each stub, run a one-plugin-swap boot.**
  - Temporarily edit `harnesses/openai-compatible.json` to replace `official/<plugin>@x.y.z` with `local/_acidtest-stub-<plugin>@0.1.0` (or whatever local-marketplace entry the harness will pick up — confirm the path convention in Task 1's local deploy step).
  - Local-deploy the stub: `cp -R plugins/_acidtest/stub-<plugin> ~/.kaizen/marketplaces/...`.
  - Boot the harness. Confirm no boot errors. Affected feature is expected non-functional; that is acceptable for this test.
  - Restore the manifest entry.

- [ ] **Step 4: Tear down.**

```bash
rm -rf plugins/_acidtest
```

Restore `harnesses/openai-compatible.json` to its committed state via `git checkout`.

- [ ] **Step 5: Document the result.**

Append a "Verification" section to `docs/superpowers/specs/2026-05-13-llm-contracts-foundation-refactor-design.md` listing every implementation plugin and `PASS`/`FAIL` for its substitutability check. If any fails, file a follow-up task (the design is incomplete for that plugin) and do not declare the refactor done.

- [ ] **Step 6: Commit.**

```bash
git add docs/superpowers/specs/2026-05-13-llm-contracts-foundation-refactor-design.md
git commit -m "verify: full-harness substitutability acid test results"
```

---

## Self-review notes

After completing all 22 tasks, scan the codebase for stragglers:

```bash
# Any remaining defineService calls outside llm-contracts?
grep -rn 'defineService' plugins/ --include='*.ts' --include='*.tsx' | grep -v node_modules | grep -v llm-contracts | grep -v '.test.'

# Any remaining references to renamed old IDs?
grep -rn -E 'llm-events:vocabulary|llm-tui:|prompt:system|tool-dispatch:strategy' plugins/ harnesses/ --include='*.ts' --include='*.tsx' --include='*.json' --include='*.md' | grep -v node_modules | grep -v dist

# Any remaining contract type imports from implementation plugins?
grep -rn -E 'from "llm-(driver|tui|skills|memory|agents|mcp-bridge|session-manager|system-prompt|slash-commands|tools-registry|native-dispatch|events)/public"' plugins/ --include='*.ts' --include='*.tsx' | grep -v node_modules | grep -v dist
```

Each result should either be empty (target state) or a legitimate exception explicitly justified in code comments (e.g. a plugin importing an *implementation-internal* type from its own `public.d.ts`).
