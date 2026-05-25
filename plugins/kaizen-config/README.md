# kaizen-config

Harness-scoped plugin configuration store for the local harness. Provides
the `config:store` and `secrets:registry` services. Peer plugins register
typed configuration fields and `kaizen-config` persists them per-harness
across a home layer and a project layer, with optional secret-field
indirection through a pluggable backend registry.

For the consumer-facing integration guide (how a peer plugin wires up its
own config), see `docs/config-migration/INTEGRATION.md`. That is the
authoritative reference; this README only documents the service surface
and storage layout that the guide builds on.

## Services

### `config:store`

Contract owned by `llm-contracts/public` (`ConfigStoreService`). Method
summary:

- `register<T>(spec: ConfigSpec<T>): void` — one-shot per plugin per
  harness boot. The `ConfigSpec` carries `plugin`, `defaults`, and an
  optional `schema: ConfigSchema<T>`. Calling twice for the same plugin
  name throws.
- `get<T>(plugin: string): T` — return the merged value for a plugin.
  Throws if the plugin is not registered.
- `set<T>(plugin: string, partial: Partial<T>, scope?: "home" | "project"): Promise<void>`
  — atomic write of `partial` into the chosen layer. Default scope is
  `"home"`. Validates against the schema and rejects on failure.
- `unset(plugin: string, key: string, scope?: "home" | "project"): Promise<void>`
  — remove a single key from a layer; also deletes the corresponding
  secret-backend entry if the value was a `$ref`.
- `watch<T>(plugin: string, cb: (v: T) => void): () => void` — fire
  whenever the merged value changes (debounced ~150 ms after on-disk
  edits). Does **not** fire on initial `register()`.
- `list(): ConfigStatus[]` — snapshot of every registered plugin with
  paths, layer existence flags, and per-field resolution (which layer
  each key came from).
- `ready(): Promise<void>` — await before reading secret-typed fields.
  At boot, secret fields are surfaced as `{ $ref: "scheme:opaque" }`
  pointers; `ready()` resolves once every backend-resolvable ref has
  been fetched and swapped for plaintext in the cached value. Cached
  per-call: subsequent calls reuse the same promise until the on-disk
  files change.
- `getSpec(plugin: string): ConfigSpec<unknown> | undefined` — used by
  the `/config:get` slash command to look up field schemas for
  redaction; rarely needed by other consumers.

### `secrets:registry`

Contract owned by `llm-contracts/public` (`SecretsRegistryService`).
Pluggable backend registry: each backend declares a `scheme` (e.g.
`"env"`, `"keychain"`, `"file"`) and the registry routes
`store`/`resolve`/`delete` to the matching backend. The built-in
`env:VAR_NAME` resolver is registered at boot and is read-only; it lets
plugins point a secret field at an environment variable without
`kaizen-config` ever persisting the plaintext.

## Self-registered fields

`kaizen-config` registers itself under the plugin name `"kaizen-config"`
with two optional fields (both omitted from defaults — they appear in
`/config:list` only after the user sets them):

| Field                  | Type     | Purpose                                                                                                                                 |
|------------------------|----------|-----------------------------------------------------------------------------------------------------------------------------------------|
| `defaultSecretBackend` | `string` | When a secret field is set and multiple writable backends are registered, `selectBackend` uses this scheme name. Optional when exactly one writable backend exists. |
| `editor`               | `string` | Command used by `/config:edit`. Falls back to `$EDITOR` then `vi`. Settable live via `/config:set kaizen-config editor=…`.              |

Set them like any other plugin field, e.g.
`/config:set kaizen-config editor=nvim`.

## Secret fields

Declare a field as `{ type: "string", secret: true }` and `set()` will
route the plaintext to a registered backend, persisting only a
`{ $ref: "scheme:opaque" }` pointer to disk. On read, `get()` returns
the `$ref` until `await store.ready()` resolves; after that,
secret-typed fields are surfaced as plaintext from the cached value.
Use `unset()` (or `set()` with a new value) to rotate; the previous
backend entry is deleted automatically.

See `docs/config-migration/INTEGRATION.md` § "Secret fields" for the
consumer-side patterns.

## Storage

Two JSON files per harness, identified by `harnessKey(harness)`:

| Path                                              | Layer                                  |
|---------------------------------------------------|----------------------------------------|
| `~/.kaizen/harnesses/<harnessKey>/config.json`    | Home (user-global)                     |
| `<cwd>/.kaizen/harnesses/<harnessKey>/config.json`| Project (project keys win over home)   |

Resolution order for a given field (`get()` returns the first hit going
top to bottom):

1. `defaults` from `ConfigSpec`.
2. Home file.
3. Project file (overrides home).
4. Env-var override (when the field declares `envVars: { fieldName: "ENV_NAME" }`).
5. Secret-ref resolution via `secrets:registry` after `ready()`.

Writes are atomic (tmp + rename). The plugin watches both files and
notifies subscribers on change with ~150 ms debounce. Env vars are
read once at `register()` time and again on each file-change recompute;
changing an env var mid-session has no effect until the next file
write or restart.

> **Status:** `envVars` mappings are a first-class feature, but the
> 2026-05 config migration deferred wiring them up across plugins while
> two implementation gaps are addressed (no try/catch around the env
> parser, no array/object parsing). See `docs/TODO.md`. For secrets
> supplied via environment, prefer the `env:` scheme on
> `secrets:registry` — it keeps the no-plaintext-on-disk invariant.

## Slash commands

Registered when `slash:registry` is available; silently disabled
otherwise (the service still works).

- `/config:list` — list registered plugins, per-field resolution layer,
  registered secret backends, and the active harness paths.
- `/config:get <plugin> [key.path] [--reveal]` — print the merged value.
  Secret fields are redacted unless `--reveal`.
- `/config:set <plugin> <key>=<value> [--project]` — atomic write to the
  home layer (default) or project layer.
- `/config:unset <plugin> <key> [--project]` — remove a key from a layer
  (back to defaults / lower layer).
- `/config:edit [--project]` — open the chosen layer's config file in
  the configured editor.

## Permissions

Scoped tier:
- `fs.read` / `fs.write`: `~/.kaizen/harnesses/**`, `./.kaizen/harnesses/**`.

The plugin uses `node:fs` and `node:child_process` directly (for
`fs.watch` and `spawn $EDITOR`). The runtime enforcer gates these by the
declared fs paths above.
