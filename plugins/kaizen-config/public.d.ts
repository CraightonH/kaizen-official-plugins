// kaizen-config's cross-plugin contract surface (ConfigStoreService,
// SecretsRegistryService, ConfigSpec, FieldSchema, etc.) lives in
// llm-contracts/public — peers should import from there, not from this file.
//
// This file declares only the plugin-internal config shape consumed by
// `config:store.register()` in `index.ts`. It never crosses other plugin
// boundaries.

export interface KaizenConfigConfig {
  // Default secret backend scheme name (e.g. "keychain", "file") used by
  // `selectBackend` when a plugin sets a secret field and multiple writable
  // backends are available. When unset, `selectBackend` picks automatically
  // if exactly one writable backend is registered.
  defaultSecretBackend?: string;

  // Command used by `/config:edit` to open the harness config file. When
  // unset, falls back to `process.env.EDITOR ?? "vi"` at invocation time.
  editor?: string;
}
