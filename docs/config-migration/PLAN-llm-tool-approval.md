# PLAN — llm-tool-approval consistency audit

Audit of the already-integrated `llm-tool-approval` plugin against the
`kaizen-config` integration patterns documented in
`docs/config-migration/INTEGRATION.md` and exemplified by `llm-axioms`.

## Current state

- `services.consumes` includes `"config:store"`. Good.
- `ConfigSpec.plugin = "llm-tool-approval"` matches manifest `name`. Good.
- No `envVars` declared. Good.
- No legacy `fs.read` / `fs.write` permissions; manifest is `tier: "unscoped"`. Good.
- No `process.env.*` reads anywhere in the plugin. Good.
- Defaults (`allow`/`deny` arrays) loaded from `defaults.json` and handed to
  `cfgSvc.register({ defaults, schema })` inline inside `setup()`.
- No `config.ts` module. The `ToolApprovalConfig` type, defaults coercion,
  and `FieldSchema` literal are all inline in `index.ts`.
- `config:store` is treated as **required** at `setup()` time:
  `ctx.useService<ConfigStoreService>("config:store")` is destructured straight
  into `cfgSvc` and `cfgSvc.register(...)` runs unguarded. If the service is
  missing or `register()` throws, `setup()` propagates the error.
- `ctx.consumeService("config:store")` is called at the top of `setup()`
  alongside `ui:prompt`, `ui:tool-renderer`, `ui:channel`, `slash:registry`.
  `llm-axioms` does not do this.
- `defaults.json` is the shipped baseline allow-list; it is correctly modeled
  as `defaults` for the `config:store` registration (not a separate read path).
- Project-scope writes use `cfgSvc.set(..., "project")` via
  `persist.ts → persistProjectAllow`, reading the on-disk project file
  directly (via `node:fs/promises.readFile`) to compute the project-only delta.
  This is intentional and documented; it is NOT a legacy config reader.

## Issues found

### Missed knobs

None material. Inventoried candidates:

- **Approval timeout** — there is none; the gate waits indefinitely on
  `ui:prompt`. Not a knob today; do not add one.
- **Auto-approve threshold** — N/A; resolution is deny → safety → allow → prompt.
- **Bash-safety triggers** — policy, not a tunable. `bash-safety.ts` is
  deliberately conservative; exposing the trigger list as config would
  invert the safety default. Leave hardcoded.
- **Default-allow / default-deny lists** — already exposed via the shipped
  `defaults.json` → `ConfigSpec.defaults`. The user overrides via
  home/project layers. No further work needed.
- **Custom-file readers** — `persist.ts` reads the project config file, but
  it does so to compute a delta for `set()`, not to bypass the store.
  Keep as is.

Borderline / explicit non-goals:

- `DENY_DEFAULT_REASON` / `DENY_BY_RULE_REASON` strings in `subscriber.ts`
  are user-facing text but not config-shaped. Leave.

### Pattern deviations

1. **No `config.ts` module.** `llm-axioms` and the INTEGRATION.md template
   put `DEFAULT_CONFIG` (frozen) + `CONFIG_SCHEMA` in a dedicated pure
   `config.ts` and import them from `index.ts`. `llm-tool-approval` inlines
   both into `index.ts` with `defaultsRaw` from `defaults.json`. The shape
   is correct but the layout diverges from canon.

2. **Defaults not frozen / not a single named constant.** The template uses
   `Object.freeze({...}) as Config`; here, defaults are constructed inline
   from `defaultsRaw` with `Array.isArray(...) ? ... : []` coercion at the
   `register()` call site. Equivalent at runtime but harder to compare to
   the template at a glance.

3. **Schema is not typed `Record<keyof ToolApprovalConfig, FieldSchema>`.**
   It is supplied as an inline object literal. Compiles either way, but
   loses the keys-are-exhaustive check the canon enjoys.

4. **`ToolApprovalConfig` lives in `index.ts`, not `public.d.ts`.**
   Template puts the config type in `public.d.ts` even when plugin-private,
   for grep-ability. (`public.d.ts` does not currently exist on this plugin.)

5. **No topo-hint optional fallback for `config:store`.** Canonical pattern:

   ```ts
   let config = { ...DEFAULT_CONFIG };
   const cfgSvc = ctx.useService<ConfigStoreService>("config:store");
   if (cfgSvc) {
     try { cfgSvc.register(...); config = cfgSvc.get(...); }
     catch (e) { log(`...register failed (${e.message}); using defaults`); }
   } else {
     log("...config:store unavailable; using DEFAULT_CONFIG");
   }
   ```

   Current code calls `cfgSvc.register(...)` unguarded and assumes a non-null
   service. Practical impact in the live harness is small (kaizen-config
   boots early), but plugin tests using a fake ctx without `config:store`
   would crash, and a `register()` exception (e.g. accidental
   double-registration on hot-reload) would take `setup()` down.

6. **Explicit `ctx.consumeService(...)` calls at the top of `setup()`.**
   `llm-axioms` does not emit these — `useService` is sufficient and
   declaring the consume in `package.json` covers the topo hint. Not wrong,
   but inconsistent with canon and noise the reader has to parse.

7. **`rules()` re-coerces `allow` / `deny` arrays on every invocation.**
   The schema validates `array of string`; the store either returns a valid
   array or falls back to defaults. The
   `Array.isArray(v?.allow) ? v.allow : []` guard inside `rules()` is
   defensive against a store contract violation, not a real failure mode.
   Minor; could be deleted now that the store layer owns shape.

### Doc drift

1. **`CLAUDE.md` module map references a `config.ts` that does not exist:**

   ```
   config.ts            Pure functions + small fs surface. Loads three sources, picks write target,
                        atomic write, dedupe + sort.
   ```

   The plugin has no `config.ts`. The "loads three sources / atomic write /
   dedupe+sort" description appears to be a pre-migration relic — that role
   is now split between `kaizen-config`'s store and `persist.ts`.
   `persist.ts` itself is not listed in the module map.

2. **`CLAUDE.md` does not document the `config:store` integration.** The
   "Invariants" section talks about "deny → allow → prompt" and persistence
   semantics but never names `config:store` or explains that
   `ConfigSpec.defaults` comes from `defaults.json`. A short pointer
   matching `llm-axioms/CLAUDE.md` style would help.

3. **`README.md` is accurate** w.r.t. the merge order and project-write
   semantics. No drift there.

## Proposed changes

Pure-consistency cleanup; no behavior change.

1. **Add `plugins/llm-tool-approval/config.ts`** mirroring `llm-axioms`:

   ```ts
   import type { FieldSchema } from "llm-contracts/public";
   import type { ToolApprovalConfig } from "./public.d.ts";
   import defaultsRaw from "./defaults.json" with { type: "json" };

   export const DEFAULT_CONFIG: ToolApprovalConfig = Object.freeze({
     allow: Array.isArray((defaultsRaw as any).allow)
       ? ((defaultsRaw as any).allow as string[])
       : [],
     deny: Array.isArray((defaultsRaw as any).deny)
       ? ((defaultsRaw as any).deny as string[])
       : [],
   }) as ToolApprovalConfig;

   export const CONFIG_SCHEMA: Record<keyof ToolApprovalConfig, FieldSchema> = {
     allow: { type: "array", items: { type: "string" } },
     deny:  { type: "array", items: { type: "string" } },
   };
   ```

2. **Add `plugins/llm-tool-approval/public.d.ts`** with the
   `ToolApprovalConfig` type; remove the inline declaration from `index.ts`.

3. **Refactor `index.ts` `setup()`** to the canonical shape:

   - Drop the explicit `ctx.consumeService(...)` chain at the top.
   - Replace the unguarded `cfgSvc.register(...)` with the
     useService → if/try/catch → fallback-log pattern from INTEGRATION.md.
     If `config:store` is unavailable, the subscriber should still run
     with `DEFAULT_CONFIG` (i.e., the shipped allow/deny baseline) and the
     prompt-driven persist path should no-op with a log line — the gate
     itself must still gate, otherwise the plugin's whole reason to exist
     is voided.
   - Hand `cfgSvc` (now possibly `null` per fallback) into `slash.ts` and
     `persist.ts`. `slash.ts` and `persist.ts` then need to tolerate a
     missing store: slash commands print a "config:store unavailable"
     notice; `persistProjectAllow` logs and treats writes as best-effort
     no-ops (consistent with the existing "write failure ≠ approval
     failure" invariant).

4. **Tighten `rules()`** to `return cfgSvc.get<ToolApprovalConfig>("llm-tool-approval");`
   once we trust the schema. Keep the existing defensive coercion only if
   we want belt-and-suspenders behavior in the fallback-no-store path.

5. **Update `CLAUDE.md` module map** to:
   - Delete the stale `config.ts` line (or repurpose it to describe the
     new `config.ts`: "Pure: `DEFAULT_CONFIG` + `CONFIG_SCHEMA` for
     `config:store`. No I/O, no `ctx`.").
   - Add `persist.ts            Pure-ish: reads project config file
     directly to compute a project-scope delta, then calls
     `cfgSvc.set(..., "project")`. Best-effort writes per invariant.`
   - Add a short Invariant: "`config:store` is the only path that owns
     allow/deny persistence; the plugin never writes config files
     directly."

6. **Optional:** drop the explicit `ctx.consumeService("ui:prompt"|...)`
   block from `setup()` — `services.consumes` in the manifest is the
   declarative source of truth. (Leaving them does no harm; removing them
   aligns with `llm-axioms`.)

## Risks / open questions

- **Fallback behavior when `config:store` is missing.** The existing code
  treats it as a hard dependency, which is arguably correct for a plugin
  whose whole job is rule-based gating. The canonical pattern fallbacks to
  defaults, which here means "ship-baseline allow + empty deny + no
  persisting `Always` choices". Need a call on which behavior is preferred.
  Recommended: follow canon (fallback to defaults), log loudly, and have
  `Always`-flavored prompt outcomes degrade to approve-once-plus-notice via
  the existing `tryPersist` catch path. This already works — the existing
  notice is `"Failed to persist approval rule: …. This call was approved
  one-time."`
- **`persistProjectAllow` reads the project file via `node:fs/promises`.**
  This is not a legacy config reader (it computes a delta for `set()`) but
  it is the one place the plugin still touches disk for config. INTEGRATION.md
  says the store's `get()` returns the merged view, which is why the direct
  read exists. If the contract grew a `getLayer(plugin, "project")` accessor
  we could drop the fs read; see "Contract proposals".
- **No test currently exercises the `config:store unavailable` branch**
  because the branch doesn't exist. Adding fallback behavior means adding
  a test with a `ctx` whose `useService("config:store")` returns null.

## Contract proposals (only if needed)

Optional, low-priority. Would let `persist.ts` drop its direct
`node:fs/promises.readFile` of the project config file.

- **`ConfigStoreService.getLayer<T>(plugin, scope: "home" | "project"): Partial<T> | undefined`** —
  returns just the values defined at one scope, without merging defaults or
  the other scope. Today, `list()` exposes `projectExists` and `projectPath`
  but not the parsed contents, forcing consumers to re-read and re-parse
  the file themselves. A `getLayer` accessor would centralize JSON parsing
  inside `kaizen-config` and let `persistProjectAllow` become:

  ```ts
  const current = cfgSvc.getLayer<ToolApprovalConfig>(plugin, "project")?.allow ?? [];
  await cfgSvc.set(plugin, { allow: dedupeSort([...current, entry]) }, "project");
  ```

  Defer until a second plugin needs this — append the proposal to
  `docs/config-migration/CONTRACTS-PROPOSALS.md` rather than editing
  `llm-contracts` directly.
