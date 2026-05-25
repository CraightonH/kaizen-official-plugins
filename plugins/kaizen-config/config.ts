// plugins/kaizen-config/config.ts
//
// Self-registered config for kaizen-config. Pure module: defaults + schema,
// no I/O, no `ctx`. Mirrors the canonical layout documented in
// `docs/config-migration/INTEGRATION.md` and exemplified by
// `plugins/llm-axioms/config.ts`.
import type { FieldSchema } from "llm-contracts/public";
import type { KaizenConfigConfig } from "./public.d.ts";

// Both fields are intentionally optional and intentionally omitted from
// `defaults`. The store's `mergeLayers`/`pickResolution` iterate only the
// keys present on `defaults`, so omitting them keeps the merged value
// `undefined` until the user sets one. Built-in fallbacks apply at the
// call site:
//   - `defaultSecretBackend` → consulted by `selectBackend`; absence is
//     handled there (single writable backend is picked automatically).
//   - `editor` → falls back to `process.env.EDITOR ?? "vi"` at use time.
export const DEFAULT_CONFIG: KaizenConfigConfig = Object.freeze({}) as KaizenConfigConfig;

// Plain Record over the config keys — compiles whether or not
// ConfigSchema<T> is generic in the contracts module.
export const CONFIG_SCHEMA: Record<keyof KaizenConfigConfig, FieldSchema> = {
  defaultSecretBackend: { type: "string", min: 1 },
  editor: { type: "string", min: 1 },
};
