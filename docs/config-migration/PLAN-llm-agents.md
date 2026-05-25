# PLAN — llm-agents config integration audit

## Current state

`llm-agents` already routes its three knobs (`maxDepth`, `userDir`, `projectDir`)
through `config:store` in `index.ts`. There is no `config.ts` module — defaults
and schema are inlined into the `register()` call. The plugin manifest lists
`"config:store"` in `services.consumes`. No `process.env` reads remain; no
legacy per-plugin config file is read. No `envVars` declared. No
config-related `fs.read`/`fs.write` permissions (tier is `unscoped`). The
remaining `node:fs/promises` calls in `index.ts` (`readdir`, `stat`, `realpath`,
`readFile`) are for agent-manifest discovery (data, not config) and stay.

Files of interest:

- `plugins/llm-agents/index.ts` — registers `config:store` inline; reads cfg via `cfgSvc.get(...)`.
- `plugins/llm-agents/public.d.ts` — declares `AgentsConfigFile` (all fields optional).
- `plugins/llm-agents/CLAUDE.md` — module map references a `config.ts` that does not exist.
- `plugins/llm-agents/README.md` — "Configuration" section still documents the legacy file-path + env-var resolution.

## Issues found

### Missed knobs

None. The previously-tunable knobs (`maxDepth`, `userDir`, `projectDir`) are
all routed through `config:store`. Hardcoded constants that remain are policy
or safety bounds, not user-facing tunables:

- `loader.ts` recursive-walk hard cap of 8 levels — invariant per `CLAUDE.md`
  ("This bound exists to fail loud on accidental symlink loops"); keep
  hardcoded.
- `frontmatter.ts` 64 KiB per-file cap — same category; keep hardcoded.
- `dispatch.ts` always-on tool list (`dispatch_agent`, `load_skill`) — load-bearing invariant.
- `depth.ts` 1024-iteration safety guard — safety bound.

No hidden custom-file readers, no `process.env` references in plugin source.

### Pattern deviations

1. **No `config.ts` module.** `DEFAULT_CONFIG` and the `FieldSchema` map are
   inlined as object literals inside the `register()` call in `index.ts`.
   Canonical (`llm-axioms/config.ts`) extracts both to a pure module with
   `Object.freeze(...)` on the defaults and a typed
   `Record<keyof AgentsConfigFile, FieldSchema>` for the schema. The current
   shape compiles, but it breaks the documented invariant from
   `docs/config-migration/INTEGRATION.md` ("A small, pure module: defaults +
   schema. No I/O, no `ctx`.") and makes test-only access to the defaults
   awkward.

2. **No fallback when `config:store` is absent.** `index.ts` does:

   ```ts
   const cfgSvc = ctx.useService<ConfigStoreService>("config:store");
   cfgSvc.register<AgentsConfigFile>({ ... });
   const cfg = cfgSvc.get<AgentsConfigFile>("llm-agents");
   ```

   `useService` returns `undefined` when the provider is missing. The
   canonical pattern (`llm-axioms/index.ts`) guards with `if (cfgSvc) { ... }
   else { log("…unavailable; using DEFAULT_CONFIG") }`. Today this would
   throw `Cannot read properties of undefined (reading 'register')` in any
   harness that does not boot `kaizen-config` (notably plugin unit tests
   using a fake `ctx`).

3. **No try/catch around `register()`.** Canonical wraps the
   `register/get` block in `try/catch` and logs "config:store register failed
   (…); using defaults" on failure. `register()` is one-shot per harness boot
   and throws on second call (hot-reload during dev). Today llm-agents will
   crash on the second `setup()` cycle.

4. **`ctx.consumeService("config:store")` upgrades the dep to hard.** Line 51
   of `index.ts` calls `ctx.consumeService("config:store")` in addition to the
   manifest entry. Per `docs/config-migration/INTEGRATION.md` and the
   `llm-axioms` precedent, `config:store` is a **topo-hint optional**
   consume. Hardening it via `consumeService` removes the topo-hint-optional
   fallback path and makes the plugin unbootable when `config:store` is not
   provided. Drop this line; keep only the manifest entry.

5. **`AgentsConfigFile` fields are all-optional.** `public.d.ts` declares
   `maxDepth?`, `userDir?`, `projectDir?`. Because `register()` supplies
   `defaults` covering every field, the merged `get()` return is guaranteed
   to be fully populated — the `?` only forces non-null assertions (`cfg.maxDepth!`)
   at the three use sites in `index.ts`. Canonical (`llm-axioms`) declares
   non-optional fields. Tightening this drops the assertions.

6. **`schema` field `userDir` / `projectDir` use `min: 1`.** Minor: canonical
   has no min on path-shaped string fields (an empty string would already be
   caught downstream by `resolveDir`). Not a deviation worth fixing, but
   noted for symmetry — leave as-is.

7. **Section render returns synchronously, no `async`.** `sectionHandle`
   render is `() => buildAgentsBlock(handle.service.list())`. `llm-axioms`
   uses `async () =>`. Both are valid per the `prompt:registry` contract
   (renderers can be sync or async). Not a deviation.

### Doc drift

1. **`CLAUDE.md` module map references `config.ts`.** Line 13–14:

   > `config.ts       loadConfig({ home, cwd, env, readFile, log }) → AgentsConfig.`
   > `                 Resolves config path, expands ~ and relatives, validates maxDepth.`

   No such file exists. This was the pre-migration entry. Replace with a
   short note pointing at `config:store` and (after this plan lands) the new
   `config.ts` that holds `DEFAULT_CONFIG` + `CONFIG_SCHEMA`.

2. **`README.md` "Configuration" section is wrong.** Lines 68–84 describe a
   legacy resolution model:

   > Default path: `~/.kaizen/plugins/llm-agents/config.json`. Missing file → defaults.
   > `KAIZEN_LLM_AGENTS_CONFIG` overrides the path. Missing override file → warning + defaults.

   None of this is true post-migration. Rewrite to describe the
   `config:store` entry (section key `llm-agents` in
   `~/.kaizen/harnesses/<key>/config.json`) and drop the env-var mention
   entirely.

3. **`README.md` "Consumes" section** does not mention `config:store`. Add
   a bullet noting it is a topo-hint optional consume (used to register the
   plugin's config; defaults are used if absent).

## Proposed changes

1. **Extract `plugins/llm-agents/config.ts`** with:

   ```ts
   import type { FieldSchema } from "llm-contracts/public";
   import type { AgentsConfigFile } from "./public.d.ts";

   export const DEFAULT_CONFIG: AgentsConfigFile = Object.freeze({
     maxDepth: 3,
     userDir: "~/.kaizen/agents",
     projectDir: ".kaizen/agents",
   }) as AgentsConfigFile;

   export const CONFIG_SCHEMA: Record<keyof AgentsConfigFile, FieldSchema> = {
     maxDepth: { type: "number", integer: true, min: 1 },
     userDir: { type: "string", min: 1 },
     projectDir: { type: "string", min: 1 },
   };
   ```

2. **Tighten `AgentsConfigFile` in `public.d.ts`** — drop the `?` on all
   three fields. Internal type only; no consumer impact.

3. **Rewire `index.ts` `setup()`** to match `llm-axioms`:
   - Remove `ctx.consumeService("config:store")` (line 51).
   - Replace the inline register block with the canonical
     `if (cfgSvc) { try { register/get } catch { log + defaults } } else { log }`
     pattern.
   - Drop the `cfg.maxDepth!` / `cfg.userDir!` / `cfg.projectDir!`
     non-null assertions.

4. **Update `CLAUDE.md`** module map — replace the stale `config.ts` line
   with one that describes the new pure config module (mirror axioms).

5. **Update `README.md`** — rewrite the "Configuration" section to describe
   the `config:store` entry; add `config:store` to the "Consumes" list as
   topo-hint optional.

6. **No manifest change.** `services.consumes` already includes
   `"config:store"`. No new permissions. No `envVars`.

## Risks / open questions

- **Hot-reload behavior.** Adding try/catch around `register()` is purely
  defensive; today a second `setup()` would throw on the already-registered
  plugin name. Verify with `bun test` that no test relies on the throw.
- **Test fakes.** `index.test.ts` and `test/` likely build fake `ctx`s. If
  any fake provides a stubbed `config:store`, the new guarded path won't
  change its behavior. If a fake omits it, the new fallback path begins
  executing — confirm by re-running `bun test` after the change.
- **README change is user-visible.** The legacy `KAIZEN_LLM_AGENTS_CONFIG`
  env var is documented as supported today. Anyone with that env var set
  will silently lose effect post-migration. The repo-wide migration already
  accepted this trade-off (see `INTEGRATION.md` "What this migration does
  NOT do" — no backward-compat shims).

## Contract proposals

None. The current `ConfigStoreService` / `FieldSchema` surface is sufficient
for every knob in this plugin. No new field types, no new validators, no new
methods required.
