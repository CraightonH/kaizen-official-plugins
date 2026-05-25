# PLAN: llm-session-manager config-integration audit

## Current state

- Already integrated with `config:store`: `"config:store"` in `services.consumes`, and `setup()` registers a `SessionManagerConfig` with a single field `sessionsBase`.
- Config wiring is **inline in `index.ts`**, not factored into a `config.ts` module. No `DEFAULT_CONFIG` constant, no `CONFIG_SCHEMA` constant, defaults computed via `join(homedir(), ".kaizen", "sessions")` at call time.
- `SessionManagerConfig` interface lives inline in `index.ts`, not in `public.d.ts`. Field is optional (`sessionsBase?: string`).
- No try/catch around `cfgSvc.register(...)`. No fallback path if `config:store` is unavailable — `cfgSvc.register(...)` is called unconditionally on the result of `ctx.useService(...)`, which can be `undefined`.
- No `envVars` declared (good).
- `fs.read`/`fs.write` permissions point at `~/.kaizen/sessions/**` — these are legitimate session-data paths, not legacy config I/O. Keep them.
- Manifest `name` is `"llm-session-manager"`; `ConfigSpec.plugin` matches. Good.
- README/CLAUDE.md do not mention `config:store` or any user-tunable knobs.

## Issues found

### Missed knobs

No `process.env.*` reads anywhere in the plugin. No hardcoded numeric tunables (no retention windows, no event-log size caps, no snapshot intervals, no flush thresholds). The store is intentionally unbounded — every event is appended, every snapshot rewritten atomically. There are no candidates for new config fields based on the current code.

The `partialCommit()` heuristic ("drop trailing assistant message with unresolved tool_calls") is policy, not a tunable, and isn't a config knob.

### Pattern deviations

Significant divergence from the `llm-axioms` canonical layout:

1. **No `config.ts` module.** Defaults and schema are inline literals inside `setup()`. Canonical pattern: extract to `config.ts` with frozen `DEFAULT_CONFIG` and `Record<keyof Config, FieldSchema>` schema.
2. **`DEFAULT_CONFIG` not frozen / not a constant.** The default value (`join(homedir(), ".kaizen", "sessions")`) is computed inline at registration time. Canonical pattern: frozen module-level constant. Note: this also embeds a runtime `homedir()` call into the default rather than the string literal `"~/.kaizen/sessions"` that other plugins use — `llm-axioms` uses `"~/.kaizen/plugins/llm-axioms/sessions"` as a literal and resolves `~` downstream (`resolveAxiomsDir`). session-manager has no `~` resolver and feeds `sessionsBase` straight into `mkdirSync` / `harnessRoot`, so the absolute path is load-bearing here — but it should still be a frozen constant, not recomputed each boot.
3. **Config interface lives in `index.ts`, not `public.d.ts`.** Canonical pattern keeps the type adjacent to the config module.
4. **Config field is optional (`sessionsBase?: string`).** Canonical pattern: required field with a default, no `?`. With a default present, the merged `get()` result is always populated; the `?` is misleading and forces a non-null assertion downstream (currently masked by the fact that `sessionsBase` is just passed through as a string).
5. **No fallback if `config:store` is unavailable.** `cfgSvc.register(...)` is called without checking `if (cfgSvc)`. If `ctx.useService("config:store")` returns `undefined` (e.g., in a fake-ctx test harness, or in a harness that doesn't ship `kaizen-config`), this will throw `TypeError: Cannot read properties of undefined (reading 'register')` and crash plugin setup. Canonical pattern: `if (cfgSvc) { try { register; get } catch { log + defaults } } else { log + defaults }`.
6. **No try/catch around `register()`.** Double-registration on hot reload throws; canonical pattern swallows and logs.
7. **Redundant `ctx.consumeService("events:vocabulary")` / `ctx.consumeService("config:store")` calls.** `llm-axioms` does not emit these — declaring `consumes` in the manifest is sufficient. These look like leftover scaffolding.
8. **`SessionManagerConfig` is not exported.** Canonical pattern keeps the config type plugin-private but co-located in `public.d.ts` (private-by-convention; `llm-axioms` does this for `AxiomsConfig`).

### Doc drift

- `CLAUDE.md` does not mention the config field. With one knob exposed, this is borderline acceptable, but a one-line note under "module map" pointing at the new `config.ts` would mirror the `llm-axioms` CLAUDE.md.
- `README.md` documents the hardcoded path `~/.kaizen/sessions/<harness-key>/...` without noting that `sessionsBase` is user-configurable via `config:store`. Should add a one-liner.

## Proposed changes

1. **Extract `config.ts`** with:
   ```ts
   export const DEFAULT_CONFIG: SessionManagerConfig = Object.freeze({
     sessionsBase: join(homedir(), ".kaizen", "sessions"),
   }) as SessionManagerConfig;
   export const CONFIG_SCHEMA: Record<keyof SessionManagerConfig, FieldSchema> = {
     sessionsBase: { type: "string", min: 1 },
   };
   ```
   Decide whether to keep the `homedir()` call in the constant initializer (current behavior — absolute path baked at module load) or switch to the `~/.kaizen/sessions` literal + a `resolveSessionsBase` helper analogous to `llm-axioms/paths.ts:resolveAxiomsDir`. Recommend the latter for parity, but it's a behavioral change worth flagging — see open questions.
2. **Move `SessionManagerConfig` to `public.d.ts`** as a non-exported / plugin-private interface (mirror `AxiomsConfig`). Make `sessionsBase` required (`string`, no `?`).
3. **Rewrite `setup()` config-load block** to match the canonical template: `useService` → `if (cfgSvc) { try { register; get } catch { log fallback } } else { log fallback }`. Initialize `let config: SessionManagerConfig = { ...DEFAULT_CONFIG };` first.
4. **Drop the two `ctx.consumeService(...)` calls** in `setup()` — manifest `consumes` is the source of truth.
5. **Add `import { DEFAULT_CONFIG, CONFIG_SCHEMA } from "./config.ts"`** and `import type { SessionManagerConfig } from "./public.d.ts"`.
6. **README**: add a brief "Configuration" stanza documenting `sessionsBase` and pointing at `kaizen-config` for the file location.
7. **CLAUDE.md**: add a `config.ts` row to a (new) module map and call out the canonical pattern.
8. Permissions: no changes. Keep `~/.kaizen/sessions/**` — those are data paths, not config paths.
9. Tests: existing tests use a fake/in-memory store path — verify they still pass after the fallback path is added (they should, because the fallback uses `DEFAULT_CONFIG`).

## Risks / open questions

- **RESOLVED — `homedir()` in `DEFAULT_CONFIG` initializer vs. `~/.kaizen/sessions` literal.** Verified against `plugins/kaizen-config/{store,schema,field-rendering,index}.ts`: the store does **not** perform tilde expansion on string fields. The only `homedir()` call inside `kaizen-config` resolves the harness config root, not user field values. `sessionsBase` is fed straight into `mkdirSync` / `harnessRoot` with no tilde resolver, so a literal `"~/..."` would create a `~` directory on disk. Decision: keep `DEFAULT_CONFIG.sessionsBase = join(homedir(), ".kaizen", "sessions")` resolved at module load. Documented inline in `config.ts`.
- **Test ctx without `config:store`.** Adding the `if (cfgSvc)` fallback is a behavioral change for any test that constructs a fake ctx where `useService("config:store")` returns `undefined`. Today, the plugin would crash; after the change, it would silently fall back to defaults. That's the intended behavior, but worth a once-over of `test/`.
- **Live updates (`watch()`).** `sessionsBase` is consumed exactly once to build the store. Hot-swapping it would require tearing down and rebuilding `makeStore`. Out of scope; do not add `watch()`. The current "read once in setup" pattern is correct per `INTEGRATION.md` guidance.
- **No knobs for retention / event-log caps.** The store is unbounded by design. If/when the user wants `events.jsonl` rotation or session GC, those become new fields — currently they're not knobs, so not in scope.

## Contract proposals (only if needed)

None. The existing `FieldSchema` / `ConfigSpec` surface covers `{ type: "string", min: 1 }` cleanly. No new field types, validators, or service methods required.
