# kaizen-config Secrets Handling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace plaintext secret storage in `kaizen-config` with a pluggable resolver-based indirection, and ship a macOS Keychain backend (`kaizen-secrets-keychain`) so encrypted-at-rest is the default on the primary dev platform.

**Architecture:** A new `secrets:registry` contract (cardinality-one) is provided by `kaizen-config`. Schema fields gain an opt-in `secret: true` marker. On disk, secret values become `{ $ref: "scheme:key" }` pointers; the registry routes by scheme to backend plugins. `env:` is bundled in `kaizen-config` as the always-available read-only resolver. The macOS keychain backend is a separate plugin that shells out to `security` and registers itself with the registry at setup.

**Tech Stack:** TypeScript, Bun workspace monorepo, Kaizen plugin runtime. Tests use `bun:test`. No new runtime dependencies — keychain backend uses `child_process.spawn`, env resolver reads `process.env`.

**Spec reference:** `docs/superpowers/specs/2026-05-20-kaizen-config-secrets-design.md`

---

## File structure

### `plugins/llm-contracts/` (modify)
- `contracts/config-store.ts` — add `secret?: boolean` to string `FieldSchema`; expand `ConfigStatus.resolution` value type.
- `contracts/secrets-registry.ts` (NEW) — `SecretRef`, `SecretsResolver`, `SecretsRegistryService`, `isSecretRef`, `CONTRACT_ID`, `DESCRIPTION`.
- `public.ts` — re-export new contract.
- `index.ts` — `ctx.defineService("secrets:registry", ...)`.
- `package.json` — minor version bump.

### `plugins/kaizen-config/` (modify + new modules)
- `secrets/registry.ts` (NEW) — pure registry implementation.
- `secrets/env-resolver.ts` (NEW) — built-in `env:` resolver factory.
- `secrets/redact.ts` (NEW) — display redaction helpers.
- `secrets/select-backend.ts` (NEW) — pure default-backend selection logic.
- `envvars.ts` — expand `ResolutionSource` type to include `` `secret:${string}` ``.
- `schema.ts` — accept `secret: true` on string fields (validator already tolerates extra fields; no real change required, verify with test).
- `store.ts` — recognize `SecretRef` values; `ready()` barrier; secret-aware `set()`; new `unset()`.
- `index.ts` — create + provide registry; self-register `kaizen-config` schema; pass registry into store; expose `unset` slash command wiring.
- `slash.ts` — `/config:get` redaction with `--reveal`; `/config:list` resolution column + backends footer; `/config:unset`.
- `test/secrets-registry.test.ts` (NEW)
- `test/secrets-env-resolver.test.ts` (NEW)
- `test/secrets-redact.test.ts` (NEW)
- `test/secrets-select-backend.test.ts` (NEW)
- `test/store.test.ts` — additional cases for refs, ready, set routing, unset.
- `test/slash.test.ts` — additional cases for redaction, backends footer, unset.
- `package.json` — minor version bump.

### `plugins/kaizen-secrets-keychain/` (NEW workspace)
- `package.json`
- `tsconfig.json`
- `CLAUDE.md`
- `README.md`
- `public.d.ts`
- `index.ts` — plugin shell; platform check; registers resolver with `secrets:registry`.
- `resolver.ts` — pure factory: `(spawn) => SecretsResolver` over the `security` CLI.
- `errors.ts` — `KeychainNotFoundError`, `KeychainLockedError`.
- `test/resolver.test.ts`
- `test/index.test.ts`

### Marketplace + harnesses (modify)
- `.kaizen/marketplace.json` — add `kaizen-secrets-keychain` entry; bump `llm-contracts` and `kaizen-config` version listings.
- `harnesses/local.json` — add `kaizen-secrets-keychain@0.1.0` after `kaizen-config`; bump versions of `llm-contracts` and `kaizen-config`.
- `harnesses/claude-wrapper.json` — same updates.
- `README.md` — one-line entry for `kaizen-secrets-keychain`.

---

## Phase 1: Contract foundation (`llm-contracts`)

### Task 1: Extend `FieldSchema` and `ConfigStatus` for secrets

**Files:**
- Modify: `plugins/llm-contracts/contracts/config-store.ts`

- [ ] **Step 1: Update the string variant of `FieldSchema` and the `ConfigStatus.resolution` value type**

Replace lines 5–15 and lines 26–33 of `plugins/llm-contracts/contracts/config-store.ts` so the file reads (full file shown):

```ts
// plugins/llm-contracts/contracts/config-store.ts

export type ConfigScope = "home" | "project";

export type FieldSchema =
  | { type: "string"; min?: number; max?: number; pattern?: string; enum?: string[]; secret?: boolean }
  | { type: "number"; min?: number; max?: number; integer?: boolean }
  | { type: "boolean" }
  | { type: "array"; items: FieldSchema; min?: number; max?: number }
  | {
      type: "object";
      properties: Record<string, FieldSchema>;
      additionalProperties?: boolean | FieldSchema;
    }
  | { type: "enum"; values: readonly string[] };

export type ConfigSchema<T> = { [K in keyof T]?: FieldSchema };

export interface ConfigSpec<T> {
  plugin: string;
  defaults: T;
  schema?: ConfigSchema<T>;
  envVars?: Partial<Record<keyof T & string, string>>;
}

export type ConfigResolutionSource =
  | "default"
  | "home"
  | "project"
  | "env"
  | `secret:${string}`;

export interface ConfigStatus {
  plugin: string;
  homePath: string;
  projectPath: string;
  homeExists: boolean;
  projectExists: boolean;
  resolution: Record<string, ConfigResolutionSource>;
}

export interface ConfigStoreService {
  register<T>(spec: ConfigSpec<T>): void;
  get<T>(plugin: string): T;
  set<T>(plugin: string, value: Partial<T>, scope?: ConfigScope): Promise<void>;
  watch<T>(plugin: string, cb: (next: T) => void): () => void;
  list(): ConfigStatus[];
  // `ready()` is added to this interface in Task 8.
  // `unset()` is added in Task 10.
  // `getSpec()` is added in Task 12.
}

export const CONTRACT_ID = "config:store" as const;
export const DESCRIPTION =
  "Harness-scoped plugin configuration store. Plugins register schema/defaults; service resolves defaults → home → project → env and exposes get/set/watch.";
```

- [ ] **Step 2: Re-export `ConfigResolutionSource` from `public.ts`**

In `plugins/llm-contracts/public.ts`, update the config-store re-export block (the one that lists `ConfigStoreService`, etc.) to add `ConfigResolutionSource`:

```ts
export type {
  ConfigStoreService,
  ConfigSpec,
  ConfigSchema,
  ConfigScope,
  ConfigStatus,
  ConfigResolutionSource,
  FieldSchema,
} from "./contracts/config-store";
```

- [ ] **Step 3: Verify the workspace still type-checks**

Run: `cd plugins/llm-contracts && bun run tsc --noEmit 2>&1 | head -40`
Expected: no errors. (No file currently imports `ConfigResolutionSource`; the new exports are additive.)

- [ ] **Step 4: Commit**

```bash
git add plugins/llm-contracts/contracts/config-store.ts plugins/llm-contracts/public.ts
git commit -m "llm-contracts: add FieldSchema.secret and ConfigResolutionSource"
```

---

### Task 2: Add `secrets:registry` contract

**Files:**
- Create: `plugins/llm-contracts/contracts/secrets-registry.ts`
- Modify: `plugins/llm-contracts/public.ts`
- Modify: `plugins/llm-contracts/index.ts`

- [ ] **Step 1: Create the contract module**

Write `plugins/llm-contracts/contracts/secrets-registry.ts`:

```ts
// plugins/llm-contracts/contracts/secrets-registry.ts

/** A pointer to a secret living in a backend. On-disk and in-memory sentinel. */
export interface SecretRef {
  $ref: string;   // e.g. "keychain:llm-tavily-search/apiKey"
}

/** Runtime helper. Exported as a value so consumers don't reimplement it. */
export function isSecretRef(v: unknown): v is SecretRef {
  return typeof v === "object"
    && v !== null
    && !Array.isArray(v)
    && typeof (v as { $ref?: unknown }).$ref === "string";
}

/** Implemented by backend plugins and registered with the registry. */
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
  /** Resolve a $ref to its plaintext. Throws on unknown scheme or missing key. */
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

- [ ] **Step 2: Re-export from `public.ts`**

Add to `plugins/llm-contracts/public.ts` (after the config-store block from Task 1):

```ts
export type {
  SecretsRegistryService,
  SecretsResolver,
  SecretRef,
} from "./contracts/secrets-registry";
export { isSecretRef } from "./contracts/secrets-registry";
```

- [ ] **Step 3: Add `defineService` call in `index.ts`**

In `plugins/llm-contracts/index.ts`:

1. Add the import at the top of the imports block:

```ts
import * as secretsRegistryContract from "./contracts/secrets-registry";
```

2. Add inside `setup(ctx)`, alongside the other `defineService` calls (place after `axiomsRegistryContract`):

```ts
    ctx.defineService(secretsRegistryContract.CONTRACT_ID, { description: secretsRegistryContract.DESCRIPTION });
```

- [ ] **Step 4: Verify type-check passes**

Run: `cd plugins/llm-contracts && bun run tsc --noEmit 2>&1 | head -20`
Expected: no errors.

- [ ] **Step 5: Bump version**

Edit `plugins/llm-contracts/package.json`, change `"version": "0.3.0"` to `"version": "0.4.0"`.

- [ ] **Step 6: Commit**

```bash
git add plugins/llm-contracts/contracts/secrets-registry.ts plugins/llm-contracts/public.ts plugins/llm-contracts/index.ts plugins/llm-contracts/package.json
git commit -m "llm-contracts: add secrets:registry contract"
```

---

## Phase 2: kaizen-config — pure secret modules

### Task 3: Implement `secrets/env-resolver.ts`

**Files:**
- Create: `plugins/kaizen-config/test/secrets-env-resolver.test.ts`
- Create: `plugins/kaizen-config/secrets/env-resolver.ts`

- [ ] **Step 1: Write the failing tests**

Create `plugins/kaizen-config/test/secrets-env-resolver.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { createEnvResolver } from "../secrets/env-resolver.ts";

describe("env-resolver", () => {
  it("declares scheme=env and is readOnly", () => {
    const r = createEnvResolver({});
    expect(r.scheme).toBe("env");
    expect(r.readOnly).toBe(true);
  });

  it("returns the env var value for get()", async () => {
    const r = createEnvResolver({ MY_KEY: "hello" });
    expect(await r.get("MY_KEY")).toBe("hello");
  });

  it("throws a clear error when the env var is unset", async () => {
    const r = createEnvResolver({});
    expect(r.get("MISSING")).rejects.toThrow(/env:MISSING/);
  });

  it("throws on set()", async () => {
    const r = createEnvResolver({});
    expect(r.set?.("X", "y")).rejects.toThrow(/read-only/);
  });

  it("throws on delete()", async () => {
    const r = createEnvResolver({});
    expect(r.delete?.("X")).rejects.toThrow(/read-only/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd plugins/kaizen-config && bun test test/secrets-env-resolver.test.ts 2>&1 | tail -20`
Expected: FAIL — `createEnvResolver` not found.

- [ ] **Step 3: Implement the env resolver**

Create `plugins/kaizen-config/secrets/env-resolver.ts`:

```ts
// plugins/kaizen-config/secrets/env-resolver.ts
import type { SecretsResolver } from "llm-contracts/public";

/** Pure factory. Inject process.env (or any record) for test isolation. */
export function createEnvResolver(env: Record<string, string | undefined>): SecretsResolver {
  return {
    scheme: "env",
    readOnly: true,
    async get(key: string): Promise<string> {
      const v = env[key];
      if (v === undefined || v === "") {
        throw new Error(`env:${key} is not set`);
      }
      return v;
    },
    async set(_key: string, _value: string): Promise<void> {
      throw new Error("env: scheme is read-only; export the variable in your shell instead");
    },
    async delete(_key: string): Promise<void> {
      throw new Error("env: scheme is read-only; unset the variable in your shell instead");
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd plugins/kaizen-config && bun test test/secrets-env-resolver.test.ts 2>&1 | tail -20`
Expected: 5 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add plugins/kaizen-config/secrets/env-resolver.ts plugins/kaizen-config/test/secrets-env-resolver.test.ts
git commit -m "kaizen-config: env: secret resolver"
```

---

### Task 4: Implement `secrets/registry.ts`

**Files:**
- Create: `plugins/kaizen-config/test/secrets-registry.test.ts`
- Create: `plugins/kaizen-config/secrets/registry.ts`

- [ ] **Step 1: Write the failing tests**

Create `plugins/kaizen-config/test/secrets-registry.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { createRegistry } from "../secrets/registry.ts";
import type { SecretsResolver } from "llm-contracts/public";

function fakeResolver(over: Partial<SecretsResolver> & { scheme: string }): SecretsResolver {
  const data = new Map<string, string>();
  return {
    scheme: over.scheme,
    readOnly: over.readOnly,
    get: over.get ?? (async (k) => {
      const v = data.get(k);
      if (v === undefined) throw new Error(`${over.scheme}:${k} not found`);
      return v;
    }),
    set: over.set ?? (async (k, v) => { data.set(k, v); }),
    delete: over.delete ?? (async (k) => { data.delete(k); }),
    list: over.list,
  };
}

describe("registry", () => {
  it("starts empty", () => {
    const r = createRegistry();
    expect(r.schemes()).toEqual([]);
    expect(r.has("env")).toBe(false);
  });

  it("register adds a scheme; unregister fn removes it", () => {
    const r = createRegistry();
    const off = r.register(fakeResolver({ scheme: "foo" }));
    expect(r.schemes()).toEqual(["foo"]);
    expect(r.has("foo")).toBe(true);
    off();
    expect(r.schemes()).toEqual([]);
    expect(r.has("foo")).toBe(false);
  });

  it("register throws on duplicate scheme", () => {
    const r = createRegistry();
    r.register(fakeResolver({ scheme: "foo" }));
    expect(() => r.register(fakeResolver({ scheme: "foo" }))).toThrow(/already registered/);
  });

  it("resolve returns the backend value", async () => {
    const r = createRegistry();
    const f = fakeResolver({ scheme: "foo" });
    await f.set!("k1", "value-1");
    r.register(f);
    expect(await r.resolve({ $ref: "foo:k1" })).toBe("value-1");
  });

  it("resolve throws on unknown scheme", async () => {
    const r = createRegistry();
    expect(r.resolve({ $ref: "nope:k" })).rejects.toThrow(/no resolver registered for scheme 'nope'/);
  });

  it("resolve throws on malformed ref (no colon)", async () => {
    const r = createRegistry();
    expect(r.resolve({ $ref: "malformed" })).rejects.toThrow(/malformed \$ref/);
  });

  it("store writes through and returns the canonical ref", async () => {
    const r = createRegistry();
    const f = fakeResolver({ scheme: "foo" });
    r.register(f);
    const ref = await r.store("foo", "plug/api", "secret-value");
    expect(ref).toEqual({ $ref: "foo:plug/api" });
    expect(await r.resolve(ref)).toBe("secret-value");
  });

  it("store throws on unknown scheme", async () => {
    const r = createRegistry();
    expect(r.store("nope", "k", "v")).rejects.toThrow(/no resolver registered/);
  });

  it("store throws on read-only scheme", async () => {
    const r = createRegistry();
    r.register(fakeResolver({ scheme: "env", readOnly: true }));
    expect(r.store("env", "k", "v")).rejects.toThrow(/read-only/);
  });

  it("delete invokes backend delete and is a no-op if missing", async () => {
    const r = createRegistry();
    const f = fakeResolver({ scheme: "foo" });
    await f.set!("k1", "v1");
    r.register(f);
    await r.delete({ $ref: "foo:k1" });
    expect(f.get("k1")).rejects.toThrow();
    // No throw on already-gone:
    await r.delete({ $ref: "foo:k1" });
  });

  it("delete throws on read-only scheme", async () => {
    const r = createRegistry();
    r.register(fakeResolver({ scheme: "env", readOnly: true }));
    expect(r.delete({ $ref: "env:k" })).rejects.toThrow(/read-only/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd plugins/kaizen-config && bun test test/secrets-registry.test.ts 2>&1 | tail -20`
Expected: FAIL — `createRegistry` not found.

- [ ] **Step 3: Implement the registry**

Create `plugins/kaizen-config/secrets/registry.ts`:

```ts
// plugins/kaizen-config/secrets/registry.ts
import type { SecretRef, SecretsRegistryService, SecretsResolver } from "llm-contracts/public";

export function createRegistry(): SecretsRegistryService {
  const resolvers = new Map<string, SecretsResolver>();

  const parseRef = (ref: SecretRef): { scheme: string; key: string } => {
    const idx = ref.$ref.indexOf(":");
    if (idx <= 0) throw new Error(`malformed $ref: '${ref.$ref}' (expected 'scheme:key')`);
    return { scheme: ref.$ref.slice(0, idx), key: ref.$ref.slice(idx + 1) };
  };

  return {
    register(resolver) {
      if (resolvers.has(resolver.scheme)) {
        throw new Error(`secrets:registry: scheme '${resolver.scheme}' already registered`);
      }
      resolvers.set(resolver.scheme, resolver);
      return () => { resolvers.delete(resolver.scheme); };
    },
    async resolve(ref) {
      const { scheme, key } = parseRef(ref);
      const r = resolvers.get(scheme);
      if (!r) throw new Error(`secrets:registry: no resolver registered for scheme '${scheme}'`);
      return r.get(key);
    },
    async store(scheme, key, value) {
      const r = resolvers.get(scheme);
      if (!r) throw new Error(`secrets:registry: no resolver registered for scheme '${scheme}'`);
      if (r.readOnly || !r.set) throw new Error(`secrets:registry: scheme '${scheme}' is read-only`);
      await r.set(key, value);
      return { $ref: `${scheme}:${key}` };
    },
    async delete(ref) {
      const { scheme, key } = parseRef(ref);
      const r = resolvers.get(scheme);
      if (!r) return;   // unknown scheme: nothing to clean up
      if (r.readOnly || !r.delete) throw new Error(`secrets:registry: scheme '${scheme}' is read-only`);
      try { await r.delete(key); }
      catch { /* already gone — soft success */ }
    },
    schemes() {
      return [...resolvers.keys()];
    },
    has(scheme) {
      return resolvers.has(scheme);
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd plugins/kaizen-config && bun test test/secrets-registry.test.ts 2>&1 | tail -20`
Expected: 11 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add plugins/kaizen-config/secrets/registry.ts plugins/kaizen-config/test/secrets-registry.test.ts
git commit -m "kaizen-config: secrets registry route table"
```

---

### Task 5: Implement `secrets/redact.ts`

**Files:**
- Create: `plugins/kaizen-config/test/secrets-redact.test.ts`
- Create: `plugins/kaizen-config/secrets/redact.ts`

- [ ] **Step 1: Write the failing tests**

Create `plugins/kaizen-config/test/secrets-redact.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { redactValue, redactSnapshot } from "../secrets/redact.ts";
import type { ConfigSchema } from "llm-contracts/public";

describe("redactValue", () => {
  it("returns value unchanged when field schema is absent", () => {
    expect(redactValue("plaintext", undefined)).toBe("plaintext");
  });

  it("returns value unchanged when field schema is not a secret", () => {
    expect(redactValue("plaintext", { type: "string" })).toBe("plaintext");
  });

  it("returns <redacted> for plaintext secret value", () => {
    expect(redactValue("tvly-abc", { type: "string", secret: true })).toBe("<redacted>");
  });

  it("returns <redacted:scheme> for SecretRef secret value", () => {
    expect(redactValue({ $ref: "keychain:plug/api" }, { type: "string", secret: true }))
      .toBe("<redacted:keychain>");
  });

  it("returns <redacted> for non-string value on secret field (defensive)", () => {
    expect(redactValue(123, { type: "string", secret: true })).toBe("<redacted>");
  });
});

describe("redactSnapshot", () => {
  it("redacts only secret-marked fields, leaving others intact", () => {
    const schema: ConfigSchema<{ apiKey: string; model: string }> = {
      apiKey: { type: "string", secret: true },
      model: { type: "string" },
    };
    const snap = { apiKey: "tvly-abc", model: "gpt-4" };
    expect(redactSnapshot(snap, schema)).toEqual({
      apiKey: "<redacted>",
      model: "gpt-4",
    });
  });

  it("handles SecretRef in snapshot", () => {
    const schema: ConfigSchema<{ apiKey: string }> = {
      apiKey: { type: "string", secret: true },
    };
    const snap = { apiKey: { $ref: "keychain:plug/api" } };
    expect(redactSnapshot(snap as unknown as { apiKey: string }, schema)).toEqual({
      apiKey: "<redacted:keychain>",
    });
  });

  it("returns snapshot unchanged when schema is undefined", () => {
    const snap = { apiKey: "tvly-abc" };
    expect(redactSnapshot(snap, undefined)).toEqual(snap);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd plugins/kaizen-config && bun test test/secrets-redact.test.ts 2>&1 | tail -20`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the redact module**

Create `plugins/kaizen-config/secrets/redact.ts`:

```ts
// plugins/kaizen-config/secrets/redact.ts
import { isSecretRef, type ConfigSchema, type FieldSchema } from "llm-contracts/public";

export function redactValue(value: unknown, fieldSchema: FieldSchema | undefined): unknown {
  if (!fieldSchema || fieldSchema.type !== "string" || !fieldSchema.secret) return value;
  if (isSecretRef(value)) {
    const idx = value.$ref.indexOf(":");
    const scheme = idx > 0 ? value.$ref.slice(0, idx) : "unknown";
    return `<redacted:${scheme}>`;
  }
  return "<redacted>";
}

export function redactSnapshot<T>(snapshot: T, schema: ConfigSchema<T> | undefined): T {
  if (!schema || typeof snapshot !== "object" || snapshot === null) return snapshot;
  const out: Record<string, unknown> = { ...(snapshot as Record<string, unknown>) };
  for (const [key, fieldSchema] of Object.entries(schema)) {
    if (!fieldSchema) continue;
    if (!(key in out)) continue;
    out[key] = redactValue(out[key], fieldSchema as FieldSchema);
  }
  return out as T;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd plugins/kaizen-config && bun test test/secrets-redact.test.ts 2>&1 | tail -20`
Expected: 8 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add plugins/kaizen-config/secrets/redact.ts plugins/kaizen-config/test/secrets-redact.test.ts
git commit -m "kaizen-config: secret redaction helpers"
```

---

### Task 6: Implement `secrets/select-backend.ts`

**Files:**
- Create: `plugins/kaizen-config/test/secrets-select-backend.test.ts`
- Create: `plugins/kaizen-config/secrets/select-backend.ts`

- [ ] **Step 1: Write the failing tests**

Create `plugins/kaizen-config/test/secrets-select-backend.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { selectBackend } from "../secrets/select-backend.ts";

describe("selectBackend", () => {
  it("returns the configured default when set and registered", () => {
    expect(selectBackend({ configured: "keychain", available: ["env", "keychain"], readOnly: ["env"] }))
      .toEqual({ ok: true, scheme: "keychain" });
  });

  it("rejects when configured default is not registered", () => {
    const r = selectBackend({ configured: "vault", available: ["env", "keychain"], readOnly: ["env"] });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/defaultSecretBackend='vault'.*not registered/);
  });

  it("rejects when configured default is read-only", () => {
    const r = selectBackend({ configured: "env", available: ["env"], readOnly: ["env"] });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/env: scheme is read-only/);
  });

  it("auto-selects the sole writable backend", () => {
    expect(selectBackend({ configured: undefined, available: ["env", "keychain"], readOnly: ["env"] }))
      .toEqual({ ok: true, scheme: "keychain" });
  });

  it("rejects when no writable backends are registered", () => {
    const r = selectBackend({ configured: undefined, available: ["env"], readOnly: ["env"] });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no writable secrets backend registered/);
  });

  it("rejects when multiple writable backends and no default", () => {
    const r = selectBackend({ configured: undefined, available: ["keychain", "vault"], readOnly: [] });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/multiple writable backends.*keychain, vault/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd plugins/kaizen-config && bun test test/secrets-select-backend.test.ts 2>&1 | tail -20`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the selector**

Create `plugins/kaizen-config/secrets/select-backend.ts`:

```ts
// plugins/kaizen-config/secrets/select-backend.ts

export interface SelectBackendInput {
  configured: string | undefined;          // value of kaizen-config.defaultSecretBackend
  available: string[];                     // registered schemes
  readOnly: string[];                      // schemes marked read-only
}

export type SelectBackendResult =
  | { ok: true; scheme: string }
  | { ok: false; error: string };

export function selectBackend(input: SelectBackendInput): SelectBackendResult {
  const ro = new Set(input.readOnly);
  const writable = input.available.filter((s) => !ro.has(s));

  if (input.configured) {
    if (!input.available.includes(input.configured)) {
      return { ok: false, error: `defaultSecretBackend='${input.configured}' but no resolver of that scheme is registered (available: ${input.available.join(", ") || "<none>"})` };
    }
    if (ro.has(input.configured)) {
      return { ok: false, error: `${input.configured}: scheme is read-only; export the variable in your shell instead, or pick a writable backend` };
    }
    return { ok: true, scheme: input.configured };
  }

  if (writable.length === 1) {
    return { ok: true, scheme: writable[0]! };
  }

  if (writable.length === 0) {
    return { ok: false, error: "no writable secrets backend registered. Install kaizen-secrets-keychain (or another backend) or set the env var in your shell." };
  }

  return { ok: false, error: `multiple writable backends registered (${writable.join(", ")}); set /config:set kaizen-config defaultSecretBackend=<scheme>` };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd plugins/kaizen-config && bun test test/secrets-select-backend.test.ts 2>&1 | tail -20`
Expected: 6 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add plugins/kaizen-config/secrets/select-backend.ts plugins/kaizen-config/test/secrets-select-backend.test.ts
git commit -m "kaizen-config: default-backend selection logic"
```

---

## Phase 3: kaizen-config — store integration

### Task 7: Expand `ResolutionSource` and recognize `SecretRef` on load

**Files:**
- Modify: `plugins/kaizen-config/envvars.ts`
- Modify: `plugins/kaizen-config/store.ts`
- Modify: `plugins/kaizen-config/test/store.test.ts`

- [ ] **Step 1: Widen `ResolutionSource` in `envvars.ts`**

Edit `plugins/kaizen-config/envvars.ts` line 4. Replace:

```ts
export type ResolutionSource = "default" | "home" | "project" | "env";
```

with:

```ts
export type ResolutionSource = "default" | "home" | "project" | "env" | `secret:${string}`;
```

- [ ] **Step 2: Write the failing test**

Append to `plugins/kaizen-config/test/store.test.ts` (inside the file, after the existing `describe` blocks):

```ts
describe("store — secret refs on load", () => {
  it("returns the SecretRef sentinel when value is a $ref and no backend resolves", () => {
    const { deps, fs } = makeDeps();
    fs.files.set(deps.homePath, JSON.stringify({
      plugins: { x: { apiKey: { $ref: "keychain:x/apiKey" } } },
    }));
    const store = createStore(deps);
    store.register({
      plugin: "x",
      defaults: { apiKey: "" },
      schema: { apiKey: { type: "string", secret: true } },
    });
    const v = store.get<{ apiKey: string | { $ref: string } }>("x");
    expect(v.apiKey).toEqual({ $ref: "keychain:x/apiKey" });
  });

  it("reports secret:<scheme> resolution for ref-valued fields", () => {
    const { deps, fs } = makeDeps();
    fs.files.set(deps.homePath, JSON.stringify({
      plugins: { x: { apiKey: { $ref: "keychain:x/apiKey" } } },
    }));
    const store = createStore(deps);
    store.register({
      plugin: "x",
      defaults: { apiKey: "" },
      schema: { apiKey: { type: "string", secret: true } },
    });
    const status = store.list().find((s) => s.plugin === "x")!;
    expect(status.resolution.apiKey).toBe("secret:keychain");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd plugins/kaizen-config && bun test test/store.test.ts 2>&1 | tail -30`
Expected: FAIL — the new cases fail because the `resolve` function doesn't yet detect `SecretRef`s and doesn't tag resolution with `secret:<scheme>`.

(Existing tests should still pass.)

- [ ] **Step 4: Add `SecretRef` recognition to `resolve()`**

In `plugins/kaizen-config/store.ts`:

1. Add import (after the existing imports near the top):

```ts
import { isSecretRef } from "llm-contracts/public";
```

2. After the `pickResolution` function (around line 210), add:

```ts
function tagSecretResolution(
  merged: Record<string, unknown>,
  resolution: Record<string, ResolutionSource>,
): Record<string, ResolutionSource> {
  const out: Record<string, ResolutionSource> = { ...resolution };
  for (const [k, v] of Object.entries(merged)) {
    if (!isSecretRef(v)) continue;
    const idx = v.$ref.indexOf(":");
    const scheme = idx > 0 ? v.$ref.slice(0, idx) : "unknown";
    out[k] = `secret:${scheme}` as ResolutionSource;
  }
  return out;
}
```

3. Modify the `resolve` function so the returned resolution is post-processed. Replace the final `return { ok: true, value: withEnv, resolution: finalRes };` (around line 177) with:

```ts
  const taggedRes = tagSecretResolution(withEnv as Record<string, unknown>, finalRes);
  return { ok: true, value: withEnv, resolution: taggedRes };
```

4. Also update the import line for `envvars.ts` if needed — it already imports `ResolutionSource` as a type; nothing further to do there.

- [ ] **Step 5: Bypass schema validation for `SecretRef`-valued secret fields**

The string-field validator in `plugins/kaizen-config/schema.ts` rejects non-string values, so a `SecretRef` would fail validation. Edit the `walk` function's `case "string"` (lines 25–31) to short-circuit when the field is `secret` and the value is a `SecretRef`:

```ts
    case "string": {
      if (schema.secret && typeof value === "object" && value !== null && !Array.isArray(value)
          && typeof (value as { $ref?: unknown }).$ref === "string") {
        return; // SecretRef sentinel; not a validation failure
      }
      if (typeof value !== "string") return push(errors, path, "must be a string");
      if (schema.min !== undefined && value.length < schema.min) push(errors, path, `length < ${schema.min}`);
      if (schema.max !== undefined && value.length > schema.max) push(errors, path, `length > ${schema.max}`);
      if (schema.pattern && !new RegExp(schema.pattern).test(value)) push(errors, path, `must match /${schema.pattern}/`);
      if (schema.enum && !schema.enum.includes(value)) push(errors, path, `must be one of ${schema.enum.join(", ")}`);
      return;
    }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd plugins/kaizen-config && bun test 2>&1 | tail -30`
Expected: all existing tests pass + the two new cases pass.

- [ ] **Step 7: Commit**

```bash
git add plugins/kaizen-config/envvars.ts plugins/kaizen-config/store.ts plugins/kaizen-config/schema.ts plugins/kaizen-config/test/store.test.ts
git commit -m "kaizen-config: recognize SecretRef on load, tag resolution scheme"
```

---

### Task 8: Wire the registry into `StoreDeps` and add `ready()` resolution

**Files:**
- Modify: `plugins/kaizen-config/store.ts`
- Modify: `plugins/kaizen-config/test/store.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `plugins/kaizen-config/test/store.test.ts`:

```ts
import { createRegistry } from "../secrets/registry.ts";

describe("store — ready() with backend", () => {
  it("ready() resolves $refs against the registered backend", async () => {
    const { deps, fs } = makeDeps();
    fs.files.set(deps.homePath, JSON.stringify({
      plugins: { x: { apiKey: { $ref: "fake:x/apiKey" } } },
    }));
    const registry = createRegistry();
    registry.register({
      scheme: "fake",
      async get(k) { return k === "x/apiKey" ? "resolved-value" : (() => { throw new Error("nope"); })(); },
      async set() {},
      async delete() {},
    });
    const store = createStore({ ...deps, registry });
    store.register({
      plugin: "x",
      defaults: { apiKey: "" },
      schema: { apiKey: { type: "string", secret: true } },
    });
    // Before ready: still the ref
    expect(store.get<{ apiKey: unknown }>("x").apiKey).toEqual({ $ref: "fake:x/apiKey" });
    await store.ready();
    // After ready: resolved plaintext
    expect(store.get<{ apiKey: string }>("x").apiKey).toBe("resolved-value");
  });

  it("ready() leaves SecretRef in place when scheme is not registered", async () => {
    const { deps, fs } = makeDeps();
    fs.files.set(deps.homePath, JSON.stringify({
      plugins: { x: { apiKey: { $ref: "missing:k" } } },
    }));
    const registry = createRegistry();
    const store = createStore({ ...deps, registry });
    store.register({
      plugin: "x",
      defaults: { apiKey: "" },
      schema: { apiKey: { type: "string", secret: true } },
    });
    await store.ready();
    expect(store.get<{ apiKey: unknown }>("x").apiKey).toEqual({ $ref: "missing:k" });
  });

  it("ready() tolerates backend get() failures (keeps SecretRef, does not throw)", async () => {
    const { deps, fs } = makeDeps();
    fs.files.set(deps.homePath, JSON.stringify({
      plugins: { x: { apiKey: { $ref: "fake:x/apiKey" } } },
    }));
    const registry = createRegistry();
    registry.register({
      scheme: "fake",
      async get() { throw new Error("backend exploded"); },
      async set() {},
      async delete() {},
    });
    const store = createStore({ ...deps, registry });
    store.register({
      plugin: "x",
      defaults: { apiKey: "" },
      schema: { apiKey: { type: "string", secret: true } },
    });
    await store.ready();
    expect(store.get<{ apiKey: unknown }>("x").apiKey).toEqual({ $ref: "fake:x/apiKey" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd plugins/kaizen-config && bun test test/store.test.ts 2>&1 | tail -30`
Expected: FAIL — `ready` not present on store; `registry` not a known dep.

- [ ] **Step 3a: Add `ready()` to the contract**

In `plugins/llm-contracts/contracts/config-store.ts`, append to the `ConfigStoreService` interface (before the closing `}`):

```ts
  ready(): Promise<void>;
```

- [ ] **Step 3: Add `registry` to `StoreDeps` and `ready()` to the returned service**

Edit `plugins/kaizen-config/store.ts`:

1. Update imports (top of file). Add:

```ts
import { isSecretRef, type SecretsRegistryService } from "llm-contracts/public";
```

(replacing the existing `isSecretRef` import line from Task 7 by combining; do not import `isSecretRef` twice).

2. Add to the `StoreDeps` interface (after `log`):

```ts
  registry?: SecretsRegistryService;   // optional: when absent, only plaintext + env work
```

3. Replace the `createStore` function so that resolved-secret values are stored in a second-stage cache, exposed through `ready()`. Add inside the function body (after the `recomputeAll` definition near the top):

```ts
  let readyPromise: Promise<void> | null = null;

  const resolveRefsForEntry = async (entry: Entry): Promise<void> => {
    const registry = deps.registry;
    if (!registry) return;
    const current = entry.cachedValue as Record<string, unknown>;
    if (!current || typeof current !== "object") return;
    for (const [k, v] of Object.entries(current)) {
      if (!isSecretRef(v)) continue;
      if (!registry.has(v.$ref.slice(0, Math.max(v.$ref.indexOf(":"), 0)))) continue;
      try {
        const plaintext = await registry.resolve(v);
        (current as Record<string, unknown>)[k] = plaintext;
      } catch (err) {
        deps.log(`kaizen-config: failed to resolve ${v.$ref} for '${entry.spec.plugin}': ${(err as Error).message}`);
      }
    }
    for (const cb of entry.watchers) cb(entry.cachedValue);
  };

  const resolveAll = async (): Promise<void> => {
    for (const entry of entries.values()) {
      await resolveRefsForEntry(entry);
    }
  };
```

4. Add `ready()` to the returned object (in the same block that contains `register`, `get`, etc.):

```ts
    ready(): Promise<void> {
      if (!readyPromise) readyPromise = resolveAll();
      return readyPromise;
    },
```

5. Reset `readyPromise` whenever `recomputeAll` runs (so a file change triggers re-resolution on the next `ready()`). Modify `recomputeAll` — at its top, add:

```ts
    readyPromise = null;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd plugins/kaizen-config && bun test test/store.test.ts 2>&1 | tail -30`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add plugins/kaizen-config/store.ts plugins/kaizen-config/test/store.test.ts
git commit -m "kaizen-config: ready() resolves SecretRefs through registry"
```

---

### Task 9: Secret-aware `set()` — route to registry, write `$ref`

**Files:**
- Modify: `plugins/kaizen-config/store.ts`
- Modify: `plugins/kaizen-config/test/store.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `plugins/kaizen-config/test/store.test.ts`:

```ts
describe("store — set() secret-aware routing", () => {
  it("writes a $ref (not plaintext) when the field is marked secret", async () => {
    const { deps, fs } = makeDeps();
    const registry = createRegistry();
    const backendData = new Map<string, string>();
    registry.register({
      scheme: "fake",
      async get(k) { const v = backendData.get(k); if (v === undefined) throw new Error("nope"); return v; },
      async set(k, v) { backendData.set(k, v); },
      async delete(k) { backendData.delete(k); },
    });
    const store = createStore({ ...deps, registry });
    store.register({
      plugin: "x",
      defaults: { apiKey: "" },
      schema: { apiKey: { type: "string", secret: true } },
    });
    await store.set("x", { apiKey: "tvly-abc" } as any, "home");
    const onDisk = JSON.parse(fs.files.get(deps.homePath)!);
    expect(onDisk.plugins.x.apiKey).toEqual({ $ref: "fake:x/apiKey" });
    expect(backendData.get("x/apiKey")).toBe("tvly-abc");
    // In-memory snapshot has plaintext
    expect(store.get<{ apiKey: string }>("x").apiKey).toBe("tvly-abc");
  });

  it("rejects with helpful error when no writable backend is registered", async () => {
    const { deps } = makeDeps();
    const registry = createRegistry();
    const store = createStore({ ...deps, registry });
    store.register({
      plugin: "x",
      defaults: { apiKey: "" },
      schema: { apiKey: { type: "string", secret: true } },
    });
    expect(store.set("x", { apiKey: "tvly-abc" } as any)).rejects.toThrow(/no writable secrets backend registered/);
  });

  it("rejects when multiple writable backends and no defaultSecretBackend", async () => {
    const { deps } = makeDeps();
    const registry = createRegistry();
    registry.register({ scheme: "a", async get() { return ""; }, async set() {}, async delete() {} });
    registry.register({ scheme: "b", async get() { return ""; }, async set() {}, async delete() {} });
    const store = createStore({ ...deps, registry });
    store.register({
      plugin: "x",
      defaults: { apiKey: "" },
      schema: { apiKey: { type: "string", secret: true } },
    });
    expect(store.set("x", { apiKey: "tvly-abc" } as any)).rejects.toThrow(/multiple writable backends/);
  });

  it("uses kaizen-config.defaultSecretBackend when set", async () => {
    const { deps } = makeDeps();
    const registry = createRegistry();
    const aData = new Map<string, string>(); const bData = new Map<string, string>();
    registry.register({ scheme: "a", async get(k){return aData.get(k)!;}, async set(k,v){aData.set(k,v);}, async delete(k){aData.delete(k);} });
    registry.register({ scheme: "b", async get(k){return bData.get(k)!;}, async set(k,v){bData.set(k,v);}, async delete(k){bData.delete(k);} });
    const store = createStore({ ...deps, registry });
    store.register({
      plugin: "kaizen-config",
      defaults: { defaultSecretBackend: undefined as string | undefined },
      schema: { defaultSecretBackend: { type: "string" } },
    });
    await store.set("kaizen-config", { defaultSecretBackend: "b" } as any);
    store.register({
      plugin: "x",
      defaults: { apiKey: "" },
      schema: { apiKey: { type: "string", secret: true } },
    });
    await store.set("x", { apiKey: "tvly-abc" } as any);
    expect(bData.get("x/apiKey")).toBe("tvly-abc");
    expect(aData.has("x/apiKey")).toBe(false);
  });

  it("writes plaintext for non-secret fields (unchanged behavior)", async () => {
    const { deps, fs } = makeDeps();
    const registry = createRegistry();
    const store = createStore({ ...deps, registry });
    store.register({
      plugin: "x",
      defaults: { model: "" },
      schema: { model: { type: "string" } },
    });
    await store.set("x", { model: "gpt-4" } as any);
    const onDisk = JSON.parse(fs.files.get(deps.homePath)!);
    expect(onDisk.plugins.x.model).toBe("gpt-4");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd plugins/kaizen-config && bun test test/store.test.ts 2>&1 | tail -20`
Expected: FAIL — `set()` still writes plaintext for secret fields.

- [ ] **Step 3: Add the secret-routing logic to `set()`**

Edit `plugins/kaizen-config/store.ts`:

1. Add import at top (combine with existing llm-contracts import):

```ts
import type { FieldSchema as ContractFieldSchema } from "llm-contracts/public";
```

(If `FieldSchema` is already imported via `schema.ts`, use that — be consistent with the existing pattern in the file.)

2. Add the `selectBackend` import:

```ts
import { selectBackend } from "./secrets/select-backend.ts";
```

3. Inside `set()`, before the existing `mergePluginSection` call, intercept secret-marked fields. Replace the body of `set()` with:

```ts
    async set<T>(plugin: string, partial: Partial<T>, scope: ConfigScope = "home"): Promise<void> {
      const e = entries.get(plugin);
      if (!e) throw new Error(`kaizen-config: plugin '${plugin}' is not registered`);
      const path = scope === "home" ? deps.homePath : deps.projectPath;
      const current = scope === "home" ? home.file : project.file;

      // Split the partial into "to-write-to-file" and "to-route-through-registry".
      const schema = e.spec.schema as Record<string, ContractFieldSchema | undefined> | undefined;
      const toFile: Record<string, unknown> = {};
      const secretWrites: Array<{ key: string; value: string }> = [];
      for (const [k, v] of Object.entries(partial as Record<string, unknown>)) {
        const fs = schema?.[k];
        const isSecretField = fs && fs.type === "string" && fs.secret === true;
        if (!isSecretField) { toFile[k] = v; continue; }
        if (typeof v !== "string") {
          // Allow passing through an already-formed SecretRef (rare but supported).
          if (isSecretRef(v)) { toFile[k] = v; continue; }
          throw new Error(`kaizen-config: secret field '${plugin}.${k}' must be set with a string value`);
        }
        secretWrites.push({ key: k, value: v });
      }

      // If any secret writes are needed, pick a backend and store them, collecting $refs.
      if (secretWrites.length > 0) {
        if (!deps.registry) throw new Error("kaizen-config: no secrets registry available; cannot set secret fields");
        const kaizenSelf = entries.get("kaizen-config");
        const configured = (kaizenSelf?.cachedValue as { defaultSecretBackend?: string } | undefined)?.defaultSecretBackend;
        const available = deps.registry.schemes();
        const readOnly: string[] = [];
        // Heuristic: every resolver self-reports readOnly; we ask via store() which throws.
        // We capture read-only by trial: store("env", ...) throws. Instead, expose via a helper:
        for (const scheme of available) {
          // Probe by attempting a no-op store with the read-only error catching:
          // We cannot easily probe without side effects, so rely on the registry's behavior.
          // For now treat "env" as the known read-only scheme; resolvers that mark themselves
          // read-only will reject store() and we surface the error.
          if (scheme === "env") readOnly.push(scheme);
        }
        const pick = selectBackend({ configured, available, readOnly });
        if (!pick.ok) throw new Error(`kaizen-config: ${pick.error}`);
        for (const { key, value } of secretWrites) {
          const ref = await deps.registry.store(pick.scheme, `${plugin}/${key}`, value);
          toFile[key] = ref;
        }
      }

      const next = mergePluginSection(current, plugin, toFile);
      const probeHome = scope === "home" ? next : home.file;
      const probeProject = scope === "project" ? next : project.file;
      const { ok, errors } = resolve(plugin, e.spec, probeHome, probeProject, deps);
      if (!ok) {
        throw new Error(
          `kaizen-config: validation failed for '${plugin}': ${errors!.map((er) => `${er.path}: ${er.message}`).join("; ")}`,
        );
      }
      deps.writeFile(path, next);
      if (scope === "home") home = { file: next, exists: true };
      else project = { file: next, exists: true };
      const r = resolve(plugin, e.spec, home.file, project.file, deps);
      e.cachedValue = r.value;
      e.cachedResolution = r.resolution;
      // Inject plaintext for secret fields we just wrote, since `resolve` will see the $ref.
      const cv = e.cachedValue as Record<string, unknown>;
      for (const { key, value } of secretWrites) cv[key] = value;
      for (const cb of e.watchers) cb(e.cachedValue);
    },
```

- [ ] **Step 4: Expose `readOnly` from the registry to avoid the `env` heuristic**

The probe block above is brittle. Replace it by exposing `readOnly` on the registry. Edit `plugins/kaizen-config/secrets/registry.ts`:

Add a `readOnlySchemes()` method to the returned service:

```ts
    readOnlySchemes() {
      const out: string[] = [];
      for (const [scheme, r] of resolvers) {
        if (r.readOnly) out.push(scheme);
      }
      return out;
    },
```

Update the contract — `plugins/llm-contracts/contracts/secrets-registry.ts` `SecretsRegistryService`:

```ts
  /** Which schemes are read-only (cannot accept set/delete). */
  readOnlySchemes(): string[];
```

Now in `store.ts` `set()`, replace the read-only probe block:

```ts
        const readOnly = deps.registry.readOnlySchemes();
```

(removing the `for (const scheme of available)` heuristic.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd plugins/kaizen-config && bun test test/store.test.ts 2>&1 | tail -30`
Expected: all secret-set cases pass; existing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add plugins/llm-contracts/contracts/secrets-registry.ts plugins/kaizen-config/secrets/registry.ts plugins/kaizen-config/store.ts plugins/kaizen-config/test/store.test.ts
git commit -m "kaizen-config: secret-aware set() routes through registry"
```

---

### Task 10: Add `unset()` method

**Files:**
- Modify: `plugins/kaizen-config/store.ts`
- Modify: `plugins/kaizen-config/test/store.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `plugins/kaizen-config/test/store.test.ts`:

```ts
describe("store — unset()", () => {
  it("removes a non-secret key from the file", async () => {
    const { deps, fs } = makeDeps();
    fs.files.set(deps.homePath, JSON.stringify({
      plugins: { x: { model: "gpt-4", baseUrl: "https://example" } },
    }));
    const registry = createRegistry();
    const store = createStore({ ...deps, registry });
    store.register({ plugin: "x", defaults: { model: "", baseUrl: "" }, schema: {} });
    await store.unset("x", "model");
    const onDisk = JSON.parse(fs.files.get(deps.homePath)!);
    expect(onDisk.plugins.x).toEqual({ baseUrl: "https://example" });
  });

  it("deletes secret from backend when value is a $ref", async () => {
    const { deps, fs } = makeDeps();
    const backendData = new Map<string, string>([["x/apiKey", "tvly-abc"]]);
    fs.files.set(deps.homePath, JSON.stringify({
      plugins: { x: { apiKey: { $ref: "fake:x/apiKey" } } },
    }));
    const registry = createRegistry();
    registry.register({
      scheme: "fake",
      async get(k) { const v = backendData.get(k); if (v === undefined) throw new Error("nope"); return v; },
      async set(k, v) { backendData.set(k, v); },
      async delete(k) { backendData.delete(k); },
    });
    const store = createStore({ ...deps, registry });
    store.register({
      plugin: "x",
      defaults: { apiKey: "" },
      schema: { apiKey: { type: "string", secret: true } },
    });
    await store.unset("x", "apiKey");
    expect(backendData.has("x/apiKey")).toBe(false);
    const onDisk = JSON.parse(fs.files.get(deps.homePath)!);
    expect(onDisk.plugins.x ?? {}).toEqual({});
  });

  it("soft-succeeds when backend has already lost the entry", async () => {
    const { deps, fs } = makeDeps();
    fs.files.set(deps.homePath, JSON.stringify({
      plugins: { x: { apiKey: { $ref: "fake:x/apiKey" } } },
    }));
    const registry = createRegistry();
    registry.register({
      scheme: "fake",
      async get() { throw new Error("gone"); },
      async set() {},
      async delete() { throw new Error("already gone"); },
    });
    const store = createStore({ ...deps, registry });
    store.register({
      plugin: "x",
      defaults: { apiKey: "" },
      schema: { apiKey: { type: "string", secret: true } },
    });
    await store.unset("x", "apiKey");   // does not throw
  });

  it("throws when plugin is not registered", async () => {
    const { deps } = makeDeps();
    const store = createStore({ ...deps, registry: createRegistry() });
    expect(store.unset("missing", "k")).rejects.toThrow(/not registered/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd plugins/kaizen-config && bun test test/store.test.ts 2>&1 | tail -20`
Expected: FAIL — `unset` not on store.

- [ ] **Step 2a: Add `unset()` to the contract**

In `plugins/llm-contracts/contracts/config-store.ts`, append to the `ConfigStoreService` interface (after the `ready()` line added in Task 8):

```ts
  unset(plugin: string, key: string, scope?: ConfigScope): Promise<void>;
```

- [ ] **Step 3: Implement `unset()` in `store.ts`**

Add to the returned service object (alongside `set`, `get`, etc.):

```ts
    async unset(plugin: string, key: string, scope: ConfigScope = "home"): Promise<void> {
      const e = entries.get(plugin);
      if (!e) throw new Error(`kaizen-config: plugin '${plugin}' is not registered`);
      const path = scope === "home" ? deps.homePath : deps.projectPath;
      const current = scope === "home" ? home.file : project.file;
      const section = { ...(current.plugins?.[plugin] ?? {}) };
      const wasRef = isSecretRef(section[key]);
      const refValue = section[key] as { $ref: string } | undefined;
      delete section[key];
      const nextPlugins = { ...current.plugins, [plugin]: section };
      const next = { ...current, plugins: nextPlugins };
      deps.writeFile(path, next);
      if (scope === "home") home = { file: next, exists: true };
      else project = { file: next, exists: true };
      if (wasRef && refValue && deps.registry) {
        try { await deps.registry.delete(refValue); }
        catch (err) { deps.log(`kaizen-config: backend delete failed for ${refValue.$ref}: ${(err as Error).message}`); }
      }
      const r = resolve(plugin, e.spec, home.file, project.file, deps);
      e.cachedValue = r.value;
      e.cachedResolution = r.resolution;
      for (const cb of e.watchers) cb(e.cachedValue);
    },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd plugins/kaizen-config && bun test test/store.test.ts 2>&1 | tail -20`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add plugins/kaizen-config/store.ts plugins/kaizen-config/test/store.test.ts
git commit -m "kaizen-config: store.unset() with backend cleanup"
```

---

## Phase 4: kaizen-config — plugin wiring & slash UX

### Task 11: Provide `secrets:registry` in plugin setup; bundle env resolver; self-register schema

**Files:**
- Modify: `plugins/kaizen-config/index.ts`
- Modify: `plugins/kaizen-config/index.test.ts`

- [ ] **Step 1: Write the failing tests**

Read the existing `plugins/kaizen-config/index.test.ts` first to match its style, then add a new `describe` block:

```ts
import { describe, it, expect } from "bun:test";
// Existing imports remain.
// Append at end of file:

describe("plugin setup — secrets:registry wiring", () => {
  it("provides secrets:registry with env resolver always registered", async () => {
    const provided: Record<string, unknown> = {};
    const defined: string[] = [];
    const ctx = {
      log: () => {},
      defineService: (id: string) => { defined.push(id); },
      provideService: <T,>(id: string, svc: T) => { provided[id] = svc; },
      useService: <T,>() => { throw new Error("no slash registry in this test"); },
      harness: { harnessId: "test", marketplaceId: "official" },
    } as any;
    const { default: plugin } = await import("../index.ts");
    await plugin.setup(ctx);
    const reg = provided["secrets:registry"] as { schemes(): string[]; has(s: string): boolean };
    expect(reg).toBeDefined();
    expect(reg.schemes()).toContain("env");
    expect(reg.has("env")).toBe(true);
    await plugin.stop?.();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd plugins/kaizen-config && bun test index.test.ts 2>&1 | tail -20`
Expected: FAIL — `secrets:registry` not provided.

- [ ] **Step 3: Update `plugins/kaizen-config/index.ts`**

Add imports near the top:

```ts
import { createRegistry } from "./secrets/registry.ts";
import { createEnvResolver } from "./secrets/env-resolver.ts";
```

Inside `setup(ctx)`, before the `createStore` call, build and provide the registry:

```ts
    const registry = createRegistry();
    registry.register(createEnvResolver(process.env as Record<string, string | undefined>));
    ctx.provideService("secrets:registry", registry);
```

Pass the registry into `StoreDeps`:

```ts
    const deps: StoreDeps = {
      // ... existing fields ...
      registry,
    };
```

Update the `services` declaration on the plugin object to include the new provision:

```ts
  services: {
    provides: ["config:store", "secrets:registry"],
    consumes: ["slash:registry"],
  },
```

After `const store = createStore(deps);` and `ctx.provideService(...)`, self-register kaizen-config's own schema so the `defaultSecretBackend` field is settable via `/config:set`:

```ts
    store.register({
      plugin: "kaizen-config",
      defaults: { defaultSecretBackend: undefined as string | undefined },
      schema: {
        defaultSecretBackend: { type: "string" },
      },
    });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd plugins/kaizen-config && bun test 2>&1 | tail -20`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add plugins/kaizen-config/index.ts plugins/kaizen-config/index.test.ts
git commit -m "kaizen-config: provide secrets:registry; bundle env; self-register schema"
```

---

### Task 12: `/config:get` — schema-aware redaction with `--reveal`

**Files:**
- Modify: `plugins/kaizen-config/slash.ts`
- Modify: `plugins/kaizen-config/test/slash.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `plugins/kaizen-config/test/slash.test.ts`:

```ts
describe("/config:get — secret redaction", () => {
  it("redacts secret-marked fields by default", async () => {
    const { reg, registered } = makeRegistry();
    const deps = makeDeps({
      store: makeStore({
        get: (_p: string) => ({ apiKey: "tvly-abc", model: "gpt-4" }),
        list: () => [{
          plugin: "x",
          homePath: "/h",
          projectPath: "/p",
          homeExists: true,
          projectExists: false,
          resolution: { apiKey: "secret:keychain", model: "home" },
        }],
      }),
    });
    // Pretend the schema is exposed via store.list — for the redaction call site,
    // slash needs schema info. The implementation will look up the registered spec.
    registerSlashCommands(reg, deps);
    const handler = registered.find((r) => r.manifest.name === "config:get")!.handler;
    const out = await call(handler, "x");
    expect(out).toContain("<redacted");
    expect(out).not.toContain("tvly-abc");
  });

  it("reveals plaintext when --reveal is passed", async () => {
    const { reg, registered } = makeRegistry();
    const deps = makeDeps({
      store: makeStore({
        get: () => ({ apiKey: "tvly-abc" }),
      }),
    });
    registerSlashCommands(reg, deps);
    const handler = registered.find((r) => r.manifest.name === "config:get")!.handler;
    const out = await call(handler, "x --reveal");
    expect(out).toContain("tvly-abc");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd plugins/kaizen-config && bun test test/slash.test.ts 2>&1 | tail -20`
Expected: FAIL — output still contains plaintext when not revealing.

- [ ] **Step 3: Expose schema lookup from store for slash use**

The redaction needs schema information. Add a lightweight helper on the store. In `plugins/kaizen-config/store.ts`, expose `getSpec`:

```ts
    getSpec(plugin: string): ConfigSpec<unknown> | undefined {
      return entries.get(plugin)?.spec;
    },
```

Also declare it on the contract. Edit `plugins/llm-contracts/contracts/config-store.ts` — add to `ConfigStoreService`:

```ts
  getSpec(plugin: string): ConfigSpec<unknown> | undefined;
```

(`ConfigSpec<unknown>` is already exported.)

- [ ] **Step 4: Update `/config:get` to redact**

In `plugins/kaizen-config/slash.ts`:

1. Add imports at the top:

```ts
import { redactSnapshot, redactValue } from "./secrets/redact.ts";
import type { ConfigSchema, FieldSchema } from "llm-contracts/public";
```

2. Replace the `/config:get` handler block (the one registered with `name: "config:get"`) with:

```ts
  offs.push(reg.register(
    {
      name: "config:get",
      description: "Print the merged config for a plugin. Usage: /config:get <plugin> [key.path] [--reveal]",
      source: "plugin",
    },
    async (ctx) => {
      const tokens = ctx.args.trim().split(/\s+/).filter(Boolean);
      const reveal = tokens.includes("--reveal");
      const rest = tokens.filter((t) => t !== "--reveal");
      const plugin = rest[0];
      const keyPath = rest[1];
      if (!plugin) return ctx.print("Usage: /config:get <plugin> [key.path] [--reveal]");
      let value: unknown;
      try { value = deps.store.get(plugin); }
      catch (err) { return ctx.print(`Error: ${(err as Error).message}`); }
      const spec = deps.store.getSpec?.(plugin);
      const schema = spec?.schema as ConfigSchema<Record<string, unknown>> | undefined;
      if (!reveal && schema) value = redactSnapshot(value as Record<string, unknown>, schema);
      if (keyPath) {
        const fieldKey = keyPath.split(".")[0]!;
        const fieldSchema = schema?.[fieldKey] as FieldSchema | undefined;
        value = keyPath.split(".").reduce<any>((v, k) => (v == null ? v : v[k]), value);
        if (!reveal && fieldSchema) value = redactValue(value, fieldSchema);
      }
      await ctx.print(JSON.stringify(value, null, 2));
    },
  ));
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd plugins/kaizen-config && bun test 2>&1 | tail -30`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add plugins/llm-contracts/contracts/config-store.ts plugins/kaizen-config/store.ts plugins/kaizen-config/slash.ts plugins/kaizen-config/test/slash.test.ts
git commit -m "kaizen-config: /config:get redacts secrets unless --reveal"
```

---

### Task 13: `/config:list` — resolution column + backends footer

**Files:**
- Modify: `plugins/kaizen-config/slash.ts`
- Modify: `plugins/kaizen-config/test/slash.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `plugins/kaizen-config/test/slash.test.ts`:

```ts
describe("/config:list — resolution + backends footer", () => {
  it("prints resolution column and registered backends in footer", async () => {
    const { reg, registered } = makeRegistry();
    const fakeRegistry = {
      schemes: () => ["env", "keychain"],
      readOnlySchemes: () => ["env"],
      has: (s: string) => ["env", "keychain"].includes(s),
      register: () => () => {},
      resolve: async () => "",
      store: async () => ({ $ref: "" }),
      delete: async () => {},
    };
    registerSlashCommands(reg, makeDeps({
      store: makeStore({
        list: () => [{
          plugin: "x",
          homePath: "/h",
          projectPath: "/p",
          homeExists: true,
          projectExists: false,
          resolution: { apiKey: "secret:keychain", model: "home" },
        }],
        get: (_p: string) => ({}),
      }),
      registry: fakeRegistry as any,
      defaultSecretBackend: () => "keychain",
    }));
    const handler = registered.find((r) => r.manifest.name === "config:list")!.handler;
    const out = await call(handler);
    expect(out).toContain("apiKey: secret:keychain");
    expect(out).toContain("Backends:");
    expect(out).toContain("env       (read-only, built-in)");
    expect(out).toContain("keychain  (default)");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd plugins/kaizen-config && bun test test/slash.test.ts 2>&1 | tail -20`
Expected: FAIL — registry not part of `SlashDeps`; output lacks the new sections.

- [ ] **Step 3: Add `registry` and `defaultSecretBackend` to `SlashDeps`**

In `plugins/kaizen-config/slash.ts`, expand `SlashDeps`:

```ts
import type { SecretsRegistryService } from "llm-contracts/public";

export interface SlashDeps {
  store: ConfigStoreService;
  homePath: string;
  projectPath: string;
  harnessKey: string;
  editor: string;
  log: (msg: string) => void;
  spawnEditor: (editor: string, path: string) => Promise<number>;
  registry: SecretsRegistryService;
  defaultSecretBackend: () => string | undefined;
}
```

- [ ] **Step 4: Update `/config:list` handler**

Replace the `/config:list` handler with:

```ts
  offs.push(reg.register(
    {
      name: "config:list",
      description: "List registered plugin configs and their resolution paths.",
      source: "plugin",
    },
    async (ctx) => {
      const rows = deps.store.list();
      const lines: string[] = [];
      if (rows.length === 0) {
        lines.push("No plugins registered with config:store.");
      } else {
        lines.push("Plugins:");
        for (const r of rows) {
          const res = Object.entries(r.resolution).map(([k, v]) => `${k}: ${v}`).join(", ");
          lines.push(`  ${r.plugin}  home=${r.homeExists ? "yes" : "no"}  project=${r.projectExists ? "yes" : "no"}  [${res}]`);
        }
      }
      const schemes = deps.registry.schemes();
      const readOnly = new Set(deps.registry.readOnlySchemes());
      const defaultScheme = deps.defaultSecretBackend();
      if (schemes.length > 0) {
        lines.push("", "Backends:");
        for (const s of schemes) {
          const flags: string[] = [];
          if (readOnly.has(s)) flags.push("read-only");
          if (s === "env") flags.push("built-in");
          if (s === defaultScheme) flags.push("default");
          const flagStr = flags.length ? `(${flags.join(", ")})` : "";
          lines.push(`  ${s.padEnd(9)} ${flagStr}`);
        }
      }
      lines.push("", `Harness: ${deps.harnessKey}`, `Home: ${deps.homePath}`, `Project: ${deps.projectPath}`);
      await ctx.print(lines.join("\n"));
    },
  ));
```

- [ ] **Step 5: Update the test helper `makeDeps` in `test/slash.test.ts`**

Edit the helper near the top of the file so existing tests still pass with the new required fields:

```ts
function makeDeps(over: Partial<SlashDeps> = {}): SlashDeps {
  return {
    store: makeStore(),
    homePath: "/h/config.json",
    projectPath: "/p/config.json",
    harnessKey: "default",
    editor: "vi",
    log: () => {},
    spawnEditor: () => Promise.resolve(0),
    registry: {
      schemes: () => [],
      readOnlySchemes: () => [],
      has: () => false,
      register: () => () => {},
      resolve: async () => "",
      store: async () => ({ $ref: "" }),
      delete: async () => {},
    } as any,
    defaultSecretBackend: () => undefined,
    ...over,
  };
}
```

- [ ] **Step 6: Update `plugins/kaizen-config/index.ts` to pass the new deps**

In the call to `registerSlashCommands`, add:

```ts
        registry,
        defaultSecretBackend: () => (store.get<{ defaultSecretBackend?: string }>("kaizen-config")).defaultSecretBackend,
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd plugins/kaizen-config && bun test 2>&1 | tail -30`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add plugins/kaizen-config/slash.ts plugins/kaizen-config/index.ts plugins/kaizen-config/test/slash.test.ts
git commit -m "kaizen-config: /config:list shows resolution + backends footer"
```

---

### Task 14: `/config:unset` slash command

**Files:**
- Modify: `plugins/kaizen-config/slash.ts`
- Modify: `plugins/kaizen-config/test/slash.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `plugins/kaizen-config/test/slash.test.ts`:

```ts
describe("/config:unset", () => {
  it("registers and calls store.unset with the given key + scope", async () => {
    const { reg, registered } = makeRegistry();
    const calls: { plugin: string; key: string; scope?: string }[] = [];
    const deps = makeDeps({
      store: makeStore({
        unset: async (plugin: string, key: string, scope?: string) => { calls.push({ plugin, key, scope }); },
      }),
    });
    registerSlashCommands(reg, deps);
    const handler = registered.find((r) => r.manifest.name === "config:unset")!.handler;
    const out = await call(handler, "x apiKey --project");
    expect(calls).toEqual([{ plugin: "x", key: "apiKey", scope: "project" }]);
    expect(out).toMatch(/Unset x\.apiKey \(project\)/);
  });

  it("usage on bad args", async () => {
    const { reg, registered } = makeRegistry();
    registerSlashCommands(reg, makeDeps());
    const handler = registered.find((r) => r.manifest.name === "config:unset")!.handler;
    const out = await call(handler, "");
    expect(out).toMatch(/Usage:/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd plugins/kaizen-config && bun test test/slash.test.ts 2>&1 | tail -20`
Expected: FAIL — no `config:unset` command registered.

- [ ] **Step 3: Add the handler in `slash.ts`**

Add the following `reg.register` block alongside the others in `registerSlashCommands`:

```ts
  offs.push(reg.register(
    {
      name: "config:unset",
      description: "Remove a config key. Usage: /config:unset <plugin> <key> [--project]",
      source: "plugin",
    },
    async (ctx) => {
      const tokens = ctx.args.trim().split(/\s+/).filter(Boolean);
      const scope = tokens.includes("--project") ? "project" : "home";
      const rest = tokens.filter((t) => t !== "--project");
      const plugin = rest[0];
      const key = rest[1];
      if (!plugin || !key) return ctx.print("Usage: /config:unset <plugin> <key> [--project]");
      try {
        await deps.store.unset(plugin, key, scope);
        await ctx.print(`Unset ${plugin}.${key} (${scope}).`);
      } catch (err) {
        await ctx.print(`Error: ${(err as Error).message}`);
      }
    },
  ));
```

- [ ] **Step 4: Also update the test helper `makeStore` to include `unset`**

In `plugins/kaizen-config/test/slash.test.ts`, edit `makeStore` to add `unset` to the defaults:

```ts
    unset: async () => {},
```

And `ready` for completeness:

```ts
    ready: async () => {},
    getSpec: () => undefined,
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd plugins/kaizen-config && bun test 2>&1 | tail -20`
Expected: all pass.

- [ ] **Step 6: Bump kaizen-config version**

Edit `plugins/kaizen-config/package.json`, change `"version": "0.1.0"` to `"version": "0.2.0"`.

- [ ] **Step 7: Commit**

```bash
git add plugins/kaizen-config/slash.ts plugins/kaizen-config/test/slash.test.ts plugins/kaizen-config/package.json
git commit -m "kaizen-config: /config:unset; bump to 0.2.0"
```

---

## Phase 5: `kaizen-secrets-keychain` (new plugin)

### Task 15: Scaffold the plugin workspace

**Files:**
- Create: `plugins/kaizen-secrets-keychain/package.json`
- Create: `plugins/kaizen-secrets-keychain/tsconfig.json`
- Create: `plugins/kaizen-secrets-keychain/public.d.ts`
- Create: `plugins/kaizen-secrets-keychain/README.md`
- Create: `plugins/kaizen-secrets-keychain/CLAUDE.md`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "kaizen-secrets-keychain",
  "version": "0.1.0",
  "description": "macOS Keychain backend for kaizen-config secrets:registry. Registers the 'keychain' resolver scheme.",
  "type": "module",
  "exports": {
    ".": "./index.ts"
  },
  "keywords": ["kaizen-plugin"],
  "dependencies": {
    "llm-contracts": "workspace:*"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "^5.4.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

Mirror the style used by another small plugin (e.g., `plugins/llm-tavily-search/tsconfig.json`):

```json
{
  "compilerOptions": {
    "lib": ["ESNext"],
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "types": ["bun"]
  },
  "include": ["index.ts", "resolver.ts", "errors.ts", "test/**/*.ts"]
}
```

- [ ] **Step 3: Create `public.d.ts`**

```ts
// plugins/kaizen-secrets-keychain/public.d.ts
// No public types exported.
export {};
```

- [ ] **Step 4: Create `README.md`**

```md
# kaizen-secrets-keychain

macOS Keychain backend for `kaizen-config`'s `secrets:registry`. Registers
the `keychain:` resolver scheme so secret-marked fields can be stored in
the user's login keychain.

## Requirements

- macOS (the `security` CLI must be available on `PATH`).
- A `kaizen-config` version that provides `secrets:registry`.

## How it works

When a plugin's schema marks a string field as `secret: true`, `kaizen-config`
stores it on disk as a pointer (`{ "$ref": "keychain:<plugin>/<field>" }`)
and routes the actual value through the registered keychain resolver. This
plugin shells out to `security` for every read/write.

## First-use prompt

The first time `security find-generic-password` reads a value created by
this plugin, macOS may show an "Always Allow / Allow / Deny" dialog. Pick
"Always Allow" for silent subsequent reads. This is normal Keychain UX and
cannot be suppressed by a CLI caller.

## Service constant

All entries created by this plugin use the keychain service
`kaizen-secrets`. Account names take the form `<plugin>/<field>`. You can
inspect entries with:

```
security dump-keychain | grep '"svce"<blob>="kaizen-secrets"'
```
```

- [ ] **Step 5: Create `CLAUDE.md`**

```md
# Working in `kaizen-secrets-keychain`

Notes for agents editing this plugin. See the design spec at
`docs/superpowers/specs/2026-05-20-kaizen-config-secrets-design.md`.

## Invariants

- **No native deps.** All Keychain access is via `child_process.spawn`
  against the system `security` CLI. Do not add `keytar` or similar.
- **Pure resolver factory.** `resolver.ts` exports `(spawn) => SecretsResolver`
  so tests can inject a fake `spawn`. `index.ts` is the only file that
  touches `ctx` or `process`.
- **Platform guard.** `index.ts` bails on non-darwin platforms with a log
  line and returns cleanly. Tests assert this.
- **Service constant.** `kaizen-secrets`. Do not change without considering
  migration for existing users.

## Local deploy

Same recipe as the repo CLAUDE.md. Redeploy `llm-contracts` first if its
secrets-registry contract surface changed.
```

- [ ] **Step 6: Verify the workspace picks up the new package**

Run: `bun install 2>&1 | tail -10`
Expected: success; `node_modules` populated under the new plugin dir.

- [ ] **Step 7: Commit**

```bash
git add plugins/kaizen-secrets-keychain/package.json plugins/kaizen-secrets-keychain/tsconfig.json plugins/kaizen-secrets-keychain/public.d.ts plugins/kaizen-secrets-keychain/README.md plugins/kaizen-secrets-keychain/CLAUDE.md
git commit -m "kaizen-secrets-keychain: scaffold plugin workspace"
```

---

### Task 16: Implement keychain resolver factory

**Files:**
- Create: `plugins/kaizen-secrets-keychain/errors.ts`
- Create: `plugins/kaizen-secrets-keychain/resolver.ts`
- Create: `plugins/kaizen-secrets-keychain/test/resolver.test.ts`

- [ ] **Step 1: Create the error types**

Write `plugins/kaizen-secrets-keychain/errors.ts`:

```ts
// plugins/kaizen-secrets-keychain/errors.ts

export class KeychainNotFoundError extends Error {
  constructor(account: string) {
    super(`keychain:${account} not found in keychain`);
    this.name = "KeychainNotFoundError";
  }
}

export class KeychainLockedError extends Error {
  constructor() {
    super("keychain is locked; unlock it and try again");
    this.name = "KeychainLockedError";
  }
}
```

- [ ] **Step 2: Write the failing resolver tests**

Create `plugins/kaizen-secrets-keychain/test/resolver.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { createKeychainResolver, type SpawnFn, KEYCHAIN_SERVICE } from "../resolver.ts";
import { KeychainNotFoundError, KeychainLockedError } from "../errors.ts";

interface SpawnCall { cmd: string; args: string[] }

function fakeSpawn(out: { stdout?: string; exitCode: number }): { spawn: SpawnFn; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const spawn: SpawnFn = async (cmd, args) => {
    calls.push({ cmd, args });
    return { stdout: out.stdout ?? "", stderr: "", exitCode: out.exitCode };
  };
  return { spawn, calls };
}

describe("keychain resolver", () => {
  it("declares scheme=keychain and is not read-only", () => {
    const { spawn } = fakeSpawn({ exitCode: 0 });
    const r = createKeychainResolver(spawn);
    expect(r.scheme).toBe("keychain");
    expect(r.readOnly).toBe(false);
  });

  it("get() shells out to security find-generic-password -w and trims stdout", async () => {
    const { spawn, calls } = fakeSpawn({ stdout: "tvly-abc\n", exitCode: 0 });
    const r = createKeychainResolver(spawn);
    const v = await r.get("plug/api");
    expect(v).toBe("tvly-abc");
    expect(calls[0]).toEqual({
      cmd: "security",
      args: ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", "plug/api", "-w"],
    });
  });

  it("get() throws KeychainNotFoundError on exit code 44", async () => {
    const { spawn } = fakeSpawn({ exitCode: 44 });
    const r = createKeychainResolver(spawn);
    await expect(r.get("plug/missing")).rejects.toBeInstanceOf(KeychainNotFoundError);
  });

  it("get() throws KeychainLockedError on exit code 51", async () => {
    const { spawn } = fakeSpawn({ exitCode: 51 });
    const r = createKeychainResolver(spawn);
    await expect(r.get("plug/api")).rejects.toBeInstanceOf(KeychainLockedError);
  });

  it("set() shells out to security add-generic-password -U with the value", async () => {
    const { spawn, calls } = fakeSpawn({ exitCode: 0 });
    const r = createKeychainResolver(spawn);
    await r.set!("plug/api", "tvly-xyz");
    expect(calls[0]).toEqual({
      cmd: "security",
      args: ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", "plug/api", "-w", "tvly-xyz"],
    });
  });

  it("delete() shells out to security delete-generic-password", async () => {
    const { spawn, calls } = fakeSpawn({ exitCode: 0 });
    const r = createKeychainResolver(spawn);
    await r.delete!("plug/api");
    expect(calls[0]).toEqual({
      cmd: "security",
      args: ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", "plug/api"],
    });
  });

  it("delete() does not throw when entry is already missing (exit code 44)", async () => {
    const { spawn } = fakeSpawn({ exitCode: 44 });
    const r = createKeychainResolver(spawn);
    await r.delete!("plug/missing");   // no throw
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd plugins/kaizen-secrets-keychain && bun test 2>&1 | tail -20`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the resolver**

Create `plugins/kaizen-secrets-keychain/resolver.ts`:

```ts
// plugins/kaizen-secrets-keychain/resolver.ts
import type { SecretsResolver } from "llm-contracts/public";
import { KeychainLockedError, KeychainNotFoundError } from "./errors.ts";

export const KEYCHAIN_SERVICE = "kaizen-secrets";

export interface SpawnResult { stdout: string; stderr: string; exitCode: number }
export type SpawnFn = (cmd: string, args: string[]) => Promise<SpawnResult>;

export function createKeychainResolver(spawn: SpawnFn): SecretsResolver {
  const run = async (args: string[]): Promise<SpawnResult> => spawn("security", args);

  return {
    scheme: "keychain",
    readOnly: false,
    async get(key) {
      const r = await run(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", key, "-w"]);
      if (r.exitCode === 44) throw new KeychainNotFoundError(key);
      if (r.exitCode === 51) throw new KeychainLockedError();
      if (r.exitCode !== 0) throw new Error(`security find-generic-password failed (exit ${r.exitCode}): ${r.stderr.trim()}`);
      return r.stdout.replace(/\n$/, "");
    },
    async set(key, value) {
      const r = await run(["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", key, "-w", value]);
      if (r.exitCode === 51) throw new KeychainLockedError();
      if (r.exitCode !== 0) throw new Error(`security add-generic-password failed (exit ${r.exitCode}): ${r.stderr.trim()}`);
    },
    async delete(key) {
      const r = await run(["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", key]);
      if (r.exitCode === 44) return;   // already gone — soft success
      if (r.exitCode === 51) throw new KeychainLockedError();
      if (r.exitCode !== 0) throw new Error(`security delete-generic-password failed (exit ${r.exitCode}): ${r.stderr.trim()}`);
    },
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd plugins/kaizen-secrets-keychain && bun test 2>&1 | tail -20`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add plugins/kaizen-secrets-keychain/errors.ts plugins/kaizen-secrets-keychain/resolver.ts plugins/kaizen-secrets-keychain/test/resolver.test.ts
git commit -m "kaizen-secrets-keychain: resolver factory + tests"
```

---

### Task 17: Plugin `index.ts` — platform guard + register with registry

**Files:**
- Create: `plugins/kaizen-secrets-keychain/index.ts`
- Create: `plugins/kaizen-secrets-keychain/test/index.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `plugins/kaizen-secrets-keychain/test/index.test.ts`:

```ts
import { describe, it, expect } from "bun:test";

interface Ctx {
  log: (m: string) => void;
  defineService: () => void;
  provideService: () => void;
  useService: <T>(id: string) => T;
}

function makeCtx(over: Partial<Ctx> = {}, useReturn?: unknown): { ctx: Ctx; logs: string[] } {
  const logs: string[] = [];
  const ctx: Ctx = {
    log: (m) => { logs.push(m); },
    defineService: () => {},
    provideService: () => {},
    useService: <T>(_id: string) => useReturn as T,
    ...over,
  };
  return { ctx, logs };
}

describe("plugin setup", () => {
  it("on non-darwin, logs and does not register", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try {
      const calls: any[] = [];
      const { ctx, logs } = makeCtx({}, { register: (r: unknown) => { calls.push(r); return () => {}; } });
      const { default: plugin } = await import("../index.ts");
      await plugin.setup(ctx as any);
      expect(calls).toHaveLength(0);
      expect(logs.join("\n")).toMatch(/non-darwin|not supported/);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });

  it("on darwin, registers a 'keychain' resolver with the registry", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    try {
      const calls: any[] = [];
      const { ctx } = makeCtx({}, { register: (r: any) => { calls.push(r); return () => {}; } });
      const { default: plugin } = await import("../index.ts");
      await plugin.setup(ctx as any);
      expect(calls).toHaveLength(1);
      expect(calls[0].scheme).toBe("keychain");
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd plugins/kaizen-secrets-keychain && bun test test/index.test.ts 2>&1 | tail -20`
Expected: FAIL — `index.ts` not found.

- [ ] **Step 3: Implement the plugin entry**

Create `plugins/kaizen-secrets-keychain/index.ts`:

```ts
// plugins/kaizen-secrets-keychain/index.ts
import type { KaizenPlugin } from "kaizen/types";
import type { SecretsRegistryService } from "llm-contracts/public";
import { spawn } from "node:child_process";
import { createKeychainResolver, type SpawnFn } from "./resolver.ts";

const offs: Array<() => void> = [];

const realSpawn: SpawnFn = (cmd, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 0 }));
  });

const plugin: KaizenPlugin = {
  name: "kaizen-secrets-keychain",
  apiVersion: "3.0.0",
  permissions: { tier: "unscoped" },
  services: {
    provides: [],
    consumes: ["secrets:registry"],
  },

  async setup(ctx) {
    if (process.platform !== "darwin") {
      ctx.log(`kaizen-secrets-keychain: platform '${process.platform}' is not supported (darwin only); resolver not registered`);
      return;
    }
    try {
      const registry = ctx.useService<SecretsRegistryService>("secrets:registry");
      const resolver = createKeychainResolver(realSpawn);
      offs.push(registry.register(resolver));
      ctx.log("kaizen-secrets-keychain: 'keychain' resolver registered");
    } catch (err) {
      ctx.log(`kaizen-secrets-keychain: secrets:registry unavailable (${(err as Error).message}); resolver not registered`);
    }
  },

  async stop() {
    while (offs.length) {
      const off = offs.pop();
      try { off?.(); } catch { /* ignore */ }
    }
  },
};

export default plugin;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd plugins/kaizen-secrets-keychain && bun test 2>&1 | tail -20`
Expected: all pass.

- [ ] **Step 5: Validate the plugin manifest**

Run: `kaizen plugin validate plugins/kaizen-secrets-keychain 2>&1 | tail -20`
Expected: validation passes (or surfaces only doc-related notes that we can address).

- [ ] **Step 6: Commit**

```bash
git add plugins/kaizen-secrets-keychain/index.ts plugins/kaizen-secrets-keychain/test/index.test.ts
git commit -m "kaizen-secrets-keychain: plugin shell with platform guard"
```

---

## Phase 6: Marketplace, harnesses, deploy

### Task 18: Marketplace + harness wiring

**Files:**
- Modify: `.kaizen/marketplace.json`
- Modify: `harnesses/local.json`
- Modify: `harnesses/claude-wrapper.json`
- Modify: `README.md`

- [ ] **Step 1: Add the new plugin to `.kaizen/marketplace.json`**

Locate the `entries` array and append (preserve trailing-comma style of surrounding entries):

```json
    {
      "kind": "plugin",
      "name": "kaizen-secrets-keychain",
      "description": "macOS Keychain backend for kaizen-config's secrets:registry. Registers the 'keychain' resolver scheme.",
      "categories": ["secrets", "config"],
      "versions": [{ "version": "0.1.0", "source": { "type": "file", "path": "plugins/kaizen-secrets-keychain" } }]
    }
```

Also update the version of the existing `llm-contracts` and `kaizen-config` entries to include the new versions (`0.4.0` and `0.2.0` respectively), keeping any older versions in the `versions` array.

- [ ] **Step 2: Update `harnesses/local.json`**

Change the version pins for `llm-contracts` (`0.3.0` → `0.4.0`) and `kaizen-config` (`0.1.0` → `0.2.0`), and add a new line for `kaizen-secrets-keychain` after `kaizen-config`:

```json
{
  "plugins": [
    "official/llm-contracts@0.4.0",
    "official/kaizen-config@0.2.0",
    "official/kaizen-secrets-keychain@0.1.0",
    ...
  ]
}
```

- [ ] **Step 3: Update `harnesses/claude-wrapper.json`**

Apply the same three changes there (same version pins, same insertion point).

- [ ] **Step 4: Update `README.md`**

In whatever section lists plugins one-line-each, add:

```
- **kaizen-secrets-keychain** — macOS Keychain backend for `secrets:registry`.
```

Also update the `kaizen-config` line if its description has changed (now provides `secrets:registry` too).

- [ ] **Step 5: Validate all three modified plugins**

Run: `kaizen plugin validate plugins/llm-contracts && kaizen plugin validate plugins/kaizen-config && kaizen plugin validate plugins/kaizen-secrets-keychain 2>&1 | tail -30`
Expected: all three pass.

- [ ] **Step 6: Run the full test suite**

Run: `bun test 2>&1 | tail -20`
Expected: all plugin tests pass.

- [ ] **Step 7: Commit**

```bash
git add .kaizen/marketplace.json harnesses/local.json harnesses/claude-wrapper.json README.md
git commit -m "marketplace + harnesses: add kaizen-secrets-keychain; bump llm-contracts/kaizen-config"
```

---

### Task 19: Local deploy and smoke test

**Files:**
- (no source changes; deploys local builds)

- [ ] **Step 1: Deploy `llm-contracts`**

```bash
PLUGIN=llm-contracts
VERSION=$(jq -r .version plugins/$PLUGIN/package.json)
INSTALL_DIR=~/.kaizen/marketplaces/official/plugins/${PLUGIN}@${VERSION}
(cd plugins/$PLUGIN && bun build --target=bun --outfile=dist/index.js index.ts)
mkdir -p "$INSTALL_DIR/dist"
cp plugins/$PLUGIN/dist/index.js "$INSTALL_DIR/dist/index.js"
rsync -a --exclude='node_modules' --exclude='dist' plugins/$PLUGIN/ "$INSTALL_DIR/"
```

Expected: no errors; new `${INSTALL_DIR}` populated.

- [ ] **Step 2: Deploy `kaizen-config`**

Same recipe, with `PLUGIN=kaizen-config`. Run it.

- [ ] **Step 3: Deploy `kaizen-secrets-keychain`**

Same recipe, with `PLUGIN=kaizen-secrets-keychain`. Run it.

- [ ] **Step 4: Smoke test — start the harness**

Run: `kaizen --harness official/local 2>&1 | head -30`
Expected: clean startup. The log should include a line from `kaizen-secrets-keychain` indicating the resolver registered (on macOS).

- [ ] **Step 5: Smoke test — set a secret via slash command**

From inside the running harness:

```
/config:set llm-tavily-search apiKey=tvly-smoke-test-value
/config:list
/config:get llm-tavily-search apiKey
/config:get llm-tavily-search apiKey --reveal
```

Expected:
- `set` echoes `Updated llm-tavily-search.apiKey (home, secret:keychain).`
- `list` shows `[apiKey: secret:keychain, ...]` and a `Backends:` footer listing `env` and `keychain` (default).
- `get` shows `"<redacted:keychain>"`.
- `get --reveal` shows `"tvly-smoke-test-value"`.

- [ ] **Step 6: Smoke test — verify file contents and keychain entry**

Outside the harness:

```bash
cat ~/.kaizen/harnesses/official_local/config.json
security find-generic-password -s kaizen-secrets -a llm-tavily-search/apiKey -w
```

Expected:
- The JSON file contains `{ "$ref": "keychain:llm-tavily-search/apiKey" }` for `apiKey` — no plaintext on disk.
- The `security` command prints `tvly-smoke-test-value`.

- [ ] **Step 7: Smoke test — unset**

Back inside the harness:

```
/config:unset llm-tavily-search apiKey
```

Then outside:

```bash
security find-generic-password -s kaizen-secrets -a llm-tavily-search/apiKey -w
```

Expected: `security` exits with code 44 (item not found). The JSON file no longer contains `apiKey` for that plugin.

- [ ] **Step 8: (No commit needed)**

This task is purely operational verification. If any smoke test fails, file an issue or fix forward; do not commit fake-greens.

---

## Self-review notes

- **Spec coverage:** Every section of the spec (architecture, contracts, store internals, slash UX, keychain backend, testing, deployment) maps to at least one task above. Migration is explicitly out of scope per the spec; no task implements it.
- **No `secret:` namespace:** All user-facing slash commands stay under `/config:*` (set, get, list, edit, unset). The "no migration" decision means no `/config:secrets:migrate`.
- **TDD:** Every task with code creates or modifies a test file before the implementation file in the same task.
- **No placeholders:** Every step shows the actual code or command. No "implement remaining cases", no "similar to above".
- **Type continuity:** `SecretRef`, `SecretsResolver`, `SecretsRegistryService`, `SpawnFn`, `KEYCHAIN_SERVICE`, `ConfigResolutionSource` are defined once and referenced consistently in later tasks.
- **Frequent commits:** Each task ends with a single focused commit.
