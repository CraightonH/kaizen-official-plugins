# PLAN: llm-hooks-shell config-store consistency audit

## Current state

- `plugins/llm-hooks-shell/index.ts:30-52` already wires `config:store`:
  registers `{ plugin: "llm-hooks-shell", defaults: { hooks: [] }, schema: { hooks: {...} } }`
  and reads via `cfgSvc.get<HooksConfig>("llm-hooks-shell")`.
- Manifest at `plugins/llm-hooks-shell/package.json:1-21` plus
  `index.ts:21` declares `services.consumes: ["events:vocabulary", "config:store"]`.
- Permissions are `tier: unscoped` + `exec.binaries: ["sh"]` only — no stale
  `fs.read`/`fs.write` left over from legacy hooks-file loading.
- `public.d.ts` defines `HookEntry` + `HooksConfig`.
- No `process.env.*` reads, no `homedir()`/`readFile` calls anywhere in
  `index.ts`, `runner.ts`, or `envify.ts`. Legacy `loadHookConfigs` / home+project
  `hooks.json` reader is gone (also reflected in README "breaking change in 0.1.2").
- `ConfigSpec.plugin` (`"llm-hooks-shell"`, index.ts:32) exactly matches manifest
  `name` (package.json:2).

## Issues found

### Missed knobs

- `runner.ts:23` — `DEFAULT_TIMEOUT_MS = 30_000` is hardcoded. The README
  documents the 30s default (`README.md:34,61`); per-hook `timeout_ms` overrides
  it, but the *default* itself is not user-tunable. Reasonable candidate to
  expose as `defaultTimeoutMs: number`. Borderline — most users override per
  hook; the global default is rarely tuned.
- `envify.ts:1` — `DEPTH_CAP = 4` is hardcoded and explicitly called out as
  user-visible in `CLAUDE.md` ("Depth cap = 4 … Tests assert the cap"). A user
  with deeply nested payloads cannot tune this. Borderline; canonical
  `llm-axioms` exposes similar "tunable constants" (`staleTempMs`,
  `injectionByteCap`), so the precedent favors surfacing it.

Neither is a `process.env` or legacy-file read — both are pure-constant
tunables. Surface only if we want parity with the `llm-axioms`
"expose hardcoded constants" principle.

### Pattern deviations

Compared to canonical `llm-axioms` (`index.ts`, `config.ts`):

1. **No `config.ts` module.** Defaults + schema are inlined into the
   `cfgSvc.register()` call at `index.ts:31-50`. Canonical pattern is a pure
   `config.ts` exporting `DEFAULT_CONFIG` (frozen) and
   `CONFIG_SCHEMA: Record<keyof Config, FieldSchema>`.
2. **No frozen `DEFAULT_CONFIG`.** The `{ hooks: [] }` default is a literal at
   the register site; nothing is `Object.freeze`d and nothing is spread into
   `register()` (the contract doc notes the store may mutate the held object,
   so an unfrozen literal that is also the *only* reference is fine, but it
   diverges from the canonical defensive pattern).
3. **No typed `CONFIG_SCHEMA` constant.** Schema is an inline object literal in
   `register()`. Canonical form is `Record<keyof HooksConfig, FieldSchema>` so
   key drift between type and schema is a type error.
4. **No topo-hint-optional fallback.** `index.ts:30` does
   `const cfgSvc = ctx.useService<...>("config:store")` then *unconditionally*
   calls `cfgSvc.register(...)` and `cfgSvc.get(...)`. If `config:store` is
   absent (e.g., a test harness with a fake `ctx` that returns `undefined`),
   this throws a `TypeError` at setup. Canonical pattern guards with
   `if (cfgSvc) { try { register; get } catch { log fallback } } else { log + use DEFAULT_CONFIG }`.
5. **No try/catch around `register()`.** The contract is one-shot per harness
   boot; the canonical guard logs and continues on a double-registration /
   schema-validation error. Currently any throw from `register()` aborts setup.
6. **`ctx.consumeService(...)` calls at index.ts:24-25** — canonical
   `llm-axioms` does not call `consumeService` explicitly (it relies on the
   manifest `services.consumes` + `useService`). Not strictly a bug — both
   APIs coexist — but worth confirming this is still the intended idiom for
   new code; consider dropping for consistency with `llm-axioms`.
7. **No `envVars` mapping declared.** Good — already compliant with the
   "do not declare envVars" hard constraint.

### Doc drift

- `plugins/llm-hooks-shell/CLAUDE.md` is significantly stale:
  - Module map lists `config.ts` with `loadHookConfigs(deps, vocab)`, `MUTABLE_EVENTS`,
    `realConfigDeps()` — none of which exist. `MUTABLE_EVENTS` now lives in
    `index.ts:8-12`; there is no `config.ts`, no `loadHookConfigs`, no
    `ConfigDeps`, no `realConfigDeps`.
  - "Boundaries" bullet references `ConfigDeps` and the
    `(ctx as any)._testHookDeps` injection point — neither exist in the
    current code.
  - Invariants reference "home + project hooks.json" merge semantics (now
    handled by `config:store` layering, with array-replace not concat, per the
    README's 0.1.2 breaking-change note).
  - "Adding a new mutable-event cancellation" step 1 says "Add it to
    `MUTABLE_EVENTS` in `config.ts`" — should be `index.ts`.
  - Testing section lists `config.test.ts` — file does not exist (only
    `envify.test.ts`, `index.test.ts`, `integration.test.ts`, `runner.test.ts`).
- README is consistent with the current implementation (config-store-based,
  array replacement semantics, no legacy file paths). No drift there.

## Proposed changes

1. **Extract `config.ts`** mirroring `llm-axioms/config.ts`:
   - `export const DEFAULT_CONFIG: HooksConfig = Object.freeze({ hooks: [] }) as HooksConfig;`
   - `export const CONFIG_SCHEMA: Record<keyof HooksConfig, FieldSchema> = { hooks: { type: "array", items: { ... } } };`
2. **Rewrite `index.ts` setup config block** to the canonical try/catch
   topo-hint pattern:
   ```ts
   let config: HooksConfig = { ...DEFAULT_CONFIG };
   const cfgSvc = ctx.useService<ConfigStoreService>("config:store");
   if (cfgSvc) {
     try {
       cfgSvc.register<HooksConfig>({
         plugin: "llm-hooks-shell",
         defaults: { ...DEFAULT_CONFIG },
         schema: CONFIG_SCHEMA,
       });
       config = cfgSvc.get<HooksConfig>("llm-hooks-shell");
     } catch (e) {
       log(`llm-hooks-shell: config:store register failed (${(e as Error).message}); using defaults`);
     }
   } else {
     log("llm-hooks-shell: config:store unavailable; using DEFAULT_CONFIG");
   }
   const entries: HookEntry[] = Array.isArray(config.hooks) ? config.hooks : [];
   ```
3. **Drop the `ctx.consumeService("config:store")` / `ctx.consumeService("events:vocabulary")` calls** to match `llm-axioms` style — the manifest declaration + `useService` is sufficient. (Optional; verify no harness-side dependency on the explicit call.)
4. **Update `CLAUDE.md`** to reflect reality:
   - Remove `config.ts` / `loadHookConfigs` / `ConfigDeps` / `realConfigDeps`
     / `_testHookDeps` from the module map and boundaries.
   - Add a new `config.ts` line if proposal (1) lands.
   - Rewrite "Adding a new mutable-event cancellation" step 1 to point at
     `index.ts:MUTABLE_EVENTS`.
   - Drop the `config.test.ts` bullet from "Testing".
   - Replace home+project `hooks.json` merge invariant with a pointer to the
     `config:store` layering semantics (array-replace, not concat).
5. **(Optional) Surface `defaultTimeoutMs` and/or `depthCap`** as config fields
   if we want to match the `llm-axioms` "expose tunable constants" precedent.
   Adds two `FieldSchema` entries (`{ type: "number", min: 1, integer: true }`)
   and one threading change each in `runner.ts` / `envify.ts`. Skip if we'd
   rather keep the config surface minimal — these are low-value knobs.

## Risks / open questions

- **Does the local harness ever return `undefined` from
  `useService("config:store")`?** `kaizen-config` boots right after
  `llm-contracts`, so in practice no — but the canonical guard is cheap
  insurance and is what every other migrated plugin does. Worth adopting for
  symmetry.
- **Test surface.** There is no `index.test.ts` coverage of the new
  fallback-when-cfgSvc-missing branch (since today the code would
  null-deref). Adding the guard creates a new branch; recommend a minimal
  test that constructs a fake `ctx` with `useService` returning `undefined`
  and asserts setup completes without throwing.
- **`depthCap` / `defaultTimeoutMs` exposure.** Both are user-visible
  (`README.md`, `CLAUDE.md` invariants). Promoting them to config means the
  invariants ("Depth cap = 4") become parameterized; tests that assert the
  literal `4` need to read the config instead. Low risk, mild churn — defer
  unless a user has asked.
- **`ctx.consumeService` removal.** Confirm no kaizen-runtime quirk requires
  the explicit call before `useService`. If `llm-axioms` works without it,
  this plugin should too — but worth a smoke-test before merging.

## Contract proposals

None. The existing `FieldSchema` (`array` + nested `object` with
`additionalProperties: true`) covers the `hooks` field shape adequately, and
no new contract surface is needed for the proposed changes.
