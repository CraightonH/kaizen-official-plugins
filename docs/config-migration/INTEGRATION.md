# Integrating with `kaizen-config`

How a plugin routes its configuration through the harness `config:store`
service. This is the reference doc for every migration plan in this folder.

> **Authoritative sources:**
> - Contract: `plugins/llm-contracts/contracts/config-store.ts`
> - Implementation: `plugins/kaizen-config/{index,store,schema,envvars}.ts`
> - Example consumer (clean, current): `plugins/llm-axioms/{index.ts,config.ts}`
> - Example consumer (with secrets): `plugins/openai-llm`

## Why migrate

Today, many plugins read config from ad-hoc places:

- Direct `process.env.FOO` reads scattered through `index.ts`.
- Hardcoded constants (`const STALE_TEMP_MS = 60_000`) the user might want to tune.
- Per-plugin JSON files in `~/.kaizen/plugins/<plugin>/…`.
- Constructor args wired in `setup()` with no user-facing knob.

`config:store` is the canonical home. It gives the user one place to inspect
and edit (`~/.kaizen/harnesses/<key>/config.json` + project layer), validates
shapes, watches for live updates, and supports secret fields via the
`secrets:registry` indirection.

## What this migration does NOT do

- **Env-var wiring deferred, not dropped.** Direct `process.env` reads in
  plugins are being removed in favor of centralizing env support through the
  `envVars` mapping on `ConfigSpec`. That mapping is a first-class kaizen-config
  feature, but has two known implementation gaps (no try/catch around the env
  parser; no array/object parsing) that this migration intentionally defers.
  Concretely: **do not declare `envVars` on `ConfigSpec`** for now — leave
  fields file-only until the work in `docs/TODO.md` lands. After that, the
  former env reads can be re-added as `envVars` mappings.
- **No backward-compat shims** for old per-plugin config files. If a plugin
  previously read `~/.kaizen/plugins/<plugin>/config.json` or similar, delete
  the read path. The user is rebuilding from scratch with the new store.
- **No changes to `llm-contracts`.** If you believe the contract surface
  needs a new field type, validator, or method, append a short proposal to
  `docs/config-migration/CONTRACTS-PROPOSALS.md` — do not edit the contract.

## The contract surface

From `llm-contracts/public.ts` (re-exporting `contracts/config-store.ts`):

```ts
export type FieldSchema =
  | { type: "string"; min?: number; max?: number; pattern?: string; enum?: string[]; secret?: boolean }
  | { type: "number"; min?: number; max?: number; integer?: boolean }
  | { type: "boolean" }
  | { type: "array"; items: FieldSchema; min?: number; max?: number }
  | { type: "object"; properties: Record<string, FieldSchema>; additionalProperties?: boolean | FieldSchema }
  | { type: "enum"; values: readonly string[] };

export type ConfigSchema<T> = { [K in keyof T]?: FieldSchema };

export interface ConfigSpec<T> {
  plugin: string;
  defaults: T;
  schema?: ConfigSchema<T>;
  envVars?: Partial<Record<keyof T & string, string>>;   // DO NOT USE — see above
}

export interface ConfigStoreService {
  register<T>(spec: ConfigSpec<T>): void;
  get<T>(plugin: string): T;
  set<T>(plugin: string, value: Partial<T>, scope?: "home" | "project"): Promise<void>;
  watch<T>(plugin: string, cb: (next: T) => void): () => void;
  list(): ConfigStatus[];
  ready(): Promise<void>;
  unset(plugin: string, key: string, scope?: "home" | "project"): Promise<void>;
  getSpec(plugin: string): ConfigSpec<unknown> | undefined;
}
```

## Resolution order

`get()` returns the merged value, with each field taken from the
highest-priority layer that defined it:

1. `defaults` (your `ConfigSpec.defaults`)
2. home file (`~/.kaizen/harnesses/<harnessKey>/config.json`)
3. project file (`./.kaizen/harnesses/<harnessKey>/config.json`)
4. env-var override — **skip; see "What this migration does NOT do"**
5. secret-ref resolution (only after `await ready()`; see "Secret fields" below)

Object-typed fields are shallow-merged across layers; arrays and scalars
overwrite.

## The canonical plugin layout

Mirror what `llm-axioms` does. Two files of interest plus a `consumes` entry.

### `package.json` / plugin manifest

Add `"config:store"` to `services.consumes`. It is a topo-hint optional
dependency — `kaizen-config` boots early (right after `llm-contracts`) so the
service is virtually always available in the local harness, but the consume
must still be declared.

```jsonc
{
  "services": {
    "provides": ["<your-provided-services>"],
    "consumes": ["config:store", "...other services..."]
  }
}
```

### `config.ts`

A small, pure module: defaults + schema. No I/O, no `ctx`.

```ts
// plugins/<your-plugin>/config.ts
import type { FieldSchema } from "llm-contracts/public";
import type { YourConfig } from "./public.d.ts";

export const DEFAULT_CONFIG: YourConfig = Object.freeze({
  someDir: "~/.kaizen/plugins/your-plugin/data",
  byteCap: 4096,
  enabled: true,
  staleMs: 60_000,
}) as YourConfig;

// Plain Record over the config keys — compiles whether or not
// ConfigSchema<T> is generic in the contracts module.
export const CONFIG_SCHEMA: Record<keyof YourConfig, FieldSchema> = {
  someDir: { type: "string" },
  byteCap: { type: "number", min: 0, integer: true },
  enabled: { type: "boolean" },
  staleMs: { type: "number", min: 0, integer: true },
};
```

### `public.d.ts`

Declare the config type. Keep it plugin-private unless another plugin needs
it (it usually doesn't).

```ts
export interface YourConfig {
  someDir: string;
  byteCap: number;
  enabled: boolean;
  staleMs: number;
}
```

### `index.ts` — registration

Register early in `setup()`, before any code path that depends on the
configured values. Use `useService` (topo-hint optional pattern) and gracefully
fall back to `DEFAULT_CONFIG` if the service is genuinely missing — this keeps
plugin tests that use a fake `ctx` working without spinning up `config:store`.

```ts
import type { ConfigStoreService } from "llm-contracts/public";
import type { YourConfig } from "./public.d.ts";
import { DEFAULT_CONFIG, CONFIG_SCHEMA } from "./config.ts";

async setup(ctx) {
  const log = (m: string) => ctx.log?.(m);
  let config: YourConfig = { ...DEFAULT_CONFIG };

  const cfgSvc = ctx.useService<ConfigStoreService>("config:store");
  if (cfgSvc) {
    try {
      cfgSvc.register<YourConfig>({
        plugin: "<your-plugin-name>",
        defaults: { ...DEFAULT_CONFIG },
        schema: CONFIG_SCHEMA,
      });
      config = cfgSvc.get<YourConfig>("<your-plugin-name>");
    } catch (e) {
      log(`<your-plugin>: config:store register failed (${(e as Error).message}); using defaults`);
    }
  } else {
    log("<your-plugin>: config:store unavailable; using DEFAULT_CONFIG");
  }

  // ...rest of setup uses `config` directly...
}
```

Notes:

- `register()` is one-shot per plugin per harness boot. Calling it twice
  throws. The try/catch above guards against accidental double-registration
  (e.g., from a hot-reload during dev).
- Plugin name in `ConfigSpec.plugin` **must** match the manifest `name`.
  This is what the user sees as the section header in `config.json`.
- `defaults` is `Object.freeze`d in `config.ts`; spreading (`{ ...DEFAULT_CONFIG }`)
  is required when handing it to `register()` because the store may mutate
  the object it holds.

### Live updates: `watch()`

Use only when the plugin can meaningfully respond to live config changes
without a restart (e.g., toggling a feature flag, rotating a section
priority). If your plugin reads config once in `setup()` and never again,
**skip `watch()`** — adding it is dead weight.

```ts
const unsubscribe = cfgSvc.watch<YourConfig>("<your-plugin-name>", (next) => {
  config = next;
  // re-render section, swap feature flag, etc.
});
// teardown in plugin.stop(): unsubscribe();
```

The callback fires after on-disk values change (debounced ~150 ms). It does
**not** fire on the initial `register()`.

### Writes: `set()` / `unset()`

Most plugins never call these. They exist for plugins that expose slash
commands letting the user mutate config (`kaizen-config` itself, anything
with a `/config-style` UX). If you call `set()`, default scope is `"home"`;
pass `"project"` when the user is intentionally pinning a value to the
current project.

```ts
await cfgSvc.set<YourConfig>("<your-plugin-name>", { byteCap: 8192 });
await cfgSvc.unset("<your-plugin-name>", "byteCap"); // back to default
```

`set()` validates against the schema and **rejects** on validation failure.
By contrast, a validation failure on boot logs and falls back to defaults
(see `store.ts:259-268`).

## Secret fields

For credentials (API keys, tokens, etc.), declare the field as
`{ type: "string", secret: true }`. The store integrates with
`secrets:registry` so the actual value lives in a backend (keychain, etc.)
and only a `{ $ref: "scheme:opaque" }` pointer is persisted in
`config.json`.

```ts
export const CONFIG_SCHEMA: Record<keyof OpenAIConfig, FieldSchema> = {
  apiKey: { type: "string", secret: true, min: 1 },
  // ...
};
```

When the user calls `set()` for a secret field, the store automatically
stashes the plaintext in the configured secret backend and writes the
`$ref` to disk. When you call `get()`, after `await ready()`, you get the
resolved plaintext back. Before `ready()`, you may see the `$ref` pointer
itself — defer secret-dependent work until `await cfgSvc.ready()` resolves.

If your plugin has no secrets, ignore this section entirely.

## Validation semantics (what failure means)

- **On boot / on file change:** validation failure logs a single line
  (`kaizen-config: validation failed for '<plugin>': …`) and the cached
  value falls back to `defaults`. The plugin keeps booting; the user sees a
  log line but no crash.
- **On `set()`:** validation failure rejects the promise. Caller decides
  what to do.

Practical implication: schemas should be strict enough to catch obvious
typos (numbers vs. strings, enum values) but should not encode policy that
would silently revert user values to defaults on every boot.

## Permissions

`config:store` runs in `kaizen-config`'s permission boundary. Consumer
plugins do **not** need any new `fs.read` / `fs.write` permissions to use
it — the read/write of `~/.kaizen/harnesses/**` happens inside
`kaizen-config`. Don't add config-related fs permissions to your plugin
manifest.

If your plugin previously declared `fs.read`/`fs.write` paths *only* to
read its own config file, **remove those entries** during migration. If
those paths are also used for data (axioms storage, memory storage, skills
directories, etc.), leave them.

## Plugin name conventions

- `ConfigSpec.plugin` is the section key in `config.json`. Use the exact
  manifest `name` (e.g., `"llm-axioms"`, not `"axioms"` or `"LLM Axioms"`).
- The section appears verbatim in the user-facing `/config` slash commands
  exposed by `kaizen-config`, so it's a small UX detail too.

## Removing the legacy config code

When migrating, delete:

- Direct `process.env.<VAR>` reads for anything being migrated to a config
  field. Replace with `config.<field>`.
- Per-plugin config JSON readers (custom `readFileSync`/`JSON.parse` against
  `~/.kaizen/plugins/<plugin>/config.json` and friends). The new home is
  the shared harness config file.
- Hardcoded "make this tunable later" constants that the migration plan
  exposes as fields.
- Any `fs.read`/`fs.write` permissions in `package.json` that were only
  there for legacy config I/O.

If a plugin still wants per-user-customisable assets on disk that are *not*
config (e.g., `llm-axioms` stores axioms; `llm-memory` stores memories),
leave those — they aren't config and aren't migrating.

## Migration checklist for a single plugin

When writing a plan and executing it, the sub-agent should walk this list:

1. **Inventory.** What knobs does the plugin expose today?
   - `process.env.*` reads in `index.ts` and module files
   - Hardcoded constants the user can plausibly want to tune
   - Existing custom-config-file readers (if any)
   - Constructor args wired in `setup()` from non-defaults
2. **Design.** Group the knobs into a `<PluginName>Config` type.
   - Defaults that don't break current behavior
   - Schema (`FieldSchema`) for each field, strict but not policy-laden
3. **Implement.**
   - Add `config.ts` with `DEFAULT_CONFIG` + `CONFIG_SCHEMA`
   - Add config type to `public.d.ts` (plugin-private, unless cross-plugin needed)
   - Add `"config:store"` to `services.consumes` in `package.json`
   - Wire `register()` + `get()` in `setup()` per template above
   - Replace each legacy read site with `config.<field>`
   - Delete legacy env-var paths and config-file readers
   - Remove dead `fs.read`/`fs.write` permissions (legacy config only)
4. **Verify.**
   - `cd plugins/<plugin> && bun test` — all tests pass
   - `kaizen plugin validate plugins/<plugin>` — clean
5. **Document.**
   - If `index.ts` or `config.ts` patterns deviate from `llm-axioms`,
     note why in the plan file.
   - If you discover the contract surface is insufficient, append to
     `docs/config-migration/CONTRACTS-PROPOSALS.md` rather than editing
     `llm-contracts`.

## What the user will see after migration

After all migrations land, the user's harness config file looks something
like:

```jsonc
// ~/.kaizen/harnesses/<key>/config.json
{
  "plugins": {
    "llm-axioms": {
      "injectionByteCap": 8192
    },
    "openai-llm": {
      "model": "gpt-5",
      "apiKey": { "$ref": "keychain:openai-llm/apiKey" }
    },
    "llm-memory": {
      "memoryDir": "~/notes/kaizen-memory"
    }
  }
}
```

…and `/config` slash commands (from `kaizen-config`) let them inspect and
edit it without leaving the TUI.

## Pointers for sub-agents

- The repo-level `CLAUDE.md` and `docs/PLUGIN_ARCHITECTURE.md` describe the
  service/contract model. Read those first.
- Most plugins have a `CLAUDE.md` documenting their module map. Read it
  before editing.
- After code changes, run **only**: `bun test` + `kaizen plugin validate`.
  Do **not** run the local deploy recipe — the leader does that.
- Do **not** run any git commands. The leader handles all commits.
