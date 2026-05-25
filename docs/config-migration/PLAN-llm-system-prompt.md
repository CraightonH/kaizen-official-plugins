# Migration plan: llm-system-prompt

> **Scope note.** `llm-system-prompt` is a registry/assembler service. Most of
> what it does is mechanical (sort by priority, cache by generation, drop
> empty bodies) and not user-tunable. The actually-configurable surface today
> is small: three env vars that control the identity section's file paths and
> kill switch, plus the `FALLBACK_PREFIX`/`FALLBACK_TEMPLATE` literal that
> users see when neither identity file exists. Migration converts the env
> vars into config fields and exposes the assembly cap / fallback text as
> optional knobs that have been quietly load-bearing for users who can't
> override them today.

## Current state

Config-ish read sites:

- `plugins/llm-system-prompt/index.ts:22-27` — `readEnv()` helper reading `ctx.env` then `process.env`. The shape stays (test seam), but the *keys* it reads become config-driven.
- `plugins/llm-system-prompt/index.ts:29-34` — `resolveGlobalPath()`: `KAIZEN_SYSTEM_PROMPT_GLOBAL` override → `${HOME}/.kaizen/system-prompt.md`. `HOME` env read stays (it's environment, not plugin config).
- `plugins/llm-system-prompt/index.ts:36-41` — `resolveProjectPath()`: `KAIZEN_SYSTEM_PROMPT_PROJECT` override → `${cwd}/.kaizen/system-prompt.md`. `cwd` stays (runtime data).
- `plugins/llm-system-prompt/identity.ts:44` — `env.KAIZEN_SYSTEM_PROMPT_DISABLE === "1"` kill switch, evaluated per `render()` call via the env captured in `resolveIdentity`.
- `plugins/llm-system-prompt/identity.ts:4-8` — `FALLBACK_PREFIX` constant and `FALLBACK_TEMPLATE(date)` string. Treated as user-visible in `CLAUDE.md` ("treat changes to it as user-visible") but not user-overridable.
- `plugins/llm-system-prompt/identity.ts:10` — `PROJECT_HEADER = "## Project context"`. Cosmetic; not surfaced as a knob today.
- `plugins/llm-system-prompt/identity.ts:59` — section priority `10`. Cross-plugin policy (lowest priority = first), not a user knob.

No custom config-file readers, no per-plugin JSON state, no `fs.read`/`fs.write` permissions tied to config (the plugin runs `tier: unscoped`).

## Proposed `LlmSystemPromptConfig`

```ts
export interface LlmSystemPromptConfig {
  /**
   * Identity section enabled. `false` reproduces the legacy
   * KAIZEN_SYSTEM_PROMPT_DISABLE=1 behavior — identity renders as "" and
   * the assembler drops the section.
   */
  enabled: boolean;

  /**
   * Path to the global identity markdown file. Tilde (`~`) is expanded
   * to the user's home directory. Defaults to `~/.kaizen/system-prompt.md`.
   */
  globalPath: string;

  /**
   * Path to the project identity markdown file. Tilde and relative paths
   * are resolved against the harness cwd. Defaults to
   * `./.kaizen/system-prompt.md` (project root convention).
   */
  projectPath: string;

  /**
   * Heading inserted between the global and project bodies when both
   * files exist. Cosmetic; rarely changed.
   */
  projectHeader: string;

  /**
   * Prefix sentence used in the built-in fallback prompt when neither
   * identity file exists. The runtime appends ` Today is <YYYY-MM-DD>.`
   * plus the rest of the fallback template.
   */
  fallbackPrefix: string;
}
```

All five fields are scalar; no nested object types are required.

## Defaults and schema

| Field          | Default                                              | FieldSchema                              | Notes |
|----------------|------------------------------------------------------|------------------------------------------|-------|
| enabled        | `true`                                               | `{ type: "boolean" }`                    | Replaces `KAIZEN_SYSTEM_PROMPT_DISABLE=1`. |
| globalPath     | `"~/.kaizen/system-prompt.md"`                       | `{ type: "string", min: 1 }`             | Tilde expansion handled in plugin (mirror `llm-axioms` for `someDir`). |
| projectPath    | `"./.kaizen/system-prompt.md"`                       | `{ type: "string", min: 1 }`             | Relative-to-cwd resolution stays in `resolveProjectPath`. |
| projectHeader  | `"## Project context"`                               | `{ type: "string" }`                     | Allow empty string to drop the divider when both files exist. |
| fallbackPrefix | `"You are a helpful assistant running locally via the kaizen local harness."` | `{ type: "string", min: 1 }` | Identical to current `FALLBACK_PREFIX`. |

Schema is intentionally strict on types but permissive on content — no enum
or regex constraints. Validation failures fall back to defaults and log a
single line per `INTEGRATION.md` ("Validation semantics").

## Code changes

Files to add:

- `plugins/llm-system-prompt/config.ts` — exports `DEFAULT_CONFIG` (frozen) and `CONFIG_SCHEMA: Record<keyof LlmSystemPromptConfig, FieldSchema>`. Mirrors `plugins/llm-axioms/config.ts`.

Files to edit:

- `plugins/llm-system-prompt/public.d.ts` — add the `LlmSystemPromptConfig` interface (plugin-private). Keep existing re-exports of `SystemPromptService` etc. from `llm-contracts/public`.
- `plugins/llm-system-prompt/identity.ts`:
  - Drop the `env` parameter on `ResolveIdentityOptions` and the `env.KAIZEN_SYSTEM_PROMPT_DISABLE` check inside `render()`. The kill switch now flows from config in `index.ts`.
  - Replace the module-level `FALLBACK_PREFIX` and `FALLBACK_TEMPLATE` constants with a function that accepts `fallbackPrefix` and `today` and returns the assembled string. Keep the date format (`YYYY-MM-DD` slice of ISO) identical.
  - Replace the module-level `PROJECT_HEADER` with a `projectHeader` value passed through `ResolveIdentityOptions`. When `projectHeader === ""`, concatenate the global and project bodies with a single blank line and no heading.
  - Add a config-driven `enabled` flag to `ResolveIdentityOptions` (or accept a `getEnabled: () => boolean` if a live `watch()` is wired — see "Risks"). When `false`, `render()` returns `""`.
- `plugins/llm-system-prompt/index.ts`:
  - Import `ConfigStoreService` from `llm-contracts/public`, plus `DEFAULT_CONFIG`/`CONFIG_SCHEMA` from `./config.ts`, plus `LlmSystemPromptConfig` from `./public.d.ts`.
  - Early in `setup()` (before `resolveIdentity`), look up `config:store` via the existing `safeUseService` helper, register the config spec inside a try/catch, and call `get<LlmSystemPromptConfig>("llm-system-prompt")`. Fall back to `{ ...DEFAULT_CONFIG }` if the service is missing or registration throws.
  - Replace `resolveGlobalPath(runtime)` / `resolveProjectPath(runtime)` with helpers that take `config.globalPath` / `config.projectPath` and apply tilde + cwd expansion. Keep `runtime.env`/`runtime.cwd` test seams alive (for `HOME` lookup and cwd-relative resolution); they are environment data, not plugin config.
  - Pass `enabled`, `projectHeader`, and `fallbackPrefix` into `resolveIdentity({ … })`.
  - **Recommend not adding `watch()`.** The identity section already requires `/prompt:reload` (or the `prompt_reload` tool) to re-read identity files. Treating config fields as setup-time-only matches that explicit-reload contract. If the executor decides to wire `watch()` anyway, it should bump `identityHandle.bumpGeneration()` after mutating the captured config and re-reading the closure.
  - Remove the now-dead `readEnv`/`KAIZEN_SYSTEM_PROMPT_*` lookups (keep `HOME` resolution).

Files/lines to delete:

- The `KAIZEN_SYSTEM_PROMPT_GLOBAL`, `KAIZEN_SYSTEM_PROMPT_PROJECT`, and `KAIZEN_SYSTEM_PROMPT_DISABLE` rows in `plugins/llm-system-prompt/README.md` ("Configuration" §). Replace with a "Configuration via `config:store`" note pointing at the new fields.
- The `FALLBACK_TEMPLATE` reference in `plugins/llm-system-prompt/CLAUDE.md` ("Editing identity behavior" §) — update to reference `fallbackPrefix` and the in-code template composer.
- Tests under `plugins/llm-system-prompt/test/` that pass `env: { KAIZEN_SYSTEM_PROMPT_DISABLE: "1" }` or env path overrides — switch them to pass an `enabled`/path option directly into `resolveIdentity` (or a fake `config:store`).

## Manifest changes

`plugins/llm-system-prompt/package.json`:

- Add `"config:store"` to `services.consumes` alongside the existing `events:vocabulary` and `tools:registry`. Topo-hint optional — matches the `safeUseService` pattern already used for `slash:registry` and `tools:registry`.

No permissions to remove (`tier: unscoped`; no fs entries are config-only).

## Risks / open questions

- **No `watch()`.** Identity files are explicitly reload-on-demand via `/prompt:reload`. Live-updating `globalPath`/`projectPath` would surprise users; live-updating `enabled` could be useful but is already covered by `/prompt:disable identity`. Recommend setup-time read only; document the restart-required (or `/prompt:reload`-required) behavior in `CLAUDE.md`.
- **Project path resolution.** Today, `resolveProjectPath` joins `cwd` with `.kaizen/system-prompt.md`. A user-supplied absolute path should bypass the cwd join; a relative path should resolve against the harness cwd. Use `node:path.isAbsolute()` to branch; document the rule.
- **Tilde expansion.** `~/.kaizen/system-prompt.md` is the default — the plugin must handle the leading `~` itself (the store does not expand it). Mirror the `llm-axioms` `someDir` handling (read `HOME` via the existing `readEnv` seam → `homedir()` fallback).
- **Empty `projectHeader`.** Allowing `""` is a deliberate UX choice (let the user merge files without an extra heading). Tests should cover both `""` and a custom heading.
- **`fallbackPrefix` only, not full template.** Exposing the entire fallback template as config would let users break the date-stamping or rest-of-template invariants. Exposing just the prefix keeps the date and "tools/skills" guidance intact while letting the user rebrand the assistant. Open question for the executor: is this the right line to draw, or should the entire fallback body be a config field? Recommendation: ship `fallbackPrefix` only in v1; promote to full template later if requested.
- **No byte cap.** Unlike `llm-axioms`, this plugin does not enforce a per-section or total byte cap — section authors are trusted. Adding a cap is plausible future work but is not load-bearing today (no current section threatens to blow up the prompt). Leaving it out of the initial migration; the field can be added without contract changes.
- **No section-priority overrides.** Section priorities are owned by each contributing plugin; exposing them as user-tunable here would split ownership. Out of scope.

## Contract proposals

None. All fields use the existing `{ type: "string" }` / `{ type: "boolean" }` shapes already in the `FieldSchema` union. No additions to `llm-contracts` needed.
