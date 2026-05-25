# PLAN: `kaizen-secrets-keychain` → `config:store`

Tiny migration. The plugin has exactly one plausibly-tunable value
(`KEYCHAIN_SERVICE`); everything else is either contract surface (the
`keychain` scheme name), a hard platform requirement (`darwin`-only), or
internal `security`-CLI plumbing.

## Current state

- `plugins/kaizen-secrets-keychain/resolver.ts:4` — hardcoded
  `export const KEYCHAIN_SERVICE = "kaizen-secrets";`. Passed as the `-s`
  argument to every `security {find,add,delete}-generic-password` call
  (`resolver.ts:16,23,28`). User-visible: it's the `svce` field on every
  keychain entry created by the plugin, called out in `README.md:27-34`
  and `CLAUDE.md:14-16`.
- `plugins/kaizen-secrets-keychain/index.ts:8-16` — `realSpawn` is a thin
  wrapper around `node:child_process.spawn`. No tunables.
- `plugins/kaizen-secrets-keychain/index.ts:28-31` — `darwin` platform
  guard. Not a config knob; it's a capability requirement.
- `plugins/kaizen-secrets-keychain/resolver.ts:13` — `scheme: "keychain"`.
  Contract surface for `secrets:registry`; **excluded per audit brief**.
- No `process.env.*` reads.
- No custom-config-file readers.
- No `fs.read`/`fs.write` permissions in `package.json` (tier: `unscoped`).
- No legacy `~/.kaizen/plugins/kaizen-secrets-keychain/` directory.

## Proposed `KaizenSecretsKeychainConfig`

```ts
// plugins/kaizen-secrets-keychain/public.d.ts
export interface KaizenSecretsKeychainConfig {
  /**
   * macOS Keychain "service" (svce) attribute used for every entry this
   * plugin creates. Account names remain `<plugin>/<field>`. Changing
   * this orphans pre-existing entries — users must re-enter secrets or
   * migrate keychain items manually.
   */
  keychainService: string;
}
```

One field. Plugin-private — no other plugin needs to read it.

## Defaults and schema

```ts
// plugins/kaizen-secrets-keychain/config.ts
import type { FieldSchema } from "llm-contracts/public";
import type { KaizenSecretsKeychainConfig } from "./public.d.ts";

export const DEFAULT_CONFIG: KaizenSecretsKeychainConfig = Object.freeze({
  keychainService: "kaizen-secrets",
}) as KaizenSecretsKeychainConfig;

export const CONFIG_SCHEMA: Record<keyof KaizenSecretsKeychainConfig, FieldSchema> = {
  keychainService: { type: "string", min: 1, max: 255 },
};
```

Default preserves current behavior bit-for-bit. `min: 1` blocks empty
strings (`security` would error anyway); `max: 255` is a sanity cap well
above any realistic service name.

## Code changes

1. **New file `config.ts`** — `DEFAULT_CONFIG` + `CONFIG_SCHEMA` as
   above. Pure, no `ctx`.
2. **`public.d.ts`** — replace the placeholder `export {};` with the
   `KaizenSecretsKeychainConfig` interface above.
3. **`resolver.ts`** —
   - Drop `export const KEYCHAIN_SERVICE = "kaizen-secrets";`.
   - Change the factory signature to accept the service name:
     `createKeychainResolver(spawn: SpawnFn, keychainService: string): SecretsResolver`.
   - Replace the three `KEYCHAIN_SERVICE` references with the parameter.
   - Existing tests that import `KEYCHAIN_SERVICE` (see `index.test.ts`
     / `test/`) update to pass it explicitly or read it from
     `DEFAULT_CONFIG`.
4. **`index.ts`** —
   - Import `ConfigStoreService` from `llm-contracts/public` and
     `DEFAULT_CONFIG` / `CONFIG_SCHEMA` from `./config.ts`.
   - In `setup()`, **after** the `darwin` guard and **before** touching
     `secrets:registry`, run the `useService<ConfigStoreService>("config:store")`
     register/get dance from `INTEGRATION.md` lines 156-182, with plugin
     name `"kaizen-secrets-keychain"`.
   - Pass `config.keychainService` into `createKeychainResolver(realSpawn, config.keychainService)`.
   - No `watch()` — the resolver factory closes over the service name at
     registration time; live-updating it mid-session would silently
     orphan in-flight reads. Document this in a code comment ("config
     read once at setup; restart kaizen to pick up changes").
5. **Tests** — `index.test.ts` and `resolver.test.ts` get a minor
   touch-up to thread the service name through the factory. No new
   behavior to test beyond "default preserves `kaizen-secrets`".

## Manifest changes

`plugins/kaizen-secrets-keychain/package.json`:

- Add `"config:store"` to `services.consumes`. After change:
  ```jsonc
  "services": {
    "provides": [],
    "consumes": ["secrets:registry", "config:store"]
  }
  ```
  Wait — current `package.json` has no `services` block; the manifest
  lives in `index.ts` (`KaizenPlugin` object). So the change is actually
  to `index.ts:22-25`:
  ```ts
  services: {
    provides: [],
    consumes: ["secrets:registry", "config:store"],
  },
  ```
- No permissions changes. Plugin is `tier: "unscoped"` and has no
  config-only fs permissions to remove.

## Risks / open questions

- **Existing users on `"kaizen-secrets"`.** The default keeps the
  current value, so no behavior change for anyone on stock config. Users
  who *do* set a custom value orphan their pre-existing secrets — this
  is the same caveat already in `CLAUDE.md:14-16`, just now reachable
  via `/config`. Worth a one-line note in `README.md`'s Service constant
  section ("override via `/config`; old entries are not migrated").
- **`watch()` deliberately omitted.** See code-change note above. If a
  future use case wants live re-registration of the resolver under a new
  service name, that's a bigger refactor (unregister old, register new)
  and out of scope here.
- **`createKeychainResolver` signature change.** Public-ish (exported)
  but the package has no `exports` entry for `./resolver`, so consumers
  outside this plugin shouldn't be importing it. Safe to change.
- **Scheme name `"keychain"` left alone.** Confirmed per audit brief —
  it's `secrets:registry` contract surface, not plugin config.

## Contract proposals (only if needed)

None. The existing `FieldSchema` (`type: "string"`, `min`, `max`) covers
the single field cleanly. No additions to
`docs/config-migration/CONTRACTS-PROPOSALS.md` needed.
