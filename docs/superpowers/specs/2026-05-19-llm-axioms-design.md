# Design: `llm-axioms` — Session-scoped Aristotelean axiom workspace

**Status:** Draft for review
**Date:** 2026-05-19
**Source TODO:** `docs/TODO.md` — "Build a plugin to record aristotelean first principles reasoning into an axiom registry. These axioms should be referenced while LLM thinks about how to solve the problem. I want this plugin to append to system prompt instructions on when to derive first principles."

## Summary

A new plugin `llm-axioms` in the openai-compatible harness. Provides a **session-scoped** workspace where the model records first-principles axioms it derives while working on the current problem, plus a **static methodology section** in the system prompt that teaches *when* to derive axioms and how to structure them.

Axioms are **distinct from memories**: they are session-bound (ride along with `llm-session-manager` persisted sessions, do not span sessions or projects), structured (premised, scoped, with explicit reasoning), and ephemeral relative to the user's broader durable context. If a derived axiom proves durable across problems, the user lifts it into `llm-memory` by hand.

## Motivation and scope

The TODO calls for axioms to be "referenced while LLM thinks about how to solve the problem." The brainstorming surfaced that:

- **Ephemeral was right, but session-scoped (not turn-scoped).** A request like "build a world-class calendar website" generates axioms about what "world-class" means; those axioms should frame the entire session, not be re-derived each turn (drift risk, token waste).
- **Axioms are not memories.** Memories are durable facts about user/project. Axioms are reasoning artifacts with premises, reasoning, scope of applicability — a different data shape and a different lifetime.
- **Two prompt sections, not one.** The "when to derive" methodology is static; the workspace render is dynamic. Splitting them lets users disable either via config and keeps generation-bumping confined to the dynamic side.

In scope (v1):
- Service contract `axioms:registry` defined in `llm-contracts`.
- Three model-facing tools: `axiom_record`, `axiom_amend`, `axiom_drop`.
- Three user slash commands (all read-only or destructive-reset): `axioms:list`, `axioms:show`, `axioms:clear`.
- Per-session JSON persistence under `~/.kaizen/plugins/llm-axioms/sessions/<id>.json`.
- Two `prompt:registry` sections (`llm-axioms:methodology`, `llm-axioms:workspace`).

Out of scope (deliberate, v1):
- User-editable axioms (no `axioms:add`, `axioms:edit`, `axioms:drop` slash commands). The model writes; the user observes.
- Cross-session axiom catalog or sharing. If a user wants durable cross-session axioms, they lift them into `llm-memory` themselves.
- Auto-extraction heuristics (no `turn:end` listener that drafts axioms via side-call). Methodology section teaches the model to derive explicitly.

## Architecture

### Contract (added to `llm-contracts`)

```typescript
// plugins/llm-contracts/contracts/axioms-registry.ts
export const CONTRACT_ID = "axioms:registry" as const;
export const DESCRIPTION = "Session-scoped Aristotelean axiom workspace.";

export interface AxiomEntry {
  id: string;             // [a-z0-9_-]{1,64}, model-chosen, stable across amend/drop
  statement: string;      // one sentence, declarative, falsifiable
  premises: string[];     // supporting truths; may reference other axioms via [[id]]
  reasoning: string;      // why premises ⇒ statement
  scope: string;          // applicability within the session
  derivedAt: number;      // ms epoch, auto-set on record
  amendedAt?: number;     // ms epoch, auto-set on amend
}

export interface AxiomsRegistryService {
  list(): readonly AxiomEntry[];
  get(id: string): AxiomEntry | null;
  record(entry: Omit<AxiomEntry, "derivedAt" | "amendedAt">): Promise<AxiomEntry>;
  amend(id: string, patch: Partial<Omit<AxiomEntry, "id" | "derivedAt">>): Promise<AxiomEntry>;
  drop(id: string, reason: string): Promise<boolean>;
  clear(): Promise<void>;
  onChange(cb: () => void): () => void;
}
```

Contract ID `axioms:registry` follows the `<domain>:<role>` convention with no plugin-name prefix.

##### Cardinality

**Cardinality-one.** One workspace per harness session is the right model — multiple simultaneous axiom workspaces in a single session would defeat the purpose (the model has no way to address them, and the rendered prompt section would have to interleave or duplicate content). If a future use case wants multiple axiom *scopes* with structural isolation (e.g. one per agent in a multi-agent harness), the right answer is an `axioms:registry-registry` selector contract, not a cardinality-N change to `axioms:registry`. Not in scope for v1.

##### Acid test

Remove `llm-axioms` from the harness manifest. Replace it with a stub plugin whose entire body is:

```typescript
import type { AxiomsRegistryService } from "llm-contracts/public";
// minimal in-memory impl that satisfies the contract
const stub: AxiomsRegistryService = { /* ... */ };
ctx.provideService<AxiomsRegistryService>("axioms:registry", stub);
```

The harness boots. The `llm-axioms:methodology` and `llm-axioms:workspace` sections are not registered (the stub doesn't ship them), but every other plugin in the harness continues to function. No other plugin's code changed. This is the contract working as designed: provider swap requires zero consumer edits.

The two sections + tools + slash commands are *part of the `llm-axioms` plugin's value*, not part of the contract. A replacement provider is free to ship its own sections under a different id (or none at all).

##### Contract registration in `llm-contracts`

Per `plugins/llm-contracts/CLAUDE.md`, adding `axioms:registry` to the contracts plugin is a four-step change:

1. Create `plugins/llm-contracts/contracts/axioms-registry.ts` with the `CONTRACT_ID`, `DESCRIPTION`, and interface declarations from the block above.
2. Re-export `AxiomEntry` and `AxiomsRegistryService` (types) from `plugins/llm-contracts/public.ts`.
3. In `plugins/llm-contracts/index.ts`, import the new module and add:
   ```typescript
   ctx.defineService(axiomsRegistry.CONTRACT_ID, { description: axiomsRegistry.DESCRIPTION });
   ```
4. Add a test case in `plugins/llm-contracts/test/index.test.ts` asserting that `defineService` was called with `"axioms:registry"`.

`llm-contracts` ships zero runtime behavior. It must redeploy (and its version bump) before `llm-axioms`. The harness manifest already lists `llm-contracts` first.

### Module map

```
plugins/llm-axioms/
├── index.ts          Plugin lifecycle. Subscribes to session:active-changed.
│                     Registers service, two prompt sections, three tools, slash group.
│                     The only file that touches ctx.
├── config.ts         loadConfig({ home, readFile, configStore }) → AxiomsConfig.
│                     Reads via config:store; DEFAULT_CONFIG frozen. Validates byte caps.
├── paths.ts          resolveDirs (config → { axiomsDir }), ensureDir,
│                     sessionFilePath(sessionId), sweepStaleTempFiles.
│                     Pure FS helpers.
├── schema.ts         validateAxiomId, validateAxiomEntry. Pure validators.
│                     Owns the [a-z0-9_-]{1,64} regex and length caps.
├── store.ts          makeStore({ paths, log, now? }) → AxiomsRegistryService.
│                     In-memory Map<id, AxiomEntry> mirrored to disk.
│                     swapSession(newId) loads new file from disk + fires onChange.
│                     All disk I/O atomic (tmp + rename).
├── injection.ts      buildWorkspaceBlock(entries, byteCap) → string | null.
│                     Groups by scope; truncates oldest-first when over cap.
│                     Returns null when entries empty.
├── methodology.ts    METHODOLOGY_SECTION constant + render().
│                     Static prose content.
├── tools.ts          registerTools(reg, store, { log }) → unregister fn.
│                     Three tools: axiom_record, axiom_amend, axiom_drop.
├── slash.ts          makeSlashHandlers({ store, channel }) → handlers.
│                     Three slash commands: axioms:list, axioms:show, axioms:clear.
├── public.d.ts       Re-exports AxiomEntry, AxiomsRegistryService from
│                     llm-contracts/public. Plugin-internal types
│                     (AxiomsConfig shape, AxiomValidationError class) live
│                     here — see "Non-contract public surface" below.
├── package.json
├── tsconfig.json
├── README.md
├── CLAUDE.md
└── test/             Bun tests, alongside each module.
```

Boundary rules (mirror `llm-memory`):
- `store.ts` is the only module that touches disk.
- Only `index.ts` imports `kaizen/types` or touches `ctx`.
- `methodology.ts`, `injection.ts`, `schema.ts` are pure.
- Tests for each module live in `test/` and run independently.

### Storage layout

```
~/.kaizen/plugins/llm-axioms/
├── config.json                          # via config:store
└── sessions/
    ├── <session-id-1>.json
    ├── <session-id-2>.json
    └── ...
```

Each session file:

```json
{
  "version": 1,
  "sessionId": "abc123def",
  "axioms": [
    {
      "id": "world-class-means-offline-capable",
      "statement": "A world-class calendar must function fully offline.",
      "premises": [
        "Calendars are accessed during travel, on flights, in basements.",
        "Users expect zero loss of access during network outages."
      ],
      "reasoning": "If 'world-class' tolerates network-dependent failure modes for a primary calendar feature, the qualifier loses meaning in any context where users routinely encounter network gaps.",
      "scope": "UX baseline for the calendar website",
      "derivedAt": 1747700000000
    }
  ]
}
```

Atomic writes: every mutation writes `<id>.json.tmp.<pid>.<rand>` then `rename()`. A startup sweep removes orphaned `.tmp.*` files older than `staleTempMs` (default `60000`). Same pattern as `llm-memory`.

No project layer, no global layer. Sessions only.

### Prompt sections

Two sections registered with `prompt:registry`:

**`llm-axioms:methodology`** — priority `50`, static.
- Always on unless `methodologyEnabled: false`.
- Content (subject to copy editing during implementation):

  > # First-principles reasoning
  >
  > When a request contains vague qualifiers ("world-class", "robust", "production-grade"), conflicting constraints, novel problems, or appeals to precedent ("we've always done it this way"), pause and derive axioms before producing a solution.
  >
  > An axiom in this workspace is a *premised, scoped* truth — not an opinion or a preference. It has:
  > - a one-sentence **statement** (declarative, falsifiable),
  > - one or more **premises** it rests on (cite other axioms with `[[id]]`),
  > - **reasoning** for why premises imply the statement,
  > - a **scope** of applicability (which part of this session's problem it constrains).
  >
  > Use `axiom_record` before applying an axiom in your reasoning. Use `axiom_amend` when a later observation refines it. Use `axiom_drop` (with a reason) when you discover an axiom is wrong or has been superseded.
  >
  > Cite axioms by id (`[[id]]`) when applying them, so reasoning chains stay legible.

- `bumpGeneration` only on identity-style reloads (not on store mutations) since the body is static.

**`llm-axioms:workspace`** — priority `180`, dynamic.
- Priority `180` places it above `llm-memory:auto` (170): axioms frame the current problem and should anchor reasoning before background memories are consulted.
- Active only when `workspaceEnabled: true` (default).
- `render()` reads `store.list()`, groups by `scope`, and renders inside a `<system-reminder>` wrapper.
- Returns `""` when the store is empty → `prompt:registry` drops the section.
- Bound to `store.onChange` → `handle.bumpGeneration()` so re-render happens on the next assembly after every record/amend/drop/clear/swapSession.
- Truncation: when the rendered block exceeds `injectionByteCap`, drop oldest axioms (by `derivedAt`) first and append `... [truncated]` until under cap.

### Tools

All three registered into `tools:registry`, tagged `["axioms", "write"]`. Tool input schemas validated; failures return structured `{ ok: false, error }` rather than throwing, so the model gets actionable feedback. Tool results flow through `tool:before-execute` / `tool:result` events so the TUI shows axiom changes inline.

| Tool | Input schema | Behavior |
|---|---|---|
| `axiom_record` | `{ id: string, statement: string, premises: string[], reasoning: string, scope: string }` | Validates id (`[a-z0-9_-]{1,64}`), statement (max 280 chars, non-empty), premises (1..10 items, each ≤ 500 chars), reasoning (≤ 2000 chars), scope (≤ 200 chars). Refuses if `id` already exists in the current session — returns `{ ok: false, error: "axiom_exists", hint: "use axiom_amend or choose a new id" }`. On success returns `{ ok: true, axiom }`. |
| `axiom_amend` | `{ id: string, statement?: string, premises?: string[], reasoning?: string, scope?: string }` | Refuses if `id` absent → `{ ok: false, error: "axiom_not_found" }`. At least one patch field required (else `{ ok: false, error: "no_patch_fields" }`). Patches only provided fields; `amendedAt` auto-set. Re-validates the merged entry. On success returns `{ ok: true, axiom }`. |
| `axiom_drop` | `{ id: string, reason: string }` | Refuses if `id` absent → `{ ok: false, error: "axiom_not_found" }`. `reason` required (non-empty, ≤ 500 chars); included in `tool:result` payload for audit. On success returns `{ ok: true, droppedId: id }`. |

No batch operations. The model writes one axiom at a time so each derivation is independently visible in the event stream.

### Slash commands

Registered into `slash:registry` using the `domain:command` convention (matches `session:new`, `config:get`).

| Command | Args | Output |
|---|---|---|
| `/axioms:list` | none | Markdown list of `<id> — <statement>` for the current session, grouped by `scope`. Empty state: "No axioms in this session." |
| `/axioms:show` | `<id>` | Full render: statement, premises (numbered), reasoning, scope, `derivedAt` (formatted), `amendedAt` if set. Unknown id: error notice. |
| `/axioms:clear` | none | Drops all axioms for the current session. Two-step confirmation via channel (prints count, asks "Type 'yes' to confirm" — uses whatever confirmation pattern existing slash commands use; verified during implementation against `llm-session-manager`'s `session:delete`). |

`/axioms:clear` is the only mutation a user can perform. It is included in v1 because resetting the frame mid-session is genuinely useful (e.g., user realises the model's axioms have led the session astray and wants to restart the reasoning); it is *not* per-axiom editing.

### Lifecycle (`index.ts`)

`setup(ctx)`:
1. Load config via `config:store` (topo-hint optional). If `config:store` absent, use `DEFAULT_CONFIG` and log a notice.
2. Resolve `axiomsDir`; ensure directory exists; sweep stale temp files.
3. Construct `store` with an *unset* session (in-memory empty Map; no disk file backing).
4. Subscribe to `session:active-changed`:
   ```typescript
   ctx.on(VOCAB.SESSION_ACTIVE_CHANGED, async ({ sessionId }) => {
     await store.swapSession(sessionId);
   });
   ```
   `swapSession` reads `<axiomsDir>/<sessionId>.json` if present (else starts empty), updates in-memory map, fires `onChange`.
5. `ctx.provideService("axioms:registry", store)`.
6. If `prompt:registry` available and `methodologyEnabled`, register `llm-axioms:methodology` (priority 50). Capture section handle for `stop()`.
7. If `prompt:registry` available and `workspaceEnabled`, register `llm-axioms:workspace` (priority 180). Bind `store.onChange(() => handle.bumpGeneration())`. Capture handle.
8. If `tools:registry` available, register the three tools. Capture unregister fn.
9. If `slash:registry` available, register the three slash commands. Capture unregister fns.

`stop(ctx)`: idempotent.
- Unsubscribe `session:active-changed` listener.
- Call captured unregister fns / section handles. Each guarded so a second call is a no-op.
- Flush any in-flight writes (await an internal write queue if one exists; in the simple design, writes are awaited inline before tool return, so this is a no-op).

#### Declared dependencies

Per `docs/PLUGIN_ARCHITECTURE.md` and `llm-memory`'s implementation, every service looked up in `setup()` must be declared in `services.consumes` for topo-hint ordering — otherwise `ctx.useService` throws when the provider hasn't run yet, even if it's present in the harness manifest. `events:vocabulary` is the only **hard** dep (also `consumeService` called); the rest are **topo-hint optional** (declared in `services.consumes`, no `consumeService`, conditional registration in `setup()`).

```jsonc
// in plugin manifest
{
  "services": {
    "provides": ["axioms:registry"],
    "consumes": [
      "events:vocabulary",     // hard
      "config:store",          // topo-hint optional
      "prompt:registry",       // topo-hint optional
      "tools:registry",        // topo-hint optional
      "slash:registry"         // topo-hint optional
    ]
  }
}
```

| Dependency | Mode | `consumeService` call | Behavior when absent |
|---|---|---|---|
| `events:vocabulary` | **hard** | yes | Harness refuses to boot the plugin. |
| `config:store` | **topo-hint optional** | no | Falls back to `DEFAULT_CONFIG`; logs a notice. |
| `prompt:registry` | **topo-hint optional** | no | The two sections are not registered. Service + tools + slash still work. |
| `tools:registry` | **topo-hint optional** | no | The three tools are not registered. Service + slash + sections still work. |
| `slash:registry` | **topo-hint optional** | no | The three slash commands are not registered. Everything else still works. |
| `session:active-changed` event | subscription via `ctx.on` | n/a | If the event is never emitted (no session manager loaded), the store has no active session and tools return `{ ok: false, error: "no_active_session" }`. |

`session-manager` provides the `session:active-changed` event but not via a service this plugin consumes synchronously — the dependency is event-shaped, so it does not appear in `services.consumes`.

If both `prompt:registry` and `tools:registry` are absent at runtime, the plugin still boots and serves `axioms:registry` to any direct consumer, but the model has no way to write and no in-prompt visibility — effectively dead. Log a notice in that case but do not throw.

### Configuration (`config:store`)

Plugin section key: `llm-axioms`. Default file location resolved by `config:store` itself.

| Key | Default | Notes |
|---|---|---|
| `axiomsDir` | `~/.kaizen/plugins/llm-axioms/sessions` | `~/` expanded. Per-session JSON files written here. |
| `injectionByteCap` | `4096` | Workspace section byte cap. Oldest-first truncation when over cap. |
| `methodologyEnabled` | `true` | Kill switch for the static methodology section. |
| `workspaceEnabled` | `true` | Kill switch for the dynamic workspace section. |
| `staleTempMs` | `60000` | Startup temp-file sweep threshold. |

Config validation: `axiomsDir` must be a non-empty string; numeric caps must be positive integers; booleans must be booleans. Malformed values fall back to defaults with a logged warning (do not throw at setup).

### Permissions

`tier: unscoped` — reads/writes under `~/.kaizen/plugins/llm-axioms/`. No network, no process spawn.

### Non-contract public surface

Per `docs/PLUGIN_ARCHITECTURE.md` § "Non-Contract Public Surface": a type belongs in `llm-contracts/public` if and only if it appears in a contract method's signature. Implementation-internal types stay in the plugin's own `public.d.ts`.

| Type / value | Lives in | Rationale |
|---|---|---|
| `AxiomEntry` | `llm-contracts/public` | Appears in `AxiomsRegistryService.list()`, `.get()`, `.record()`, `.amend()` signatures. Cross-plugin contract surface. |
| `AxiomsRegistryService` | `llm-contracts/public` | The contract itself. |
| `AxiomsConfig` | `plugins/llm-axioms/public.d.ts` | Plugin-internal config shape. Only consumed by `config:store.register({ defaults, schema })`; never crosses plugin boundaries as a typed value. |
| `AxiomValidationError` (if defined) | `plugins/llm-axioms/public.d.ts` | Concrete runtime class thrown by `store.record`/`.amend` on synchronous validation failure. Consumers that `catch` it depend on the implementation, not the contract. Pattern mirrors `BareNamePluginError` in `llm-slash-commands`. |
| `METHODOLOGY_SECTION` constant text | `plugins/llm-axioms/methodology.ts` (not exported) | Implementation detail of the static section; no other plugin consumes it. |

If a future consumer plugin needs to introspect axioms directly (e.g. a TUI panel that renders the workspace), it imports `AxiomEntry` and `AxiomsRegistryService` from `llm-contracts/public` and calls `ctx.useService<AxiomsRegistryService>("axioms:registry")`. It never imports from `llm-axioms` directly.

## Behavior contracts and invariants

These are the testable invariants. They map directly to test files.

1. **Session swap is atomic from the consumer's view.** `swapSession(newId)` first loads the new session's file into a *new* in-memory map, then atomically swaps it in and fires `onChange`. A reader observing `store.list()` either sees the old set or the new set, never a mix. If the on-disk load throws (malformed JSON), `swapSession` logs the error, treats the session as empty, fires `onChange` once, and continues; it does not reject (subsequent writes will overwrite the malformed file via the standard tmp+rename path).
2. **`onChange` fires exactly once per externally observable mutation.** `record`/`amend`/`drop`/`clear`/`swapSession` each fire `onChange` exactly once after the in-memory state has been updated and disk write completed. Validation failures fire zero times.
3. **Disk and memory never diverge.** Every public mutation persists to disk *before* `onChange` fires. If the disk write fails, the in-memory state is rolled back and the mutation method rejects.
4. **No active session ⇒ tools error gracefully.** Before any `session:active-changed` event arrives, the store has no active session. `record`/`amend`/`drop` reject with `{ ok: false, error: "no_active_session" }`. `list()` returns `[]`. `clear()` is a no-op returning normally.
5. **Workspace section drops when empty.** `buildWorkspaceBlock([])` returns `null`; the section's `render()` returns `""`; `prompt:registry` drops the section entirely (no empty `<system-reminder>` block).
6. **Methodology section is byte-stable across renders.** With no config changes, `methodology.render()` returns the *same string instance* between calls (cache identity, not equality — matches `llm-system-prompt` invariant for identity).
7. **ID validation is the only gate on writes.** Tools that receive an invalid id return `{ ok: false, error: "invalid_id" }` and never reach the store. Direct service callers calling `store.record({ id: "BAD ID", ... })` throw synchronously from `validateAxiomEntry`.
8. **Drop reasons surface in the event stream.** The `tool:result` payload for `axiom_drop` includes `{ droppedId, reason }`. Tests assert the reason appears verbatim in the recorded event.
9. **Project/global memory is not touched.** No call into `memory:store` from this plugin. Verified by a no-import test (the bundled `dist/index.js` must not reference `memory:store` as a service id).
10. **Stop is idempotent.** Calling `stop()` twice succeeds; all unregister fns are guarded.

## Testing strategy

`bun:test`, no external mocking framework. Each module's tests are self-contained.

- `schema.test.ts` — id regex, length caps, required fields, premise array bounds.
- `paths.test.ts` — dir resolution, ensureDir idempotence, stale temp sweep.
- `store.test.ts` — `record`/`amend`/`drop`/`clear` round-trips against a real tmpdir; `swapSession` semantics (load existing, start empty, no-active-session error); `onChange` fires-once invariant; rollback on disk-write failure (use a mocked fs write that throws once).
- `injection.test.ts` — grouping by scope, truncation order (oldest first), empty input returns `null`, byte cap respected.
- `methodology.test.ts` — snapshot test on rendered content; cache-identity assertion.
- `tools.test.ts` — in-memory fake registry; happy paths and every error path enumerated; structured-error shape; "no active session" path.
- `slash.test.ts` — fake channel; `axioms:list` empty + populated; `axioms:show` known + unknown; `axioms:clear` confirmation flow.
- `config.test.ts` — defaults, validation failures fall back to defaults, env override.
- `index.test.ts` — fake ctx; full lifecycle; `session:active-changed` triggers `swapSession`; `stop()` idempotent; graceful degradation when each optional dep absent.

Fixture tmpdirs created via `mkdtemp` under `os.tmpdir()` and cleaned in `afterEach`. No reliance on cwd.

## Local deploy

After editing, rebuild and sync into the install dir per `CLAUDE.md`:

```bash
PLUGIN=llm-axioms
VERSION=$(jq -r .version plugins/$PLUGIN/package.json)
INSTALL_DIR=~/.kaizen/marketplaces/official/plugins/${PLUGIN}@${VERSION}
(cd plugins/$PLUGIN && bun build --target=bun --outfile=dist/index.js index.ts)
mkdir -p "$INSTALL_DIR/dist"
rsync -a --exclude='node_modules' --exclude='dist' plugins/$PLUGIN/ "$INSTALL_DIR/"
cp plugins/$PLUGIN/dist/index.js "$INSTALL_DIR/dist/index.js"
```

`llm-contracts` must be redeployed first (since `axioms:registry` is a new contract there) and its version bumped. Then `llm-axioms` deploys. Then bump `harnesses/openai-compatible.json` to point at the new versions of both.

## Decisions log

| # | Decision | Rationale |
|---|---|---|
| 1 | New plugin, not a memory type | Different lifetime (session vs user/project), different schema (structured premises/reasoning vs free body), different reset semantics. Forcing axioms through `MemoryEntry` would bloat that contract or strip structure from axioms. |
| 2 | Session-scoped, not turn-scoped | Vague qualifiers in the original request ("world-class") frame the whole session. Re-deriving each turn invites drift and wastes tokens. |
| 3 | Persist with session | If `llm-session-manager` resumes a session tomorrow, the axioms resume too. Stored under `~/.kaizen/plugins/llm-axioms/sessions/<id>.json` rather than piggybacking on `sessions:store` metadata (which is set-on-create only). |
| 4 | Structured schema (premises/reasoning/scope) | The whole pitch is rigor. A soft `notes` field undermines it. |
| 5 | Three tools (record/amend/drop) over upsert/batch | Each tool's intent is independently visible in the `tools:registry` event stream — half the value is watching derivation happen. |
| 6 | Two prompt sections (methodology static, workspace dynamic) | Independently disable-able; static side avoids unnecessary generation bumps. |
| 7 | `/axioms:clear` included, no per-axiom user mutations | Resetting the frame is distinct from editing a specific axiom and is genuinely useful when the model has reasoned itself into a corner. |
| 8 | `axioms:registry` contract in `llm-contracts` | Cross-plugin contract per the architecture rules. Passes the swap-the-provider acid test. |
| 9 | No auto-extraction from user messages | Methodology section teaches the model to derive explicitly; heuristic auto-derivation would write low-quality axioms and waste tokens. |

## Architecture review checklist

Per `docs/PLUGIN_ARCHITECTURE.md` § "Review Checklist":

| Question | Answer |
|---|---|
| Is the contract type in `llm-contracts/public`? | Yes. `AxiomEntry` and `AxiomsRegistryService` are added to `plugins/llm-contracts/contracts/axioms-registry.ts` and re-exported from `plugins/llm-contracts/public.ts`. |
| Is the contract ID in `<domain>:<role>` form with no plugin-name prefix? | Yes. `axioms:registry` — `<domain>` is the concept noun ("axioms"), `<role>` is the contract kind ("registry"). No `llm-axioms:*` form anywhere in the contract. |
| Can another implementation reasonably slot in without changing consumers? | Yes. The acid test above demonstrates this: a stub provider satisfying the contract makes the harness boot and leaves every consumer untouched. The two prompt sections and three tools are *plugin features*, not contract features — a replacement provider is free to ship its own or none. |
| Is the dependency hard, topo-hint optional, or deferred optional? Does `services.consumes`, the `consumeService` call, and the `useService` call site agree on the answer? | Yes. `events:vocabulary` is hard (all three call sites agree). `config:store`, `prompt:registry`, `tools:registry`, `slash:registry` are topo-hint optional (declared in `services.consumes`, no `consumeService`, conditional registration in `setup()`). No deferred-optional lookups in this plugin. |
| Are docs and tests locking the intended ownership boundary? | Yes. `plugins/llm-axioms/CLAUDE.md` will document the module map, invariants, and the boundary that only `store.ts` touches disk. `test/index.test.ts` asserts `provideService("axioms:registry", ...)` is called exactly once. `plugins/llm-contracts/test/index.test.ts` asserts `defineService("axioms:registry", ...)` is called. |
| Provider swappability — is the consumer surface narrow enough that a different implementation could slot in? | Yes. `AxiomsRegistryService` has six methods, all about the workspace; nothing leaks transport, disk layout, or render concerns. |
| Cardinality — one provider, or registry-of-providers? | Cardinality-one. One workspace per session is the correct model. See "Cardinality" above. |
| Are non-contract types correctly placed (impl-internal in plugin, contract surface in `llm-contracts`)? | Yes. See "Non-contract public surface" table above. |

## Open questions for implementation

These are not blockers for the spec; they're implementation-time decisions to make in PR.

- Exact wording of the methodology section (will go through copy editing as a separate concern from the design).
- Whether `/axioms:clear` confirmation should match `session:delete`'s pattern verbatim or adopt the channel's idiomatic confirmation. Check `llm-session-manager/slash.ts` during implementation.
- Whether to expose a numeric `version` field at the top of session JSON (yes, included above) to future-proof schema migrations. Keep it; cost is zero.
