# Migration plan: llm-environment

> **Scope note.** `llm-environment`'s purpose is to surface environment *data*
> (cwd, platform, git branch) to the LLM via a prompt section. That data is
> the plugin's *output*, not its config — it is captured at runtime via
> `process.cwd()`, `process.platform`, `node:os.release()`, and a synchronous
> `.git/` walk. None of those become config fields. The only user-meaningful
> configurable knob the plugin exposes today is the kill switch.

## Current state

Config-ish read sites:

- `plugins/llm-environment/environment.ts:86` — `env.KAIZEN_ENVIRONMENT_DISABLE === "1"` kill switch (read on every `render()` via the `env` captured in `captureEnvironment`).
- `plugins/llm-environment/index.ts:34` — `runtime.cwd ?? process.cwd()`. Runtime data (the env the plugin surfaces), not config.
- `plugins/llm-environment/index.ts:35` — `runtime.env ?? process.env`. Used both to thread the kill-switch read into `environment.ts` and as the env hint for capture. Not config in itself.
- `plugins/llm-environment/environment.ts:23-25` — `SECTION_ID`, `SECTION_PRIORITY = 30`, `SECTION_TITLE = "Environment"`. Internal coordination with the prompt registry; not user-meaningful knobs (priority is cross-plugin policy, title is cosmetic).

No custom config-file readers, no constructor args wired from non-defaults, no other hardcoded constants worth surfacing.

The kill switch is documented in the README as one of three layers (env var → per-session `prompt:disable` → uninstall). Migration converts layer 1 from an env var into a config-file boolean, in line with the "no env vars" rule in INTEGRATION.md.

## Proposed `LlmEnvironmentConfig`

```ts
export interface LlmEnvironmentConfig {
  enabled: boolean;
}
```

A single boolean. Default `true` preserves current behavior (section renders unless the user explicitly opts out). Setting `enabled: false` reproduces the old `KAIZEN_ENVIRONMENT_DISABLE=1` behavior — `render()` returns `""` and the prompt registry drops the section.

## Defaults and schema

| Field   | Default | FieldSchema           | Notes |
|---------|---------|-----------------------|-------|
| enabled | `true`  | `{ type: "boolean" }` | Replaces the `KAIZEN_ENVIRONMENT_DISABLE=1` kill switch. |

## Code changes

Files to add:

- `plugins/llm-environment/config.ts` — exports `DEFAULT_CONFIG` (frozen) and `CONFIG_SCHEMA: Record<keyof LlmEnvironmentConfig, FieldSchema>`. Mirrors `plugins/llm-axioms/config.ts`.

Files to edit:

- `plugins/llm-environment/public.d.ts` — add the `LlmEnvironmentConfig` interface (plugin-private; no other plugin consumes it).
- `plugins/llm-environment/environment.ts`:
  - Drop the `env` parameter on `CaptureOptions` (no longer needed once the kill switch comes from config). Keep `cwd` — that is genuine runtime data.
  - Remove `const env = opts.env ?? process.env;` and the `env.KAIZEN_ENVIRONMENT_DISABLE === "1"` check inside `render()`.
  - Add an `enabled: boolean` to `CaptureOptions` (or a `getEnabled: () => boolean` callback if a live `watch()` is wired up later — see "Risks" below). When `enabled === false`, `render()` returns `""`.
  - Drop the `import { ... }` for env if it becomes unused.
- `plugins/llm-environment/index.ts`:
  - Import `ConfigStoreService` from `llm-contracts/public`, plus `DEFAULT_CONFIG` and `CONFIG_SCHEMA` from `./config.ts`, plus `LlmEnvironmentConfig` from `./public.d.ts`.
  - Early in `setup()`, look up `config:store` via `safeUseService` (matches the plugin's existing topo-hint-optional style), call `register<LlmEnvironmentConfig>({...})` inside a try/catch, and `get<LlmEnvironmentConfig>("llm-environment")`. Fall back to `{ ...DEFAULT_CONFIG }` if the service is missing or registration throws.
  - Pass `config.enabled` into `captureEnvironment({ cwd, enabled: config.enabled })`. Drop the `env: runtime.env ?? process.env` argument.
  - **Do not** add a `watch()` call. The plugin already requires `/env:refresh` (or `environment_refresh`) to re-capture; treating `enabled` as setup-time-only matches that "static between refreshes" invariant. Document this in CLAUDE.md.

Files/lines to delete:

- The `KAIZEN_ENVIRONMENT_DISABLE` documentation entry in `plugins/llm-environment/README.md` ("Kill switches" §, item 1) — replace with a config-driven equivalent ("Set `enabled: false` in the harness config").
- The `KAIZEN_ENVIRONMENT_DISABLE` mention in `plugins/llm-environment/CLAUDE.md` ("Invariants" §, "Empty render → section dropped" bullet) — update to reference the config field.
- Any test that explicitly exercises `env: { KAIZEN_ENVIRONMENT_DISABLE: "1" }` in `plugins/llm-environment/test/` should be updated to pass `enabled: false` into `captureEnvironment` instead.

## Manifest changes

`plugins/llm-environment/package.json`:

- Add `"config:store"` to `services.consumes` (alongside `prompt:registry`, `slash:registry`, `tools:registry`). Topo-hint optional — matches the `safeUseService` fallback pattern already used for slash/tools.

No permissions to remove (the plugin's manifest already has no `fs.read`/`fs.write` entries for config; the FS reads for `.git/HEAD` are runtime data, not config, and stay under the existing `unscoped` tier).

## Risks / open questions

- **No `watch()`.** The plugin's "snapshot is static between refresh calls" invariant means changing `enabled` at runtime via `config:store` won't take effect until the harness restarts (or until `/env:refresh` is called *and* the render closure re-reads `enabled`). Easiest path: read `enabled` once in `setup()`, document the restart-required behavior. Alternative: pass `getEnabled: () => boolean` and have `index.ts` flip a captured `let enabled = ...` from a `watch()` callback. Recommend the simple setup-time read unless the executor sees a strong reason otherwise; live reconfig of a kill switch is rarely needed when `prompt:disable llm-environment:env` already provides a per-session toggle.
- **README messaging.** The README currently lists three kill-switch layers in increasing finality. The first layer changes from "env var" to "config field"; double-check the ordering still reads naturally (config field is more durable than env var, so finality ordering still holds).
- **No platform/cwd config knob.** The plan deliberately leaves `runtime.cwd` and `runtime.env` overrides alone — they are test seams used by `index.test.ts`, not user-facing config. They stay as the existing `PluginContext & RuntimeHints` cast.

## Contract proposals

None. `{ type: "boolean" }` is already in the contract surface.
