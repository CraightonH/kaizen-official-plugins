# Design: `kaizen-config` secrets handling — pluggable registry with backend plugins

**Status:** Draft — pending implementation plan
**Date:** 2026-05-20

## Problem

`kaizen-config` stores plugin configuration as plaintext JSON in
`~/.kaizen/harnesses/<harnessKey>/config.json` (home scope) and
`./.kaizen/harnesses/<harnessKey>/config.json` (project scope). Secret values —
API keys, tokens, passwords — land in the same file as non-sensitive config.
The only escape hatch today is the documented "env vars beat all file layers"
behavior, which requires the user to manually set an environment variable
instead of using the `/config:set` slash command.

Two concrete consequences:

1. **Plaintext at rest.** A `cat` against the config file reveals every key the
   user has stored via the slash UI. After running `/config:set
   llm-tavily-search apiKey=tvly-...`, the file contains the literal value.
2. **Accidental git leakage.** The project-scope path is `./.kaizen/...` —
   one stray `git add .` away from a committed secret. The project directory
   is not gitignored by default, and there is no warn-on-write.

The threat model that matters most to the user is **(1) plaintext at rest**;
(2) accidental leakage is secondary but related. The design below solves (1)
decisively and largely defuses (2) as a side-effect, because file contents
under the new scheme are pointers, not values.

## Goals

- Mark individual schema fields as secret (`secret: true`), so the system
  knows which values to protect without relying on heuristics.
- Replace plaintext storage of secret-marked values with a pluggable
  resolver-based indirection: the file holds a `$ref` pointer; the value
  itself lives in a backend (OS keychain, vault, 1Password, env var, etc.).
- Ship a default backend plugin (`kaizen-secrets-keychain`, macOS-only in
  v0) so the out-of-box experience is "secrets just work" on the primary
  development platform.
- Keep the consumer-facing `ConfigStoreService` mostly source-compatible.
  `store.get()` stays synchronous; consumers that need secrets opt into a
  new `store.ready()` async barrier.
- Collapse all user-facing functionality into the existing `/config:*` slash
  namespace. Users do not have to know the word "secret" to use the system
  correctly.

## Non-goals

- Migrating existing plaintext values automatically. The next `/config:set`
  for a given field naturally moves it through the registry; no boot-time
  mutation, no warn-on-load, no migration command.
- Per-platform backends beyond macOS Keychain in v0. `kaizen-secrets-libsecret`
  (Linux), `kaizen-secrets-wincred` (Windows), and a cross-platform
  `kaizen-secrets-age` are obvious follow-ons but not required to land this.
- Interactive masked prompts for secret entry (e.g.,
  `/config:set <plugin> <key>` with no value, pop a hidden input). Worth
  doing eventually but requires extensions to `UiPromptService` in
  `llm-tui`; tracked as a follow-on.
- Audit logs of secret resolutions, per-scope backend selection, and
  separate `/config:secrets:*` slash commands. Intentionally rejected
  during brainstorming; see Alternatives.

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  llm-contracts/public.ts                                         │
│  ─────────────────────────                                       │
│  Adds:                                                           │
│  • FieldSchema.secret?: boolean   (string variant only)          │
│  • SecretRef            = { $ref: string }   // "scheme:key"     │
│  • SecretsResolver      = { scheme; get; set?; delete?; list? }  │
│  • SecretsRegistryService                                        │
│  Defines services:                                               │
│  • "secrets:registry"  (cardinality-one)                         │
└──────────────────────────────────────────────────────────────────┘
                              ▲
              provides ───────┤
                              │
┌──────────────────────────────────────────────────────────────────┐
│  kaizen-config  (existing plugin, expanded)                      │
│  ────────────────────────────────────────                        │
│  Provides: config:store, secrets:registry                        │
│  Consumes: slash:registry                                        │
│                                                                  │
│  New modules:                                                    │
│  • secrets/registry.ts    — route table; resolves $ref by scheme │
│  • secrets/env-resolver.ts — bundled "env:" resolver, always on  │
│  • secrets/redact.ts      — display redaction helpers            │
│                                                                  │
│  Modified modules:                                               │
│  • store.ts   — eager resolution at load; secret-aware set();    │
│                 new ready() barrier                              │
│  • schema.ts  — recognize FieldSchema.secret                     │
│  • slash.ts   — schema-aware /config:set, /config:get redaction; │
│                 new /config:unset; backends footer in            │
│                 /config:list                                     │
└──────────────────────────────────────────────────────────────────┘
                              ▲
              consumes ───────┤  (secrets:registry)
                              │
┌──────────────────────────────────────────────────────────────────┐
│  kaizen-secrets-keychain  (NEW plugin — macOS only in v0)        │
│  ──────────────────────────────────────────────────              │
│  Provides: nothing                                               │
│  Consumes: secrets:registry                                      │
│                                                                  │
│  In setup():                                                     │
│    • bail with a log line if process.platform !== "darwin"       │
│    • registry.register({ scheme: "keychain", get, set, delete })  │
│                                                                  │
│  Storage: macOS Keychain (login keychain by default)             │
│    • service: "kaizen-secrets"                                   │
│    • account: opaque-key from $ref (e.g. "llm-tavily/apiKey")    │
│    • value:   the secret                                         │
│                                                                  │
│  Implementation: shell out to `security` CLI via child_process.  │
│  No native deps. No `keytar`.                                    │
└──────────────────────────────────────────────────────────────────┘
```

### Why the registry lives in `kaizen-config` (and not its own plugin)

We considered a standalone `kaizen-secrets` plugin hosting the registry. The
chosen layout (registry inside `kaizen-config`, backends as separate plugins)
matches existing monorepo patterns — `slash:registry` is provided by a core
plugin and consumed by many; nobody installs a separate registry plugin. It
also collapses the common case to a single plugin install: users who already
have `kaizen-config` (everyone) get the registry, `env:` resolution, and
schema-aware redaction. Adding a backend ("how do I get encrypted-at-rest?")
is then exactly one plugin install — the backend itself — matching the user
intuition "adding secret functionality is adding this one plugin." The
trade-off is that a future non-config consumer of secrets would need to
depend on `kaizen-config`. No such consumer exists today; extracting the
registry into its own plugin later is mechanical (the contract surface is
unchanged) and we accept that future cost.

## Contract surface (`llm-contracts/public.ts`)

### Extend `FieldSchema`

Additive, non-breaking. Only the string variant carries `secret`:

```ts
export type FieldSchema =
  | { type: "string"; min?: number; max?: number; pattern?: string; enum?: string[]; secret?: boolean }
  | { type: "number"; min?: number; max?: number; integer?: boolean }
  | { type: "boolean" }
  | { type: "array"; items: FieldSchema; min?: number; max?: number }
  | { type: "object"; properties: Record<string, FieldSchema>; additionalProperties?: boolean | FieldSchema }
  | { type: "enum"; values: readonly string[] };
```

Numbers, booleans, and enums don't model credentials meaningfully, so they
don't carry the marker.

### New contract module — `contracts/secrets-registry.ts`

```ts
/** A pointer to a secret living in a backend. Shape on disk and in config values. */
export interface SecretRef { $ref: string }    // e.g. { $ref: "keychain:llm-tavily-search/apiKey" }

/** Runtime helper exported for consumers. */
export function isSecretRef(v: unknown): v is SecretRef {
  return typeof v === "object" && v !== null && typeof (v as { $ref?: unknown }).$ref === "string";
}

/** A backend plugin implements this and registers it with the registry. */
export interface SecretsResolver {
  /** URI scheme this resolver handles. Lowercase ASCII, no colons. */
  readonly scheme: string;
  /** If true, set/delete are rejected. `env:` is read-only; `keychain:` is not. */
  readonly readOnly?: boolean;

  get(key: string): Promise<string>;
  set?(key: string, value: string): Promise<void>;
  delete?(key: string): Promise<void>;
  /** Best-effort enumeration. Some backends can't list. */
  list?(): Promise<string[]>;
}

export interface SecretsRegistryService {
  /** Backend plugins call this in setup(). Returns unregister fn. */
  register(resolver: SecretsResolver): () => void;
  /** Resolve a $ref to its plaintext value. Throws if scheme unknown or key missing. */
  resolve(ref: SecretRef): Promise<string>;
  /** Store a value under a scheme; returns the canonical $ref to record on disk. */
  store(scheme: string, key: string, value: string): Promise<SecretRef>;
  /** Delete a stored secret by $ref. No-op if already absent. */
  delete(ref: SecretRef): Promise<void>;
  /** Which schemes are currently registered. */
  schemes(): string[];
  has(scheme: string): boolean;
}

export const CONTRACT_ID = "secrets:registry" as const;
export const DESCRIPTION =
  "Route table for secret resolvers. Backend plugins register by scheme; consumers resolve $ref pointers to plaintext values.";
```

### Re-exports

```ts
// public.ts
export type { SecretsRegistryService, SecretsResolver, SecretRef } from "./contracts/secrets-registry";
export { isSecretRef } from "./contracts/secrets-registry";
```

And `llm-contracts/index.ts` gains a `ctx.defineService("secrets:registry", { description })` line plus a corresponding test case.

### Explicitly not in the contract

- **No `getOrUndefined` / `tryResolve`.** `resolve` throws on missing; consumers wrap if they want a default.
- **No batched ops.** A single resolve per secret is fine.
- **No `redact` on the contract.** Display redaction is a kaizen-config concern, not a registry concern.
- **`ConfigStoreService.get` stays sync.** See lifecycle below.

## Store layering & resolution flow (`kaizen-config` internals)

### Lifecycle: snapshot → resolve → ready

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│ 1. Snapshot     │     │ 2. Resolve refs  │     │ 3. Ready        │
│                 │     │                  │     │                 │
│ Read JSON files,│     │ For each value   │     │ All refs in     │
│ apply env vars, │ ──▶ │ that is a Secret │ ──▶ │ snapshot are    │
│ build in-memory │     │ Ref AND schema   │     │ plaintext.      │
│ snapshot. Refs  │     │ marks secret,    │     │ get() returns   │
│ are SecretRef   │     │ await registry  │     │ usable values.  │
│ objects.        │     │ .resolve(ref).   │     │                 │
└─────────────────┘     └──────────────────┘     └─────────────────┘
       sync                    async                    sync
```

Phase 1 runs in `kaizen-config`'s `setup()` and is fully synchronous.
`get()` works immediately, returning `SecretRef` objects for unresolved
secret fields — preserving today's sync contract.

Phase 2 is triggered the first time either:
- a backend plugin calls `registry.register(resolver)`, OR
- a consumer calls `await store.ready()`
whichever comes first.

Phase 3 is observable via a new `store.ready(): Promise<void>` method.
Consumer plugins that need plaintext secrets do `await store.ready()` once
in their own `setup()` after calling `store.register(...)`. Consumers
without secrets ignore the method.

### `ConfigStoreService` shape (additive)

```ts
interface ConfigStoreService {
  register<T>(spec: ConfigSpec<T>): void;
  get<T>(plugin: string): T;
  set<T>(plugin: string, value: Partial<T>, scope?: ConfigScope): Promise<void>;
  watch<T>(plugin: string, cb: (next: T) => void): () => void;
  list(): ConfigStatus[];

  // NEW
  ready(): Promise<void>;
}
```

### Write path: `set()` on a secret-marked field

```
store.set("llm-tavily-search", { apiKey: "tvly-abc" }, "home")
                              │
                              ▼
       schema says apiKey.secret === true?
                              │
                       ┌──────┴──────┐
                      no             yes
                       │              │
                       ▼              ▼
              write plaintext      registry.store(
              to file as today        defaultScheme,
                                      "llm-tavily-search/apiKey",
                                      "tvly-abc"
                                    ) → SecretRef
                                      │
                                      ▼
                              write { $ref: "keychain:..." }
                              to config.json
                              (plaintext NEVER on disk)
                                      │
                                      ▼
                              update in-memory snapshot with plaintext
                              fire watch() callbacks
```

The plaintext passed to `set()` never touches the JSON file. It goes to the
backend via the registry; only the returned `$ref` lands on disk.

### Default-backend selection

`kaizen-config` registers a schema with its own store for the first time (it
doesn't today), giving the user a knob to set via the standard slash flow:

```ts
// kaizen-config registers this against itself in setup()
{ defaultSecretBackend?: string }   // e.g. "keychain"
```

Resolution rule when `set()` needs to pick a scheme:

1. If `defaultSecretBackend` is set, use that scheme; error if not registered.
2. Else if exactly one writable backend is registered, use it.
3. Else (zero, or multiple), error with a message listing registered schemes
   and pointing the user at
   `/config:set kaizen-config.defaultSecretBackend=<scheme>`.

`env:` is read-only and is excluded from auto-selection. Setting
`defaultSecretBackend=env` errors with the suggestion to export the variable
in the user's shell instead.

### Resolution precedence

Unchanged in spirit: `default → home → project → env`. Layers contain
either plaintext or `SecretRef`. The winning layer's value is what gets
resolved; lower layers are not consulted on resolution failure.

`ConfigStatus.resolution` gains scheme-named values:

```ts
resolution: Record<string, "default" | "home" | "project" | "env" | `secret:${string}`>
```

This makes `/config:list` debuggable — you can see at a glance whether
`apiKey` resolved from `secret:keychain`, `env`, or a plaintext `home`
layer.

### Caching & invalidation

- Plaintext lives in the in-memory snapshot only.
- `fs.watch` already triggers reload on file change; on reload, the
  snapshot is rebuilt including re-resolution of refs.
- No TTL, no periodic refresh. Backends are authoritative.

### Error matrix

| Failure | Behavior |
|---|---|
| `$ref` scheme not registered (backend plugin missing) | Snapshot keeps the `SecretRef`; `ready()` resolves anyway; consumer's `get()` returns the ref object. Logged once per scheme per boot. |
| Backend `get()` throws (locked keychain, missing entry) | Log with plugin + field + scheme; snapshot keeps the `SecretRef`; `ready()` still resolves. |
| Backend `set()` throws during `store.set()` | Reject the `set()` promise; do not write to file; do not update in-memory snapshot. |
| Schema marks `secret: true` and value being set is plaintext, but registry has zero non-env backends | Reject with: "no writable secrets backend registered. Install kaizen-secrets-keychain (or another backend) or set `<ENV_VAR>` in your shell." |

## Slash UX & redaction

The whole `/config:secrets:*` namespace is rejected. The existing `/config:*`
commands become schema-aware and route internally. Users never need to know
the word "secret."

### `/config:set <plugin> <key>=<value> [--project]`

- If schema marks `<key>` as `secret: true`: value goes through
  `secrets:registry`; file gets a `$ref`; backend gets plaintext.
- Else: today's behavior.
- Success output: `Updated llm-tavily-search.apiKey (home, secret:keychain).` —
  never echoes the value.

### `/config:get <plugin> [key.path] [--reveal]`

- Schema-aware redaction: any field with `secret: true` prints as
  `"<redacted:keychain>"` (scheme appended when value came from a `$ref`;
  bare `"<redacted>"` if plaintext on disk).
- `--reveal` prints plaintext. Single-shot; never persisted.
- Non-secret fields: today's behavior.

### `/config:list`

Per-plugin row gains a compact resolution column. Footer includes registered
backends, so users discover them without a separate command:

```
Plugins:
  llm-tavily-search  home=yes  project=no  [apiKey: secret:keychain, model: home]
  openai-llm         home=yes  project=no  [baseUrl: home]

Backends:
  env       (read-only, built-in)
  keychain  (default)

Harness: official_local
Home:    ~/.kaizen/harnesses/official_local/config.json
Project: ./.kaizen/harnesses/official_local/config.json
```

### `/config:edit [--project]`

Unchanged. Editing a `$ref` string by hand is a power-user escape hatch —
it lets you point a field at a different backend or env var without going
through `/config:set`.

### `/config:unset <plugin> <key> [--project]` (NEW)

- Symmetric to `/config:set`.
- For secret-marked fields whose removed value was a `$ref`: also calls
  `registry.delete(ref)` to clean up the backend entry.
- Soft-succeeds when the backend has already lost the entry.

### Redaction policy

Rule: **`secret: true` in schema ⇒ redact in display, regardless of storage form.**

A field marked secret is redacted in `/config:get` and `/config:list`
whether its value is currently a `$ref` or accidentally plaintext on disk.
Helper lives in `kaizen-config/secrets/redact.ts`, applied at the
slash-command boundary only. `store.get()` returns plaintext to consumer
plugins as today — they're trusted to not log it.

### No migration

Existing plaintext values in `secret: true` fields stay as-is on disk until
the user next runs `/config:set` for that field — at which point the new
write goes through the registry and the file gets a `$ref`. No boot-time
mutation, no warning log, no migration command.

## `kaizen-secrets-keychain` (new plugin)

- macOS-only in v0. On non-darwin platforms, `setup()` logs once and
  returns without registering.
- No native dependencies. Shells out to the `security` CLI via
  `child_process.spawn`.
- Service constant: `kaizen-secrets`. Account: the opaque-key portion of
  the `$ref`.

| Op | Command |
|---|---|
| `set(key, value)` | `security add-generic-password -U -s kaizen-secrets -a <key> -w <value>` |
| `get(key)` | `security find-generic-password -s kaizen-secrets -a <key> -w` |
| `delete(key)` | `security delete-generic-password -s kaizen-secrets -a <key>` |
| `list()` | `security dump-keychain` filtered to the `kaizen-secrets` service (best-effort) |

Exit-code handling:
- 44 (item not found) on `get` → typed `KeychainNotFoundError`.
- 51 (keychain locked) → typed `KeychainLockedError`.
- Other non-zero → generic error surfaced to caller.

First `find-generic-password` call may pop the macOS "Always Allow / Allow
/ Deny" dialog; after "Always Allow," subsequent calls are silent. This is
expected Keychain UX and is documented in the plugin README rather than
suppressed.

## Testing strategy

### `llm-contracts`

- One new case in `test/index.test.ts`: `secrets:registry` is defined at
  setup time. Matches the recipe in `llm-contracts/CLAUDE.md`.

### `kaizen-config`

Dep-injection pattern matches existing tests in `store.test.ts` and
`schema.test.ts`. Coverage:

- `secret: true` field with plaintext on disk → `get()` returns plaintext;
  `/config:get` redacts.
- `secret: true` field with `$ref` + matching backend → `ready()` resolves,
  `get()` returns plaintext.
- `secret: true` field with `$ref` + missing backend → `ready()` resolves,
  `get()` returns the `SecretRef` object, single log line emitted.
- `set()` on secret-marked field → file gets `$ref`, backend gets value,
  plaintext never written to disk (asserted via in-memory fake filesystem).
- `set()` with zero non-env backends → rejects with documented message.
- `set()` with multiple backends and no `defaultSecretBackend` → rejects
  with documented message listing schemes.
- `unset()` on secret field → calls `registry.delete(ref)`; soft-succeeds
  when backend lost the entry.
- `ConfigStatus.resolution` reports `secret:<scheme>` for resolved-via-ref
  fields.

Backend interactions are tested through an in-memory fake `SecretsRegistry`
injected via `StoreDeps`. No real keychain shell-out in `kaizen-config`
tests.

### `kaizen-secrets-keychain`

Tests inject a fake `spawn` (same pattern `slash.ts` uses for
`spawnEditor`). The resolver factory becomes pure:
`(spawn, scheme, key) => resolver`. Coverage:

- `set` invokes the expected `security add-generic-password` command.
- `get` invokes `find-generic-password -w` and returns stdout trimmed.
- `delete` invokes `delete-generic-password`.
- Exit code 44 on `get` → `KeychainNotFoundError`.
- Exit code 51 on any op → `KeychainLockedError`.
- `process.platform !== "darwin"` in `setup()` → resolver does not
  register; setup logs and returns cleanly.

A single integration test runs only when `process.platform === "darwin"`
and `KAIZEN_KEYCHAIN_INTEGRATION=1`, exercising add/find/delete against
the user's keychain in a `kaizen-test-<uuid>` service namespace. Opt-in
for local validation; not part of CI.

## Deployment

### Versioning

- `llm-contracts` — minor bump (additive `FieldSchema.secret`; new
  `secrets:registry` contract).
- `kaizen-config` — minor bump (consumes `secrets:registry` it provides
  itself; new `ready()` method; new commands).
- `kaizen-secrets-keychain` — new at `0.1.0`.

### Marketplace and harnesses

- New entry in `.kaizen/marketplace.json` for `kaizen-secrets-keychain`.
- `harnesses/local.json` and `harnesses/claude-wrapper.json` updated to
  include `kaizen-secrets-keychain` in their plugin list, after
  `kaizen-config`.

### Local deploy order

```
llm-contracts          → always first; contract surface
kaizen-config          → provides secrets:registry; consumes slash:registry
kaizen-secrets-keychain → consumes secrets:registry; registers "keychain"
```

Same `bun build → cp dist → rsync` recipe as elsewhere in the repo.
Re-run `kaizen plugin validate plugins/<each>` after.

## Alternatives considered

### Standalone `kaizen-secrets` plugin hosting the registry

Cleaner separation in principle — "secrets" is a distinct concern from
"structured config" and a future non-config consumer could depend on it.
Rejected because the common-case install becomes two plugins
(`kaizen-config` + `kaizen-secrets`) for what feels like one feature.
The chosen layout collapses to a single install for everyone and a
single additional plugin per backend. If a non-config consumer of
secrets emerges later, extracting the registry into its own plugin is
mechanical (contract surface is unchanged).

### Opt-out via heuristic name matching (`*apiKey*`, `*token*`, etc.)

Rejected. Heuristics produce both false positives and false negatives;
schema-based opt-in places the decision with the plugin author who knows
which field is sensitive.

### Per-write opt-in (`/config:set --secret`)

Rejected. Puts the security burden on the user at every keystroke. The
schema marker travels with the plugin and removes the chance of getting
it wrong.

### Encrypted file at rest (age/SOPS) as the default

Considered as the v0 backend. Rejected in favor of macOS Keychain
because: zero key management, OS-level encryption, no new CLI
dependency, no on-disk key material to lose. A cross-platform
`kaizen-secrets-age` plugin is an obvious follow-on for users without
Keychain.

### Auto-migration of existing plaintext on boot

Rejected. Silently mutating the user's config file on upgrade is
surprising. The next `/config:set` for a given field naturally moves
it through the registry; explicit user action is the right model.

### Separate `/config:secrets:*` slash namespace

Rejected during brainstorming. Schema-aware routing inside the existing
`/config:*` commands gives the same functionality with no new namespace
and no user education required.
