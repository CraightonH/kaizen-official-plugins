# PLAN-llm-memory

Audit of `plugins/llm-memory/` against the `kaizen-config` integration patterns codified in `docs/config-migration/INTEGRATION.md` and the canonical `plugins/llm-axioms/` reference.

## Current state

- Already integrates with `config:store` — `index.ts` calls `cfgSvc.register<MemoryConfig>(...)` and `cfgSvc.get<MemoryConfig>(...)`.
- `services.consumes` already includes `"config:store"` alongside `"prompt:registry"` and `"tools:registry"`.
- `ConfigSpec.plugin` is `"llm-memory"`, matching `package.json` `name`.
- Defaults live in `defaults.ts` (frozen via `Object.freeze`) — there is no `config.ts` file; schema is declared inline in `index.ts` instead.
- `permissions: { tier: "unscoped" }`; no legacy `fs.read`/`fs.write` perms to drop (memory legitimately persists data).
- No `envVars` declared on the spec — good.
- The plugin still reads `process.env.HOME` in `index.ts` to resolve dirs.
- `README.md` and `CLAUDE.md` still document the legacy `~/.kaizen/plugins/llm-memory/config.json` file and `KAIZEN_LLM_MEMORY_CONFIG` env override (no longer in the source).

## Issues found

### Missed knobs

None substantive in the source. All previously hardcoded tunables (`injectionByteCap`, `staleTempMs`, `autoExtract`, `extractTriggers`, `denyTypes`, `globalDir`, `projectDir`) are exposed as config fields. The `SIDE_PROMPT` in `extract.ts` and the auto-extract recall limit `5` (in `tools.ts`/`memory_recall`) are intentionally not user-tunable — borderline, but consistent with the "policy lives in code" stance taken by `llm-axioms`. Leave them.

### Pattern deviations

1. **No `config.ts` — schema is inline in `index.ts`.** Canonical layout per INTEGRATION.md and `llm-axioms` is a separate `config.ts` that exports both `DEFAULT_CONFIG` and a `CONFIG_SCHEMA: Record<keyof MemoryConfig, FieldSchema>`. Today the schema lives inline at `index.ts:38-44`, and `DEFAULT_CONFIG` is in `defaults.ts`. Two-file split into `config.ts` aligns with the reference and removes a tiny module.

2. **No fallback when `config:store` is unavailable.** `index.ts:33-46` calls `ctx.consumeService("config:store")`, then `ctx.useService<ConfigStoreService>("config:store")`, then **immediately** dereferences `cfgSvc.register(...)` / `cfgSvc.get(...)` without a null guard. `llm-axioms` and the INTEGRATION template both guard with `if (cfgSvc) { ... } else { log("…unavailable; using DEFAULT_CONFIG") }`. This matters for plugin unit tests using a fake `ctx` and for any harness that disables `kaizen-config`.

3. **No `try/catch` around `register()`.** The template wraps `register()` in `try { … } catch (e) { log(\`… register failed (${(e as Error).message}); using defaults\`) }` so accidental double-registration (e.g., hot-reload during dev) degrades to defaults instead of crashing setup. llm-memory has no such guard.

4. **`ctx.consumeService("config:store")` extra call.** `llm-axioms` does not call `ctx.consumeService` — it relies solely on the manifest `services.consumes` declaration plus `ctx.useService`. The explicit `consumeService` call is redundant and not part of the canonical template. (Probably harmless but inconsistent.)

5. **`process.env.HOME` read remains.** `index.ts:48` uses `home: process.env.HOME ?? "/"` to drive `resolveDirs`. INTEGRATION.md is explicit: "Direct `process.env.*` reads in plugins are being removed." Even though `HOME` is not a config knob per se, the canonical fix is `import { homedir } from "node:os"; … home: homedir()` — exactly what `llm-axioms/index.ts:59` does. This is a small, mechanical alignment fix.

6. **`defaults` spread is hand-rolled per array field.** `index.ts:37` does `{ ...DEFAULT_CONFIG, extractTriggers: [...DEFAULT_CONFIG.extractTriggers], denyTypes: [...DEFAULT_CONFIG.denyTypes] }` to avoid handing the store a frozen array. The convention from `llm-axioms` is a plain `{ ...DEFAULT_CONFIG }` shallow-spread; arrays are still references but the store does not mutate them in practice. Either keep the defensive deep-copy (and add a comment explaining why) or align with the simpler shallow-spread. Borderline.

### Doc drift

1. **`README.md` lines 78-95** — the entire "Configuration" section describes the legacy `~/.kaizen/plugins/llm-memory/config.json` file and the `KAIZEN_LLM_MEMORY_CONFIG=…` env override. Neither exists in the current `index.ts`. Replace with a pointer to the harness-level `config.json` under `~/.kaizen/harnesses/<key>/config.json` and the `/config` slash commands exposed by `kaizen-config`. Field table can stay verbatim (keys, defaults, semantics are unchanged).

2. **`CLAUDE.md` line 14-17** — "`config.ts` … `loadConfig({ home, env, readFile, log }) → MemoryConfig`. Reads `~/.kaizen/plugins/llm-memory/config.json` (or `KAIZEN_LLM_MEMORY_CONFIG` override). Pure logic; defaults frozen as `DEFAULT_CONFIG`. Validates injectionByteCap, staleTempMs, denyTypes." — describes a module that no longer exists. Replace with the actual current shape: `defaults.ts` holds `DEFAULT_CONFIG`; validation is now the store's responsibility via `CONFIG_SCHEMA`. After the proposed `config.ts` split this becomes "defaults + CONFIG_SCHEMA for config:store" mirroring `llm-axioms`.

3. **`CLAUDE.md` line 73** — "`MemoryType` is exported from `public.d.ts` and re-validated in three places: `frontmatter.ts` (parse), `tools.ts` (JSON schema enums), and `config.ts` (`VALID_TYPES` for `denyTypes`)." — the `config.ts` half is stale; today the enum is in the inline schema in `index.ts:42`. After the split, update this pointer to the new `config.ts`.

## Proposed changes

In execution order:

1. **Create `plugins/llm-memory/config.ts`** containing:
   - `export const DEFAULT_CONFIG: MemoryConfig = Object.freeze({ … }) as MemoryConfig;` — moved from `defaults.ts`.
   - `export const CONFIG_SCHEMA: Record<keyof MemoryConfig, FieldSchema> = { … };` — lifted verbatim from `index.ts:38-44`. Add `globalDir: { type: "string" }` and `projectDir: { type: "string" }` to the schema (they're currently absent from the inline schema — easy miss to fix while we're moving the file).

2. **Delete `plugins/llm-memory/defaults.ts`** and update imports (only `index.ts` imports it today).

3. **Refactor `plugins/llm-memory/index.ts`** to mirror `llm-axioms`:
   - Import `{ DEFAULT_CONFIG, CONFIG_SCHEMA }` from `./config.ts`.
   - Import `{ homedir }` from `"node:os"`.
   - Replace `process.env.HOME ?? "/"` with `homedir()`.
   - Drop the explicit `ctx.consumeService("config:store")` line.
   - Wrap the `cfgSvc.register / get` block in the canonical pattern:

     ```ts
     let config: MemoryConfig = { ...DEFAULT_CONFIG };
     const cfgSvc = ctx.useService<ConfigStoreService>("config:store");
     if (cfgSvc) {
       try {
         cfgSvc.register<MemoryConfig>({
           plugin: "llm-memory",
           defaults: { ...DEFAULT_CONFIG },
           schema: CONFIG_SCHEMA,
         });
         config = cfgSvc.get<MemoryConfig>("llm-memory");
       } catch (e) {
         log(`llm-memory: config:store register failed (${(e as Error).message}); using defaults`);
       }
     } else {
       log("llm-memory: config:store unavailable; using DEFAULT_CONFIG");
     }
     ```

   - Decide on the defensive array copy: prefer keeping the comment-justified deep-copy in the `defaults:` arg only if a unit test demonstrates a mutation hazard; otherwise simplify to `{ ...DEFAULT_CONFIG }`.

4. **Update `README.md`** — replace the legacy `Configuration` section (file path + env override paragraphs) with a one-paragraph pointer to `~/.kaizen/harnesses/<key>/config.json` and the `/config` UX from `kaizen-config`. Field table stays.

5. **Update `CLAUDE.md`** — fix the module-map entry for `config.ts` (after the split), drop the legacy `loadConfig` description, and update the `MemoryType` re-validation pointer (line 73) to reference the new `config.ts`.

6. **Verify**: `cd plugins/llm-memory && bun test` and `kaizen plugin validate plugins/llm-memory`. The `test/index.test.ts` fake-`ctx` lifecycle test is the one most likely to be impacted by the fallback-path refactor — confirm it passes both with and without a `config:store` service registered on the fake ctx.

## Risks / open questions

- **Fake-ctx tests in `test/index.test.ts`** likely register a stub `config:store` already; the new `if (cfgSvc) … else …` branch needs at least one test path covering the missing-service case to keep coverage on par with `llm-axioms`. Not blocking, but worth noting.
- **Schema completeness** — adding `globalDir` / `projectDir` to `CONFIG_SCHEMA` lets the store validate user input for those fields. They are `string | null` in `MemoryConfig`; the `FieldSchema` union from `llm-contracts/public` does not natively express "string-or-null." Options:
  1. Mark the schema field as `{ type: "string" }` and rely on `defaults: null` plus runtime tolerance in `resolveDirs` (already handles `null | undefined`). Validation will reject explicit user `null` values written via `cfgSvc.set`.
  2. Omit them from the schema entirely (current behavior) so the store stores them as-is without validation.
  3. Propose a `nullable: true` flag in the contracts proposals doc.
  Recommend **option 2** for now (omit + comment) — preserves today's behavior and avoids a contract change. Mention in the plan if option 3 is desired.
- **`extractTriggers` schema** uses `{ type: "array", items: { type: "string" } }` — fine, but consider tightening with a per-item `min: 1` to reject empty trigger strings. Optional polish, not required for consistency.

## Contract proposals

None required. The contract surface in `llm-contracts/public.ts` is sufficient for every knob in `MemoryConfig` as currently shaped, modulo the `string | null` borderline noted above (which is best handled by omitting those fields from the schema rather than extending the contract).
