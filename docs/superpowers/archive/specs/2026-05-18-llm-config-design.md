# `llm-config` — Design

**Status:** draft
**Date:** 2026-05-18
**Scope:** A new plugin (`llm-config`) that owns plugin configuration loading, validation, and read/write APIs for the openai-compatible harness (and any future harness). Replaces eight per-plugin `config.ts` modules plus one direct `ctx.config` consumer with a single harness-scoped config file and a `config:store` service in `llm-contracts`. Adds `/config` slash commands.
**Depends on:** `slash:registry` (topo-hint optional, for slash commands). Adds one new contract (`config:store`) to `llm-contracts`. Requires migrating nine existing plugins to consume the new service.

## Goal

Standardize configuration across the harness. Plugins declare their schema + defaults at setup; everything else (load, merge, validate, env-var resolution, atomic write, watch) is centralized. Config files are keyed by harness, so the same plugin set behaves differently when loaded into different harnesses without leaking state across them.

## Non-goals (v0)

- Cross-harness shared values. Solve API-key-style cases with per-field `envVar` indirection. If a future user needs shared defaults across harnesses, layer in a `~/.kaizen/shared.json` then; YAGNI now.
- Migration from old per-plugin paths. The migration is a hard break performed in-repo as part of the same change set. Old `~/.kaizen/plugins/<name>/config.json` files are ignored after the cutover.
- Schema dependency on Zod / Valibot / similar. The runtime validator is a small, dependency-free shape walker — enough to mirror what each plugin validates inline today.
- Multi-tenant configs (per-session, per-user). One file per harness, one project override.
- A GUI / TUI config editor beyond `$EDITOR` shell-out.
- Versioning / migrations of the config file format. v0 is a single-version schema; if we ever break it, we'll add a `version` field then.

## Architectural overview

The plugin owns three concerns:

1. **Storage.** Resolve and merge two layered files keyed by harness identity:
   - Home: `~/.kaizen/harnesses/<harnessKey>/config.json`
   - Project: `<cwd>/.kaizen/harnesses/<harnessKey>/config.json` (optional; keys win over home)

   File shape:
   ```json
   {
     "plugins": {
       "openai-llm": { "baseUrl": "...", "envVars": { "apiKey": "OPENAI_API_KEY" } },
       "llm-tool-approval": { "allow": [...], "deny": [...] }
     }
   }
   ```
   Top-level keys other than `plugins` are reserved for future harness-wide settings.

2. **Registration + access.** Plugins call `config.register({ plugin, defaults, schema, envVars })` during setup. The store keeps a per-plugin entry with its defaults, schema, and a memoized merged value (defaults → home → project → env). `config.get<T>(plugin)` returns the merged frozen value.

3. **Read-write + watch.** `config.set(plugin, partial, scope)` performs atomic tmp+rename writes (preferring `project` if a project file exists or scope is explicit, else `home`). `config.watch(plugin, cb)` fires when either layer changes on disk; lookup re-merges and re-validates. Validation failure logs and keeps the last good value.

A single new plugin owns all of this; the contract lives in `llm-contracts`.

## Plugin: `llm-config`

### Lifecycle

- **Setup:** Derive `harnessKey` from `ctx.harness`. Read home and project config files (both optional). Provide `config:store`. Consume `slash:registry` (topo-hint optional); if available, register `/config list`, `/config get`, `/config set`, `/config edit`. Start `fs.watch` on both file paths (debounced 150 ms). No work waits on registration order — `register()` is the entry point for every consumer.
- **Teardown:** Stop file watchers, unregister slash commands, drop the service binding.

### Boot order

`llm-config` registers `config:store` in `setup()`. Every other configurable plugin lists `services.consumes: ["config:store"]` (hard) and calls `useService<ConfigStoreService>("config:store").register(...)` in its own setup. Kaizen's topo sort ensures `llm-config` boots first. `llm-config` itself lists `slash:registry` as topo-hint optional (already-existing pattern in `llm-tool-approval`).

### Module map

```
plugins/llm-config/
  index.ts            # plugin entry: setup/teardown, slash wiring, service binding
  store.ts            # pure: load → merge → validate → memoize; watch handlers
  paths.ts            # harnessKey derivation (mirrors llm-session-manager/harness-key.ts), path resolution
  schema.ts           # ConfigSchema validator (shape walker)
  envvars.ts          # per-field env-var resolution (replaces apiKeyEnv pattern, generalized)
  atomic-write.ts     # tmp+rename writer with mkdir -p
  slash.ts            # /config command handlers
  public.d.ts         # ConfigSchema, ConfigStoreService (re-exported from llm-contracts)
  test/
    store.test.ts
    paths.test.ts
    schema.test.ts
    envvars.test.ts
    atomic-write.test.ts
    slash.test.ts
```

`store.ts`, `schema.ts`, `paths.ts`, `envvars.ts`, and `atomic-write.ts` are pure modules (deps-injected I/O). `index.ts` is the only file that imports `kaizen/types` or touches `ctx`.

## Contract: `config:store` (new, in `llm-contracts`)

ID: `config:store`. Lives at `plugins/llm-contracts/contracts/config-store.ts`. Type-only re-export through `llm-contracts/public`.

```ts
export interface ConfigStoreService {
  register<T>(spec: ConfigSpec<T>): void;
  get<T>(plugin: string): T;                                  // throws if not registered
  set<T>(plugin: string, value: Partial<T>, scope?: ConfigScope): Promise<void>;
  watch<T>(plugin: string, cb: (next: T) => void): () => void;
  list(): ConfigStatus[];                                     // for /config list
}

export interface ConfigSpec<T> {
  plugin: string;                    // namespace key inside plugins.{...}
  defaults: T;
  schema?: ConfigSchema<T>;          // optional but recommended
  envVars?: Record<keyof T & string, string>; // { apiKey: "OPENAI_API_KEY" }
}

export type ConfigScope = "home" | "project";

export interface ConfigStatus {
  plugin: string;
  homePath: string;
  projectPath: string;
  homeExists: boolean;
  projectExists: boolean;
  // The fully resolved value's source per top-level key.
  resolution: Record<string, "default" | "home" | "project" | "env">;
}

// Shape walker — small and dependency-free.
export type ConfigSchema<T> = {
  [K in keyof T]?: FieldSchema;
};
export type FieldSchema =
  | { type: "string"; min?: number; max?: number; pattern?: string; enum?: string[] }
  | { type: "number"; min?: number; max?: number; integer?: boolean }
  | { type: "boolean" }
  | { type: "array"; items: FieldSchema; min?: number; max?: number }
  | { type: "object"; properties: Record<string, FieldSchema>; additionalProperties?: boolean | FieldSchema }
  | { type: "enum"; values: readonly string[] };
```

Definition site: `defineService("config:store", { description: "..." })` in `llm-contracts/index.ts`.

## Storage layer

### Harness key

Mirrors `llm-session-manager/harness-key.ts`: derive a sanitized string from `ctx.harness.ref` (preferred) or `ctx.harness.jsonPath` (fallback). Empty harness → `"default"`. The two plugins duplicate the derivation rather than coupling; if/when kaizen runtime exposes `ctx.harnessKey` natively, both simplify.

### Resolution order (highest precedence wins)

1. `envVars[fieldName]` — if set and `process.env[<var>]` is non-empty, that value wins, parsed via the field's schema (string → string, number → `Number()`, boolean → `"true"`/`"false"`).
2. Project file `<cwd>/.kaizen/harnesses/<harnessKey>/config.json` → `plugins[plugin]`
3. Home file `~/.kaizen/harnesses/<harnessKey>/config.json` → `plugins[plugin]`
4. `defaults` from `register()`

Top-level keys merge shallowly; nested objects are deep-merged one level (sufficient for current shapes like `retry: { maxAttempts: 3 }`). Arrays do **not** merge — later layers replace.

### Atomic write

`writeFileSync(tmp, ...)` + `renameSync(tmp, path)` after `mkdirSync(dirname(path), { recursive: true })`. Same pattern as today's `llm-tool-approval/config.ts`. The writer touches only the target plugin's section: read current file (or empty `{ plugins: {} }`), shallow-merge the new partial into `plugins[plugin]`, write back.

### Watch

`fs.watch` on both home and project paths (and their containing dirs, since `fs.watch` doesn't fire on file create). Debounce 150 ms across both layers. On change: re-read, re-merge, re-validate. On validation failure: log, keep the previous merged value, do not fire the callback. On success: fire `cb(next)` and update the memoized value.

## Slash commands

Registered when `slash:registry` is available. Topo-hint optional consume.

- `/config list` — print one row per registered plugin: `plugin | home? | project? | n keys`. Uses `ConfigStoreService.list()`.
- `/config get <plugin> [key]` — dump merged value (or single key path). Pretty-prints JSON; flags env-var-resolved fields with a marker (e.g., `"apiKey": "***" (env:OPENAI_API_KEY)`).
- `/config set <plugin> <key>=<value> [--project]` — atomic write. Parses value through the field's schema. Default scope is `home`. Re-validates the full merged value before writing; refuses on validation failure.
- `/config edit [--project]` — open the resolved harness file in `$EDITOR`. After close, re-read and re-validate; if validation fails, print errors and offer to reopen. Does not auto-rollback (the file on disk is the source of truth).

`/config edit` opens the **whole harness file**, not a single plugin's section — that's the inflection point that makes the redesign useful for inspecting/sharing whole harness configs.

## Validation

`schema.ts` exports `validate<T>(value, schema): { ok: true; value: T } | { ok: false; errors: ValidationError[] }`. Walks the shape: type check → constraint check (min/max/pattern/enum) → recurse into objects and arrays. Errors carry a JSON-path string (e.g., `retry.maxAttempts must be an integer >= 1`).

Validation runs:
- After every load (boot, watch fire) before memoization.
- Before every `set()` write.
- Before saving an edited file via `/config edit` reload.

A validation failure during boot logs to `ctx.log` and falls back to defaults for the failing plugin. It does not block the harness from booting.

## Env-var resolution

Generalizes the current `apiKeyEnv` pattern. The plugin's `register()` accepts `envVars: { apiKey: "OPENAI_API_KEY" }`. At resolve time, for each declared field, if `process.env[name]` is non-empty, that value replaces whatever the merged layers produced (parsed through the field's schema for non-string types).

This means a user can set `OPENAI_API_KEY=...` and never put the key in any config file. It also means env vars beat project files, which is the inverted-pyramid pattern most operators expect.

## Migration plan (in-repo, hard break)

Single change set, no compat shim, no read-old-paths fallback. Order of operations:

1. **Add contract + plugin.** `llm-contracts/contracts/config-store.ts` + `defineService`. New `plugins/llm-config/` with full implementation + tests + `kaizen plugin validate`.
2. **Add to harness manifest.** `harnesses/openai-compatible.json`: insert `official/llm-config@0.1.0` immediately after `llm-contracts`. `harnesses/claude-wrapper.json`: same if it has any configurable plugins (it currently does — `claude-driver`, etc.; verify and include as needed).
3. **Migrate each plugin.** One commit per plugin. Replace the plugin's `config.ts` (loader + validator) with a thin `register()` call at setup and `useService<ConfigStoreService>("config:store").get(...)` reads. Keep the plugin's `ConfigShape` type local; export from `public.d.ts` if any other plugin needs it (most don't). Remove `KAIZEN_<NAME>_CONFIG` env-var path overrides — superseded by the harness file. Update plugin tests to inject a fake `config:store` instead of fake fs deps.
   - Plugins to migrate (9): `openai-llm`, `llm-codemode`, `llm-memory`, `llm-mcp-bridge`, `llm-agents`, `llm-tavily-search`, `llm-tool-approval`, `llm-hooks-shell`, `llm-session-manager` (it consumes a synchronously-injected `ctx.config` today — see "Open question" below).
4. **Delete old config files.** On the developer's machine: `rm -rf ~/.kaizen/plugins/*/config.json`. Reconstruct the harness file from memory + defaults; the new `/config edit` makes this straightforward.
5. **Bump versions.** Every migrated plugin gets a minor bump (config surface is part of its public contract). Update `harnesses/*.json` to the new versions. Marketplace catalog updated.

No backwards-compatible read of old paths. The repo is the only consumer; we cut over deliberately.

## Non-contract public surface

`llm-config/public.d.ts` re-exports nothing from itself — the contract types are in `llm-contracts`. The plugin has no implementation-internal types that other plugins reference.

## Testing

Per-module unit tests with injected deps (same pattern as the rest of the repo):

- `store.test.ts` — register/get/set/watch lifecycle, merge precedence, deep-merge of one-level nested objects, array replacement, frozen return values.
- `paths.test.ts` — harness key derivation cases (ref, jsonPath, empty, sanitization).
- `schema.test.ts` — every `FieldSchema` variant, nested object validation, array bounds, error path strings.
- `envvars.test.ts` — string passthrough, number/boolean parsing, env wins over project, empty env ignored.
- `atomic-write.test.ts` — tmp+rename happens, mkdir on first write, concurrent writes don't corrupt.
- `slash.test.ts` — each command's parser and dispatcher, validation failure on set, edit roundtrip.

Per migrated plugin: replace existing `config.test.ts` with a fake `ConfigStoreService` that returns canned values. The plugin's behavior tests stay unchanged — they were already deps-injected.

## Open questions

1. **`llm-session-manager` migration.** Today it reads `ctx.config` directly (the kaizen runtime injects the per-plugin block synchronously into `setup()`). If we route through `config:store`, session-manager needs to consume the service. It currently has no `services.consumes` for config-store. The migration adds it. Risk: tighter boot-order coupling. Alternative: leave session-manager on `ctx.config` and live with the inconsistency. **Default: migrate; the consistency is worth the one extra dep edge.**

2. **`apiVersion` bump for plugins migrating.** Each plugin's `apiVersion` currently encodes its compat with kaizen, not its own surface. Migrating doesn't bump `apiVersion`; only the plugin `version` field bumps. Confirm during implementation.

3. **`/config set` value parsing.** For nested keys (`retry.maxAttempts=5`), `set` needs a small key-path parser. JSON-like for arrays/objects (`set llm-tool-approval allow='["Bash","Read"]'`) or restrict to scalars and require `/config edit` for collections. **Default: scalars + dotted paths only; collections go through `/config edit`.**

4. **Whether to lift `harnessKey` derivation into `llm-contracts`.** Violates the "zero runtime behavior" invariant. **Default: duplicate in `llm-config` and leave `llm-session-manager` alone.**
