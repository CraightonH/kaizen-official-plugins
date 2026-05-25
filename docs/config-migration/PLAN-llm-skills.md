# PLAN — `llm-skills` → `config:store`

## Current state

Two env vars and one hardcoded tunable.

- `plugins/llm-skills/index.ts:14` — `const DEFAULT_RESCAN_MS = 30000`. Default throttle interval for `turn:start`-driven rescans.
- `plugins/llm-skills/index.ts:16-22` — `readEnv(ctx, key)` helper. Reads `ctx.env` first, then falls back to `process.env`. Used only for the two skills env vars (plus `HOME`, which is OS-level and not a tunable).
- `plugins/llm-skills/index.ts:24-32` — `resolveUserRoot(ctx)`. Reads `KAIZEN_LLM_SKILLS_PATH`; takes the first colon-separated segment ("v0 honours only the first segment" per README); falls back to `$HOME/.kaizen/skills`.
- `plugins/llm-skills/index.ts:34-37` — `resolveProjectRoot(ctx)`. **Not configurable** — always `<ctx.cwd>/.kaizen/skills`. Leave as-is; not a knob.
- `plugins/llm-skills/index.ts:39-43` — `rescanIntervalMs(ctx)`. Reads `KAIZEN_LLM_SKILLS_RESCAN_MS`, integer-parses, requires `>0`, falls back to `DEFAULT_RESCAN_MS`.
- `plugins/llm-skills/index.ts:76, 117-124` — `interval` captured into the `turn:start` closure; `lastScanAt` wall-clock throttle.
- `plugins/llm-skills/new-skill.ts:56-57` — `NAME_MAX = 64`, `DESCRIPTION_MAX = 200`. These are **schema/validation policy** for the `new_skill` tool input contract, not user-facing tunables. Leave as constants.
- `plugins/llm-skills/injection.ts` — pure render; no byte cap (the section just lists `name`/`tokens`/`description` per skill). No tunable to extract.
- `plugins/llm-skills/tokens.ts` — `Math.ceil(body.length / 4)` heuristic divisor is per-skill computed at registration; not a useful runtime knob (frontmatter `tokens:` already overrides).
- `plugins/llm-skills/scan.ts` — top-level subdir walk of each root; no tunable depths or excludes.
- `plugins/llm-skills/README.md:104-114` — documents the two env vars + `HOME`.

No per-plugin JSON config reader. No `fs.read`/`fs.write` paths declared (manifest uses `tier: "unscoped"`).

## Proposed `LlmSkillsConfig`

```ts
// plugins/llm-skills/public.d.ts (new export, plugin-private)
export interface LlmSkillsConfig {
  /** User-scope skills root. Default: ~/.kaizen/skills */
  userRoot: string;
  /** Min ms between turn:start-driven rescans. Default: 30000 */
  rescanIntervalMs: number;
}
```

Notes:
- **Project root stays hardcoded** at `<ctx.cwd>/.kaizen/skills`. README explicitly says it is not overridable, and routing per-project paths through a global config field would be a behavior change.
- **The colon-segmented `KAIZEN_LLM_SKILLS_PATH` quirk is dropped.** Per INTEGRATION.md "no backward-compat shims," the new `userRoot` is a single string path. The "v0 honours only the first segment" disclaimer in the README documented a placeholder for a never-shipped multi-root feature; collapsing it to a plain string field is the clean move.
- `~` expansion: defaults file already uses literal `~/.kaizen/...` strings (cf. `llm-axioms`). Path resolution downstream (in `scan.ts` / `new-skill.ts`) currently uses `homedir()`-derived absolute paths; the new code must expand a leading `~/` on `config.userRoot` before handing it to those modules. Helper lives in `index.ts` (small, local — not worth a new module).

## Defaults and schema

```ts
// plugins/llm-skills/config.ts (new file)
import type { FieldSchema } from "llm-contracts/public";
import type { LlmSkillsConfig } from "./public.d.ts";

export const DEFAULT_CONFIG: LlmSkillsConfig = Object.freeze({
  userRoot: "~/.kaizen/skills",
  rescanIntervalMs: 30_000,
}) as LlmSkillsConfig;

export const CONFIG_SCHEMA: Record<keyof LlmSkillsConfig, FieldSchema> = {
  userRoot: { type: "string", min: 1 },
  rescanIntervalMs: { type: "number", min: 0, integer: true },
};
```

Schema notes:
- `userRoot.min: 1` — empty string is meaningless; rejects on `set()`.
- `rescanIntervalMs.min: 0` (not `min: 1`) — schema is shape-only, not policy. The legacy `>0` guard in `rescanIntervalMs(ctx)` was defending against `parseInt` returning `NaN`/`<=0`; with a typed `number` field that's no longer needed. **But** the existing invariant in `CLAUDE.md` says "Never treat 0 as 'always rescan'." Keep that runtime guard in code (post-`get()` clamp): if `config.rescanIntervalMs <= 0`, fall back to `DEFAULT_CONFIG.rescanIntervalMs`. The schema stays permissive so we never silently revert user values to defaults at the store layer.

## Code changes

1. **New file** `plugins/llm-skills/config.ts` with `DEFAULT_CONFIG` + `CONFIG_SCHEMA` as above.
2. **`public.d.ts`** — add `LlmSkillsConfig` interface. Keep the existing `llm-contracts/public` re-exports unchanged.
3. **`index.ts`** rewrites:
   - Drop `readEnv`, `resolveUserRoot`, `resolveProjectRoot`, `rescanIntervalMs`, and `DEFAULT_RESCAN_MS`.
   - In `setup()`, before any logic:
     ```ts
     let config: LlmSkillsConfig = { ...DEFAULT_CONFIG };
     const cfgSvc = ctx.useService<ConfigStoreService>("config:store");
     if (cfgSvc) {
       try {
         cfgSvc.register<LlmSkillsConfig>({
           plugin: "llm-skills",
           defaults: { ...DEFAULT_CONFIG },
           schema: CONFIG_SCHEMA,
         });
         config = cfgSvc.get<LlmSkillsConfig>("llm-skills");
       } catch (e) {
         ctx.log(`llm-skills: config:store register failed (${(e as Error).message}); using defaults`);
       }
     } else {
       ctx.log("llm-skills: config:store unavailable; using DEFAULT_CONFIG");
     }
     ```
   - Add tiny local helper `expandHome(p)` — if `p === "~"` or `p.startsWith("~/")`, prefix `homedir()`. Apply to `config.userRoot` to get `userRoot` string.
   - Compute `projectRoot = join(ctx.cwd ?? process.cwd(), ".kaizen", "skills")` (unchanged behavior).
   - Compute `interval = config.rescanIntervalMs > 0 ? config.rescanIntervalMs : DEFAULT_CONFIG.rescanIntervalMs` (preserves the "never 0" invariant from `CLAUDE.md`).
   - Wire `interval`, `userRoot`, `projectRoot` exactly where the old resolvers' results went.
4. **No `watch()`** — `userRoot` is captured into the closure for `makeRegistry` (rebuilding the registry on live root change is non-trivial — registry mutation, in-flight scans, etc.); `rescanIntervalMs` is captured into the `turn:start` closure. Live updates require a restart. Document this in the plan-execution PR. The plugin already reads config once in setup() today, so this matches current behavior.
5. **README.md updates**: remove the "Configuration / Environment variables" section. Replace with a brief pointer to `kaizen-config`'s `/config` slash commands and the two configurable fields. Remove the `HOME` row (still used to resolve `~/` but not as a plugin tunable).
6. **CLAUDE.md updates**: the "Rescan throttling is wall-clock based" invariant currently names `KAIZEN_LLM_SKILLS_RESCAN_MS`. Reword to reference `config.rescanIntervalMs`; keep the "never treat 0 as always rescan" rule.
7. **Tests**: nothing under `test/` currently asserts on the env vars (verify with a grep before code changes), but the index lifecycle test passes a fake `ctx`. Confirm `ctx.useService<ConfigStoreService>("config:store")` returns `undefined` in that fake → fallback path kicks in → tests stay green. If any test explicitly stubs the env vars, swap them for a fake `cfgSvc` that returns the desired config.

## Manifest changes

`plugins/llm-skills/package.json`:

- Add `"config:store"` to `services.consumes`. Current consumes is `["tools:registry", "slash:registry"]`; new value is `["tools:registry", "slash:registry", "config:store"]`. All three are topo-hint optional.
- **No** `fs.read`/`fs.write` permission changes — `tier: "unscoped"` covers it; skills-directory I/O is plugin data, not config-file I/O.
- **No `envVars`** field on the `ConfigSpec` (per INTEGRATION.md hard constraint).

## Risks / open questions

1. **Drop of colon-separated multi-root semantics.** `KAIZEN_LLM_SKILLS_PATH=/a:/b` previously took only `/a` (with a "v0" disclaimer). New `userRoot` is a single string. Confirmed acceptable per INTEGRATION.md "no backward-compat shims." If multi-root is ever wanted, future migration to `userRoots: string[]` is straightforward.
2. **`~` expansion location.** Doing it in `index.ts` (consumer) keeps `config.ts` pure and matches `llm-axioms` (which stores `"~/..."` in defaults but doesn't appear to expand it — confirm before merging by checking whether `llm-axioms` paths actually work with a literal `~/`). If `llm-axioms` has a shared expansion utility, prefer that for consistency.
3. **Plugin distinct from `claude-skills`.** `claude-skills` is a separate plugin already on `config:store` — the config section here is `"llm-skills"`, not `"skills"` or `"claude-skills"`. Section header in `~/.kaizen/harnesses/<key>/config.json` will be `plugins.llm-skills`.
4. **Project root not configurable.** Intentional — README and the manifest's permission tier both assume a fixed `<cwd>/.kaizen/skills`. Open question: should it become `projectRoot?: string` for symmetry? Recommendation: **no** in this migration. The cwd-relative behavior is part of the project/user layering contract (`registry.ts` masks user with project); allowing it to point elsewhere would invite surprising config bleed across projects. Re-evaluate only if a concrete need surfaces.
5. **`turn:start` closure captures `interval` by value.** Live `watch()`-driven updates wouldn't take effect on the running interval anyway without restructuring. Not adding `watch()` is the right call.

## Contract proposals (only if needed)

None. The existing `ConfigStoreService` + `FieldSchema` surface covers both fields cleanly (`string`, `number`-with-`integer:true`).
