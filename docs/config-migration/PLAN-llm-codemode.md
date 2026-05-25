# PLAN: llm-codemode config-migration consistency

## Current state

`llm-codemode` is already integrated with `config:store`. It declares
`"config:store"` in `services.consumes`, registers a `CodeModeConfig`
({ timeoutMs, maxStdoutBytes, maxReturnBytes, sandbox }) with sensible
defaults and a small inline schema, and reads `config = cfgSvc.get(...)`
once in `setup()`. The handler and `sandbox-host.ts` consume `config.*`
directly — no leftover `process.env` reads, no `readFile`/`readFileSync`
of a per-plugin config file, no custom JSON parsing. There are no
secret fields. No `fs.read`/`fs.write` permissions on the manifest
(`permissions: { tier: "unscoped" }`), nothing to drop there. No
`envVars` declared on the `ConfigSpec`. `ConfigSpec.plugin` is
`"llm-codemode"`, matching the manifest `name`.

So: the integration is functionally correct. What's drifted is the
**shape** of the integration vs. the canonical `llm-axioms` template,
plus a stale README section that still documents the pre-migration
config layout.

## Issues found

### Missed knobs

None. All four legacy knobs (`timeoutMs`, `maxStdoutBytes`,
`maxReturnBytes`, `sandbox`) are exposed via the store. No
`process.env` reads remain anywhere under the plugin directory. No
custom config-file reader survives. The legacy README still references
`KAIZEN_LLM_CODEMODE_CONFIG`, but it has no code-site equivalent — it's
purely doc drift (covered below).

### Pattern deviations

1. **No topo-hint-optional fallback for `config:store`.**
   `setup()` does `const cfgSvc = ctx.useService<ConfigStoreService>(...)`
   followed immediately by `cfgSvc.register(...)`. If `config:store` is
   genuinely unavailable (fake ctx in a future unit test, or a stripped
   harness), this crashes with `Cannot read properties of undefined`.
   The `llm-axioms` template guards with
   `if (cfgSvc) { try { register; get } catch { log } } else { log }`
   and starts from a spread of `DEFAULT_CONFIG`. This plugin should
   mirror that.

2. **No try/catch around `register()`.** `register()` is one-shot per
   plugin per harness boot and throws on the second call (e.g. during
   hot reload). `llm-axioms` wraps it in try/catch and logs a fallback
   line. This plugin will throw and abort `setup()` on the second call.

3. **Schema inlined at the `register()` call site.** The canonical
   layout is `config.ts` exporting both `DEFAULT_CONFIG` (frozen) and
   `CONFIG_SCHEMA: Record<keyof CodeModeConfig, FieldSchema>`. Today
   the schema lives literally inside the `cfgSvc.register({...})`
   argument in `index.ts`, and `defaults.ts` only exports
   `DEFAULT_CONFIG`. This works but diverges from every other migrated
   plugin's module map and makes the schema invisible to tests that
   want to assert on it.

4. **File named `defaults.ts` rather than `config.ts`.** Cosmetic but
   the canonical name is `config.ts` (axioms, the INTEGRATION.md
   template, every other migrated plugin). The schema move in (3)
   is a natural moment to rename.

5. **Redundant `ctx.consumeService(...)` calls.** `index.ts` opens
   `setup()` with `ctx.consumeService("tools:registry")` and
   `ctx.consumeService("config:store")` before calling `useService`.
   `llm-axioms` (and every other current plugin) relies on
   `services.consumes` in the manifest plus `useService` and does not
   call `consumeService` explicitly. The explicit calls are dead
   weight at best; at worst they're a stale pattern that suggests
   `useService` alone is insufficient. Drop them.

6. **No `envVars` declared.** Confirming: this is correct, nothing to
   remove. Flagging only because the audit checklist asks.

### Doc drift

- `README.md` "Configuration" section still says
  `~/.kaizen/plugins/llm-codemode/config.json (override via KAIZEN_LLM_CODEMODE_CONFIG)`.
  Neither path exists in code anymore — the values come from
  `config:store` (i.e. `~/.kaizen/harnesses/<key>/config.json` under
  the `"llm-codemode"` section). Update the section to point at the
  new home and drop the env-var reference. The knob table itself is
  still accurate.

- `CLAUDE.md` "Module map" describes a `config.ts` that
  `loadConfig(deps) → CodeModeConfig` and reads
  `~/.kaizen/plugins/llm-codemode/config.json (or
  KAIZEN_LLM_CODEMODE_CONFIG override)`. That file doesn't exist; the
  current file is `defaults.ts` and only exports `DEFAULT_CONFIG`.
  Update once (3)/(4) land.

## Proposed changes

Scope is limited to this plugin. No contract changes, no cross-plugin
edits.

1. **Rename `defaults.ts` → `config.ts`** and add the schema export.
   ```ts
   // plugins/llm-codemode/config.ts
   import type { FieldSchema } from "llm-contracts/public";
   import type { CodeModeConfig } from "./public.d.ts";

   export const DEFAULT_CONFIG: CodeModeConfig = Object.freeze({
     timeoutMs: 30000,
     maxStdoutBytes: 16384,
     maxReturnBytes: 4096,
     sandbox: "bun-worker",
   }) as CodeModeConfig;

   export const CONFIG_SCHEMA: Record<keyof CodeModeConfig, FieldSchema> = {
     timeoutMs: { type: "number", min: 1, integer: true },
     maxStdoutBytes: { type: "number", min: 1, integer: true },
     maxReturnBytes: { type: "number", min: 1, integer: true },
     sandbox: { type: "enum", values: ["bun-worker"] },
   };
   ```
   Note: also marks the three byte/ms fields as `integer: true` — the
   canonical axioms schema uses `integer: true` for byte caps and
   stale-ms; same treatment fits here. Existing config files with
   integer values pass; floats would now reject on `set()` (acceptable
   policy tightening, matches axioms).

2. **Rewrite the `setup()` config block** to mirror `llm-axioms`:
   ```ts
   const log = (m: string) => ctx.log?.(m);
   let config: CodeModeConfig = { ...DEFAULT_CONFIG };
   const cfgSvc = ctx.useService<ConfigStoreService>("config:store");
   if (cfgSvc) {
     try {
       cfgSvc.register<CodeModeConfig>({
         plugin: "llm-codemode",
         defaults: { ...DEFAULT_CONFIG },
         schema: CONFIG_SCHEMA,
       });
       config = cfgSvc.get<CodeModeConfig>("llm-codemode");
     } catch (e) {
       log(`llm-codemode: config:store register failed (${(e as Error).message}); using defaults`);
     }
   } else {
     log("llm-codemode: config:store unavailable; using DEFAULT_CONFIG");
   }
   ```

3. **Drop the two `ctx.consumeService(...)` lines.** `services.consumes`
   in `package.json` plus `useService` is the canonical wiring.

4. **README update.** Replace the "Configuration" section pointer:
   ```md
   Configuration lives in the shared harness config under the
   `"llm-codemode"` section
   (`~/.kaizen/harnesses/<harness>/config.json`, managed by
   `kaizen-config`). Use `/config` to inspect/edit.
   ```
   Keep the knob table. Drop the `KAIZEN_LLM_CODEMODE_CONFIG` mention
   and the "unknown keys silently ignored / `maxBlocksPerResponse`"
   paragraph — the store validates against `CONFIG_SCHEMA` now and
   unknown keys are rejected by the store, not silently ignored.

5. **CLAUDE.md update.** Replace the `config.ts` entry in the module
   map with the new shape (`DEFAULT_CONFIG (frozen) + CONFIG_SCHEMA
   for config:store`), matching the wording in `llm-axioms/CLAUDE.md`.

6. **Verify.** `cd plugins/llm-codemode && bun test`, then
   `kaizen plugin validate plugins/llm-codemode`. No new test required
   — existing tests don't touch the config wiring; the lifecycle test
   uses a fake ctx and will start exercising the topo-hint fallback
   path after change (2), which is itself a small reliability win.

## Risks / open questions

- **`unknown keys silently ignored` claim in README.** The current
  README explicitly promises that unknown keys in the legacy
  `config.json` don't error, citing the removed `maxBlocksPerResponse`
  key as the motivating case. `kaizen-config`'s store may or may not
  reject unknown keys against `CONFIG_SCHEMA` — worth a quick check of
  `plugins/kaizen-config/store.ts` before promising either behavior in
  the new README copy. If the store rejects unknowns, the README copy
  should say so; if it ignores, keep the reassurance. Not a blocker
  for the rename + schema-extraction work.

- **Tightening `integer: true`.** Existing user configs with float
  byte caps would start rejecting on `set()` (boot would still fall
  back to defaults with a log line per INTEGRATION.md "Validation
  semantics"). Almost certainly nobody has fractional byte caps, but
  flag it. Drop `integer: true` if we want strictly looser-than-axioms
  semantics — it's not a contract requirement.

- **Hot-reload double-register.** The try/catch in (2) protects against
  it, but worth noting that on a hot reload `setup()` runs again and
  `register()` will throw the second time; the try/catch catches and
  logs and the plugin keeps the previously-registered config. That's
  the same behavior `llm-axioms` accepts.

## Contract proposals

None. The current `ConfigSpec` / `FieldSchema` surface is sufficient
for every knob this plugin exposes. No new field types, validators, or
methods required.
