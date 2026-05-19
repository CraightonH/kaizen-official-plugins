# llm-config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Standardize plugin configuration via a new `llm-config` plugin owning a `config:store` service. Harness-scoped single-file storage replaces nine per-plugin config loaders.

**Architecture:** New contract `config:store` in `llm-contracts`. New plugin `llm-config` provides the service: load → merge (defaults → home → project → env) → validate → memoize, atomic writes, fs.watch, slash commands. All current configurable plugins migrate to consume the service. Hard break, no compat shim.

**Tech Stack:** Bun workspace, TypeScript, kaizen plugin runtime. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-05-18-llm-config-design.md`

---

## File Structure

**Contract (modify):**
- `plugins/llm-contracts/contracts/config-store.ts` (new)
- `plugins/llm-contracts/public.ts` (modify — add re-exports)
- `plugins/llm-contracts/index.ts` (modify — add defineService call)
- `plugins/llm-contracts/test/index.test.ts` (modify — assert defineService)

**New plugin (`plugins/llm-config/`):**
- `package.json` — workspace entry
- `index.ts` — KaizenPlugin: setup/teardown, provideService, slash wiring
- `paths.ts` — harness key derivation + path resolution
- `schema.ts` — runtime shape validator
- `envvars.ts` — per-field env-var resolution
- `atomic-write.ts` — tmp+rename writer
- `store.ts` — register/get/set/watch core
- `slash.ts` — /config command handlers
- `public.d.ts` — empty (contract lives in llm-contracts)
- `test/paths.test.ts`
- `test/schema.test.ts`
- `test/envvars.test.ts`
- `test/atomic-write.test.ts`
- `test/store.test.ts`
- `test/slash.test.ts`
- `CLAUDE.md` — module-map + invariants for future agents

**Harness + marketplace (modify):**
- `harnesses/openai-compatible.json`
- `.kaizen/marketplace.json`

**Migrations (one task each, 9 plugins):**
- `plugins/openai-llm/{index.ts, config.ts (delete), test/config.test.ts (delete)}`
- `plugins/llm-codemode/{...}`
- `plugins/llm-memory/{...}`
- `plugins/llm-mcp-bridge/{...}`
- `plugins/llm-agents/{...}`
- `plugins/llm-tavily-search/{...}`
- `plugins/llm-tool-approval/{...}`
- `plugins/llm-hooks-shell/{...}`
- `plugins/llm-session-manager/{...}` (consumes `ctx.config` today, not a file)

---

## Migration Recipe (shared procedure, referenced by Tasks 14–22)

Each migration task follows this recipe; the per-plugin task shows the **specific** `register()` call and identifies the files to delete.

1. Add `"llm-config": "workspace:*"` to the plugin's `package.json` dependencies if not already present.
2. Add `"config:store"` to `services.consumes` in `index.ts` (hard dep).
3. In `setup()`: call `ctx.consumeService("config:store")`, then `const config = ctx.useService<ConfigStoreService>("config:store");` then `config.register({...})` with the plugin's defaults, schema, and envVars.
4. Replace every prior load-config call with `config.get<ConfigShape>("<plugin>")`.
5. Delete `plugins/<plugin>/config.ts` (or trim to type definitions only if other modules import `ConfigShape`).
6. Delete `plugins/<plugin>/test/config.test.ts` (the loader is gone; the store has its own tests).
7. Update other tests that depended on the loader to inject a stub `ConfigStoreService` instead.
8. `cd plugins/<plugin> && bun test` → green.
9. `kaizen plugin validate plugins/<plugin>` → pass.
10. Bump the plugin's `version` (patch). Update `.kaizen/marketplace.json` to add a new version entry. Update `harnesses/openai-compatible.json` to point at the new version. (Marketplace + harness updates are batched in Task 23.)
11. Commit.

---

## Task 1: Add `config:store` contract module

**Files:**
- Create: `plugins/llm-contracts/contracts/config-store.ts`

- [ ] **Step 1: Write the contract module**

```ts
// plugins/llm-contracts/contracts/config-store.ts

export type ConfigScope = "home" | "project";

export type FieldSchema =
  | { type: "string"; min?: number; max?: number; pattern?: string; enum?: string[] }
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

export interface ConfigStatus {
  plugin: string;
  homePath: string;
  projectPath: string;
  homeExists: boolean;
  projectExists: boolean;
  resolution: Record<string, "default" | "home" | "project" | "env">;
}

export interface ConfigStoreService {
  register<T>(spec: ConfigSpec<T>): void;
  get<T>(plugin: string): T;
  set<T>(plugin: string, value: Partial<T>, scope?: ConfigScope): Promise<void>;
  watch<T>(plugin: string, cb: (next: T) => void): () => void;
  list(): ConfigStatus[];
}

export const CONTRACT_ID = "config:store" as const;
export const DESCRIPTION =
  "Harness-scoped plugin configuration store. Plugins register schema/defaults; service resolves defaults → home → project → env and exposes get/set/watch.";
```

- [ ] **Step 2: Re-export from `public.ts`**

Append to `plugins/llm-contracts/public.ts`:

```ts
export type {
  ConfigStoreService,
  ConfigSpec,
  ConfigSchema,
  ConfigScope,
  ConfigStatus,
  FieldSchema,
} from "./contracts/config-store";
```

- [ ] **Step 3: Define the service in `index.ts`**

Modify `plugins/llm-contracts/index.ts`:

```ts
import * as configStoreContract from "./contracts/config-store";
```

Add the line after the other contract imports, then inside `setup(ctx)`:

```ts
ctx.defineService(configStoreContract.CONTRACT_ID, { description: configStoreContract.DESCRIPTION });
```

- [ ] **Step 4: Add the assertion to the existing test**

Read `plugins/llm-contracts/test/index.test.ts` to find the asserted contract list. Add `"config:store"` to that list.

- [ ] **Step 5: Run llm-contracts tests**

```sh
cd plugins/llm-contracts && bun test
```

Expected: PASS, including a check that `config:store` is defined.

- [ ] **Step 6: Bump llm-contracts version**

In `plugins/llm-contracts/package.json`, bump `version` from `0.1.0` to `0.2.0`.

- [ ] **Step 7: Commit**

```sh
git add plugins/llm-contracts/
git commit -m "feat(llm-contracts): add config:store contract"
```

---

## Task 2: Scaffold `llm-config` plugin (package + entry stub)

**Files:**
- Create: `plugins/llm-config/package.json`
- Create: `plugins/llm-config/index.ts`
- Create: `plugins/llm-config/public.d.ts`
- Create: `plugins/llm-config/CLAUDE.md`

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "llm-config",
  "version": "0.1.0",
  "description": "Harness-scoped plugin configuration store. Provides config:store.",
  "type": "module",
  "exports": { ".": "./index.ts" },
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

- [ ] **Step 2: Write `index.ts` stub**

```ts
import type { KaizenPlugin } from "kaizen/types";

const plugin: KaizenPlugin = {
  name: "llm-config",
  apiVersion: "3.0.0",
  permissions: {
    tier: "scoped",
    fs: {
      read: ["~/.kaizen/harnesses/**", "./.kaizen/harnesses/**"],
      write: ["~/.kaizen/harnesses/**", "./.kaizen/harnesses/**"],
    },
  },
  services: {
    provides: ["config:store"],
    consumes: ["slash:registry"],
  },
  async setup(_ctx) {
    // Implemented in Task 8 (wiring) after all pure modules land.
  },
};

export default plugin;
```

- [ ] **Step 3: Write `public.d.ts`**

```ts
// llm-config exposes no plugin-private types. The contract surface lives in
// llm-contracts/public.
export {};
```

- [ ] **Step 4: Write `CLAUDE.md`**

```markdown
# Working in `llm-config`

Notes for agents editing this plugin. See the design spec at
`docs/superpowers/specs/2026-05-18-llm-config-design.md`.

## Invariants

- **Single file per harness.** Reads/writes target
  `~/.kaizen/harnesses/<harnessKey>/config.json` (home) and
  `<cwd>/.kaizen/harnesses/<harnessKey>/config.json` (project, keys win).
  Never write to per-plugin paths.
- **Atomic writes only.** `atomic-write.ts` is the sole writer; tmp+rename.
- **Schema validation is mandatory on every load + every write.** A
  validation failure on boot logs and falls back to defaults; a failure
  on `set()` rejects the call.
- **Env-var values beat all file layers.** Documented; consumers can
  declare per-field `envVars` mappings via `register()`.
- **`store.ts`, `paths.ts`, `schema.ts`, `envvars.ts`, `atomic-write.ts`
  must remain pure** (deps-injected I/O). Only `index.ts` and `slash.ts`
  touch `ctx`.

## Local deploy

Same recipe as the repo CLAUDE.md, plus: redeploy `llm-contracts` first if
this plugin's contract surface changed.
```

- [ ] **Step 5: Install workspace deps**

```sh
cd /Users/chancock/git/kaizen-official-plugins && bun install
```

Expected: workspace symlinks `llm-contracts` into `plugins/llm-config/node_modules/`.

- [ ] **Step 6: Commit**

```sh
git add plugins/llm-config/
git commit -m "feat(llm-config): scaffold plugin"
```

---

## Task 3: Implement `paths.ts` (harness key + path resolution) — TDD

**Files:**
- Create: `plugins/llm-config/paths.ts`
- Create: `plugins/llm-config/test/paths.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// plugins/llm-config/test/paths.test.ts
import { describe, it, expect } from "bun:test";
import { harnessKey, homeConfigPath, projectConfigPath, type HarnessIdentity } from "../paths.ts";

describe("harnessKey", () => {
  it("uses ref when present, stripping version", () => {
    expect(harnessKey({ ref: "official/openai-compatible@0.1.0" })).toBe("official_openai-compatible");
  });
  it("derives from jsonPath basename when ref missing", () => {
    expect(harnessKey({ jsonPath: "/abs/harnesses/openai-compatible.json" })).toBe("local_openai-compatible");
  });
  it("derives from parent dir when jsonPath is kaizen.json", () => {
    expect(harnessKey({ jsonPath: "/abs/my-harness/kaizen.json" })).toBe("local_my-harness");
  });
  it("returns 'default' when identity is empty", () => {
    expect(harnessKey({})).toBe("default");
  });
  it("sanitizes unsafe chars", () => {
    expect(harnessKey({ jsonPath: "/x/weird name?.json" })).toBe("local_weird_name_");
  });
  it("throws when ref derives to a reserved 'local'-prefixed key", () => {
    expect(() => harnessKey({ ref: "local/something@0.1.0" })).toThrow(/reserved local session key/);
  });
});

describe("path resolution", () => {
  it("homeConfigPath joins home + harnesses + key + config.json", () => {
    expect(homeConfigPath("/u/me", "official_openai-compatible"))
      .toBe("/u/me/.kaizen/harnesses/official_openai-compatible/config.json");
  });
  it("projectConfigPath joins cwd + .kaizen + harnesses + key + config.json", () => {
    expect(projectConfigPath("/proj", "default"))
      .toBe("/proj/.kaizen/harnesses/default/config.json");
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

```sh
cd plugins/llm-config && bun test test/paths.test.ts
```

Expected: FAIL with "Cannot find module '../paths.ts'".

- [ ] **Step 3: Implement `paths.ts`**

```ts
// plugins/llm-config/paths.ts
import { basename, dirname, join } from "node:path";

export interface HarnessIdentity {
  ref?: string;
  jsonPath?: string;
}

function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9_.-]/g, "_");
}

export function harnessKey(h: HarnessIdentity): string {
  if (h.ref) {
    const withoutVersion = h.ref.replace(/@[^/@]+$/, "");
    const derived = sanitize(withoutVersion.replace(/\//g, "_"));
    if (derived === "local" || derived.startsWith("local_")) {
      throw new Error(
        `Harness ref '${h.ref}' derives to a reserved local session key; rename the harness source or marketplace.`,
      );
    }
    return derived;
  }
  if (h.jsonPath) {
    const base = basename(h.jsonPath);
    const name = base === "kaizen.json" ? basename(dirname(h.jsonPath)) : base.replace(/\.json$/, "");
    return `local_${sanitize(name)}`;
  }
  return "default";
}

export function homeConfigPath(home: string, key: string): string {
  return join(home, ".kaizen", "harnesses", key, "config.json");
}

export function projectConfigPath(cwd: string, key: string): string {
  return join(cwd, ".kaizen", "harnesses", key, "config.json");
}
```

- [ ] **Step 4: Run tests, expect green**

```sh
cd plugins/llm-config && bun test test/paths.test.ts
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```sh
git add plugins/llm-config/paths.ts plugins/llm-config/test/paths.test.ts
git commit -m "feat(llm-config): paths module (harnessKey + path resolution)"
```

---

## Task 4: Implement `schema.ts` (shape validator) — TDD

**Files:**
- Create: `plugins/llm-config/schema.ts`
- Create: `plugins/llm-config/test/schema.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// plugins/llm-config/test/schema.test.ts
import { describe, it, expect } from "bun:test";
import { validate, type ConfigSchema, type FieldSchema } from "../schema.ts";

describe("validate — primitives", () => {
  it("accepts a valid number", () => {
    const r = validate({ n: 5 }, { n: { type: "number", min: 1, max: 10 } });
    expect(r.ok).toBe(true);
  });
  it("rejects a number below min", () => {
    const r = validate({ n: 0 }, { n: { type: "number", min: 1 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0].path).toBe("n");
  });
  it("rejects a non-integer when integer required", () => {
    const r = validate({ n: 1.5 }, { n: { type: "number", integer: true } });
    expect(r.ok).toBe(false);
  });
  it("accepts a valid string with pattern", () => {
    const r = validate({ s: "abc" }, { s: { type: "string", pattern: "^[a-z]+$" } });
    expect(r.ok).toBe(true);
  });
  it("rejects a string failing pattern", () => {
    const r = validate({ s: "ABC" }, { s: { type: "string", pattern: "^[a-z]+$" } });
    expect(r.ok).toBe(false);
  });
  it("accepts an enum value", () => {
    const r = validate({ e: "a" }, { e: { type: "enum", values: ["a", "b"] } });
    expect(r.ok).toBe(true);
  });
  it("rejects an out-of-set enum value", () => {
    const r = validate({ e: "c" }, { e: { type: "enum", values: ["a", "b"] } });
    expect(r.ok).toBe(false);
  });
  it("accepts a boolean", () => {
    const r = validate({ b: true }, { b: { type: "boolean" } });
    expect(r.ok).toBe(true);
  });
  it("rejects a non-boolean for boolean field", () => {
    const r = validate({ b: "true" }, { b: { type: "boolean" } });
    expect(r.ok).toBe(false);
  });
});

describe("validate — arrays", () => {
  it("accepts an array of strings within bounds", () => {
    const r = validate({ a: ["x", "y"] }, { a: { type: "array", items: { type: "string" }, max: 5 } });
    expect(r.ok).toBe(true);
  });
  it("rejects an array exceeding max", () => {
    const r = validate({ a: ["x", "y", "z"] }, { a: { type: "array", items: { type: "string" }, max: 2 } });
    expect(r.ok).toBe(false);
  });
  it("rejects when item fails type", () => {
    const r = validate({ a: ["x", 1] }, { a: { type: "array", items: { type: "string" } } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0].path).toBe("a[1]");
  });
});

describe("validate — objects", () => {
  it("accepts nested object", () => {
    const schema: ConfigSchema<any> = {
      retry: {
        type: "object",
        properties: { max: { type: "number", min: 1 } },
      },
    };
    const r = validate({ retry: { max: 3 } }, schema);
    expect(r.ok).toBe(true);
  });
  it("rejects nested object with bad child", () => {
    const schema: ConfigSchema<any> = {
      retry: {
        type: "object",
        properties: { max: { type: "number", min: 1 } },
      },
    };
    const r = validate({ retry: { max: 0 } }, schema);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0].path).toBe("retry.max");
  });
  it("rejects unknown property when additionalProperties is false", () => {
    const schema: ConfigSchema<any> = {
      retry: {
        type: "object",
        properties: { max: { type: "number" } },
        additionalProperties: false,
      },
    };
    const r = validate({ retry: { max: 1, extra: 9 } }, schema);
    expect(r.ok).toBe(false);
  });
});

describe("validate — unknown top-level keys are allowed by default", () => {
  it("ignores keys not in the schema", () => {
    const r = validate({ known: 1, extra: "x" }, { known: { type: "number" } });
    expect(r.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

```sh
cd plugins/llm-config && bun test test/schema.test.ts
```

Expected: FAIL with "Cannot find module '../schema.ts'".

- [ ] **Step 3: Implement `schema.ts`**

```ts
// plugins/llm-config/schema.ts
import type { ConfigSchema, FieldSchema } from "llm-contracts/public";

export type { ConfigSchema, FieldSchema };

export interface ValidationError { path: string; message: string; }
export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: ValidationError[] };

export function validate<T>(value: unknown, schema: ConfigSchema<T>): ValidationResult<T> {
  if (!isObject(value)) return { ok: false, errors: [{ path: "", message: "must be an object" }] };
  const errors: ValidationError[] = [];
  for (const [key, fieldSchema] of Object.entries(schema)) {
    if (!fieldSchema) continue;
    if (!(key in value)) continue;
    const v = (value as Record<string, unknown>)[key];
    walk(v, fieldSchema as FieldSchema, key, errors);
  }
  return errors.length === 0
    ? { ok: true, value: value as T }
    : { ok: false, errors };
}

function walk(value: unknown, schema: FieldSchema, path: string, errors: ValidationError[]): void {
  switch (schema.type) {
    case "string": {
      if (typeof value !== "string") return push(errors, path, "must be a string");
      if (schema.min !== undefined && value.length < schema.min) push(errors, path, `length < ${schema.min}`);
      if (schema.max !== undefined && value.length > schema.max) push(errors, path, `length > ${schema.max}`);
      if (schema.pattern && !new RegExp(schema.pattern).test(value)) push(errors, path, `must match /${schema.pattern}/`);
      if (schema.enum && !schema.enum.includes(value)) push(errors, path, `must be one of ${schema.enum.join(", ")}`);
      return;
    }
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) return push(errors, path, "must be a finite number");
      if (schema.integer && !Number.isInteger(value)) push(errors, path, "must be an integer");
      if (schema.min !== undefined && value < schema.min) push(errors, path, `must be >= ${schema.min}`);
      if (schema.max !== undefined && value > schema.max) push(errors, path, `must be <= ${schema.max}`);
      return;
    }
    case "boolean": {
      if (typeof value !== "boolean") push(errors, path, "must be a boolean");
      return;
    }
    case "enum": {
      if (typeof value !== "string" || !schema.values.includes(value)) {
        push(errors, path, `must be one of ${schema.values.join(", ")}`);
      }
      return;
    }
    case "array": {
      if (!Array.isArray(value)) return push(errors, path, "must be an array");
      if (schema.min !== undefined && value.length < schema.min) push(errors, path, `length < ${schema.min}`);
      if (schema.max !== undefined && value.length > schema.max) push(errors, path, `length > ${schema.max}`);
      value.forEach((item, i) => walk(item, schema.items, `${path}[${i}]`, errors));
      return;
    }
    case "object": {
      if (!isObject(value)) return push(errors, path, "must be an object");
      for (const [k, v] of Object.entries(value)) {
        const child = schema.properties[k];
        if (child) {
          walk(v, child, `${path}.${k}`, errors);
        } else if (schema.additionalProperties === false) {
          push(errors, `${path}.${k}`, "unexpected property");
        } else if (typeof schema.additionalProperties === "object") {
          walk(v, schema.additionalProperties, `${path}.${k}`, errors);
        }
      }
      return;
    }
  }
}

function push(errors: ValidationError[], path: string, message: string): void {
  errors.push({ path, message });
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
```

- [ ] **Step 4: Run tests, expect green**

```sh
cd plugins/llm-config && bun test test/schema.test.ts
```

Expected: PASS, ~15 tests.

- [ ] **Step 5: Commit**

```sh
git add plugins/llm-config/schema.ts plugins/llm-config/test/schema.test.ts
git commit -m "feat(llm-config): schema validator (shape walker)"
```

---

## Task 5: Implement `envvars.ts` — TDD

**Files:**
- Create: `plugins/llm-config/envvars.ts`
- Create: `plugins/llm-config/test/envvars.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// plugins/llm-config/test/envvars.test.ts
import { describe, it, expect } from "bun:test";
import { applyEnvOverrides } from "../envvars.ts";
import type { ConfigSchema } from "../schema.ts";

describe("applyEnvOverrides", () => {
  const schema: ConfigSchema<any> = {
    apiKey: { type: "string" },
    timeoutMs: { type: "number", integer: true },
    enabled: { type: "boolean" },
  };

  it("string env value overrides merged value", () => {
    const { value, resolution } = applyEnvOverrides(
      { apiKey: "from-file" },
      schema,
      { apiKey: "MY_KEY" },
      { MY_KEY: "from-env" },
    );
    expect((value as any).apiKey).toBe("from-env");
    expect(resolution.apiKey).toBe("env");
  });

  it("number env value is parsed", () => {
    const { value } = applyEnvOverrides(
      { timeoutMs: 1000 },
      schema,
      { timeoutMs: "MY_TIMEOUT" },
      { MY_TIMEOUT: "5000" },
    );
    expect((value as any).timeoutMs).toBe(5000);
  });

  it("boolean env value is parsed (true/false strings only)", () => {
    const { value } = applyEnvOverrides(
      { enabled: false },
      schema,
      { enabled: "MY_FLAG" },
      { MY_FLAG: "true" },
    );
    expect((value as any).enabled).toBe(true);
  });

  it("empty env value is ignored", () => {
    const { value, resolution } = applyEnvOverrides(
      { apiKey: "from-file" },
      schema,
      { apiKey: "MY_KEY" },
      { MY_KEY: "" },
    );
    expect((value as any).apiKey).toBe("from-file");
    expect(resolution.apiKey).not.toBe("env");
  });

  it("missing env variable is ignored", () => {
    const { value } = applyEnvOverrides(
      { apiKey: "from-file" },
      schema,
      { apiKey: "MY_KEY" },
      {},
    );
    expect((value as any).apiKey).toBe("from-file");
  });

  it("unparseable number env throws", () => {
    expect(() =>
      applyEnvOverrides(
        { timeoutMs: 1 },
        schema,
        { timeoutMs: "MY_TIMEOUT" },
        { MY_TIMEOUT: "not-a-number" },
      ),
    ).toThrow(/MY_TIMEOUT/);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

```sh
cd plugins/llm-config && bun test test/envvars.test.ts
```

Expected: FAIL with "Cannot find module '../envvars.ts'".

- [ ] **Step 3: Implement `envvars.ts`**

```ts
// plugins/llm-config/envvars.ts
import type { ConfigSchema, FieldSchema } from "./schema.ts";

export type ResolutionSource = "default" | "home" | "project" | "env";

export interface EnvOverrideResult<T> {
  value: T;
  resolution: Record<string, ResolutionSource>;
}

export function applyEnvOverrides<T>(
  merged: T,
  schema: ConfigSchema<T> | undefined,
  envVars: Partial<Record<string, string>> | undefined,
  processEnv: Record<string, string | undefined>,
  priorResolution: Record<string, ResolutionSource> = {},
): EnvOverrideResult<T> {
  if (!envVars) return { value: merged, resolution: { ...priorResolution } };
  const out = { ...(merged as object) } as Record<string, unknown>;
  const resolution: Record<string, ResolutionSource> = { ...priorResolution };
  for (const [field, envName] of Object.entries(envVars)) {
    if (!envName) continue;
    const raw = processEnv[envName];
    if (raw === undefined || raw === "") continue;
    const fieldSchema = schema?.[field as keyof typeof schema] as FieldSchema | undefined;
    out[field] = parseEnvValue(raw, fieldSchema, envName);
    resolution[field] = "env";
  }
  return { value: out as T, resolution };
}

function parseEnvValue(raw: string, schema: FieldSchema | undefined, envName: string): unknown {
  if (!schema) return raw;
  switch (schema.type) {
    case "string":
    case "enum":
      return raw;
    case "number": {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new Error(`env ${envName}='${raw}' is not a number`);
      return n;
    }
    case "boolean": {
      if (raw === "true") return true;
      if (raw === "false") return false;
      throw new Error(`env ${envName}='${raw}' must be 'true' or 'false'`);
    }
    default:
      return raw;
  }
}
```

- [ ] **Step 4: Run tests, expect green**

```sh
cd plugins/llm-config && bun test test/envvars.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```sh
git add plugins/llm-config/envvars.ts plugins/llm-config/test/envvars.test.ts
git commit -m "feat(llm-config): env-var override resolution"
```

---

## Task 6: Implement `atomic-write.ts` — TDD

**Files:**
- Create: `plugins/llm-config/atomic-write.ts`
- Create: `plugins/llm-config/test/atomic-write.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// plugins/llm-config/test/atomic-write.test.ts
import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteJson, mergePluginSection } from "../atomic-write.ts";

const dirs: string[] = [];
function makeTmp(): string {
  const d = mkdtempSync(join(tmpdir(), "llm-config-test-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("atomicWriteJson", () => {
  it("writes JSON to a new file, creating parent dirs", () => {
    const dir = makeTmp();
    const path = join(dir, "a", "b", "config.json");
    atomicWriteJson(path, { x: 1 });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ x: 1 });
  });

  it("overwrites an existing file atomically (no leftover tmp)", () => {
    const dir = makeTmp();
    const path = join(dir, "config.json");
    atomicWriteJson(path, { x: 1 });
    atomicWriteJson(path, { x: 2 });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ x: 2 });
    expect(existsSync(path + ".tmp")).toBe(false);
  });
});

describe("mergePluginSection", () => {
  it("creates the section when missing", () => {
    const next = mergePluginSection({ plugins: {} }, "openai-llm", { baseUrl: "u" });
    expect(next).toEqual({ plugins: { "openai-llm": { baseUrl: "u" } } });
  });
  it("shallow-merges existing section keys", () => {
    const next = mergePluginSection(
      { plugins: { "openai-llm": { baseUrl: "u", defaultModel: "m" } } },
      "openai-llm",
      { defaultModel: "m2" },
    );
    expect(next.plugins["openai-llm"]).toEqual({ baseUrl: "u", defaultModel: "m2" });
  });
  it("leaves other plugins' sections alone", () => {
    const next = mergePluginSection(
      { plugins: { "openai-llm": { x: 1 }, "llm-codemode": { y: 2 } } },
      "openai-llm",
      { x: 9 },
    );
    expect(next.plugins["llm-codemode"]).toEqual({ y: 2 });
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

```sh
cd plugins/llm-config && bun test test/atomic-write.test.ts
```

Expected: FAIL with "Cannot find module '../atomic-write.ts'".

- [ ] **Step 3: Implement `atomic-write.ts`**

```ts
// plugins/llm-config/atomic-write.ts
import { writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface HarnessConfigFile {
  plugins: Record<string, Record<string, unknown>>;
  [k: string]: unknown;
}

export function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

export function mergePluginSection(
  current: HarnessConfigFile,
  plugin: string,
  partial: Record<string, unknown>,
): HarnessConfigFile {
  const plugins = { ...(current.plugins ?? {}) };
  plugins[plugin] = { ...(plugins[plugin] ?? {}), ...partial };
  return { ...current, plugins };
}
```

- [ ] **Step 4: Run tests, expect green**

```sh
cd plugins/llm-config && bun test test/atomic-write.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```sh
git add plugins/llm-config/atomic-write.ts plugins/llm-config/test/atomic-write.test.ts
git commit -m "feat(llm-config): atomic JSON writer + plugin section merge"
```

---

## Task 7: Implement `store.ts` (load/merge/get/set/watch core) — TDD

**Files:**
- Create: `plugins/llm-config/store.ts`
- Create: `plugins/llm-config/test/store.test.ts`

This is the biggest module. The store accepts injected deps for filesystem reads/writes/watch and env access. Watch lifecycle is exercised via injected callbacks to avoid real `fs.watch` in unit tests.

- [ ] **Step 1: Write failing tests**

```ts
// plugins/llm-config/test/store.test.ts
import { describe, it, expect } from "bun:test";
import { createStore, type StoreDeps } from "../store.ts";

interface Fs {
  files: Map<string, string>;
  reads: number;
}

function makeDeps(over: Partial<StoreDeps> = {}, fs?: Fs): { deps: StoreDeps; fs: Fs } {
  const f: Fs = fs ?? { files: new Map(), reads: 0 };
  const watchers = new Map<string, Set<() => void>>();
  const deps: StoreDeps = {
    homePath: "/home/u/.kaizen/harnesses/default/config.json",
    projectPath: "/proj/.kaizen/harnesses/default/config.json",
    readFile: (p) => {
      f.reads++;
      const v = f.files.get(p);
      if (v === undefined) {
        const err: NodeJS.ErrnoException = new Error("ENOENT");
        err.code = "ENOENT";
        throw err;
      }
      return v;
    },
    writeFile: (p, v) => f.files.set(p, v),
    watchFile: (p, cb) => {
      let set = watchers.get(p);
      if (!set) { set = new Set(); watchers.set(p, set); }
      set.add(cb);
      return () => { set!.delete(cb); };
    },
    env: {},
    log: () => {},
    fireWatch: (p) => watchers.get(p)?.forEach((cb) => cb()),
    ...over,
  } as StoreDeps & { fireWatch: (p: string) => void };
  return { deps, fs: f };
}

describe("store — register + get", () => {
  it("returns defaults when nothing on disk", () => {
    const { deps } = makeDeps();
    const store = createStore(deps);
    store.register({ plugin: "x", defaults: { a: 1 } });
    expect(store.get<{ a: number }>("x")).toEqual({ a: 1 });
  });

  it("home file overrides defaults", () => {
    const { deps, fs } = makeDeps();
    fs.files.set(deps.homePath, JSON.stringify({ plugins: { x: { a: 5 } } }));
    const store = createStore(deps);
    store.register({ plugin: "x", defaults: { a: 1, b: 2 } });
    expect(store.get<{ a: number; b: number }>("x")).toEqual({ a: 5, b: 2 });
  });

  it("project file overrides home", () => {
    const { deps, fs } = makeDeps();
    fs.files.set(deps.homePath, JSON.stringify({ plugins: { x: { a: 5 } } }));
    fs.files.set(deps.projectPath, JSON.stringify({ plugins: { x: { a: 9 } } }));
    const store = createStore(deps);
    store.register({ plugin: "x", defaults: { a: 1 } });
    expect(store.get<{ a: number }>("x")).toEqual({ a: 9 });
  });

  it("env beats all file layers", () => {
    const { deps, fs } = makeDeps({ env: { OPENAI_KEY: "from-env" } });
    fs.files.set(deps.projectPath, JSON.stringify({ plugins: { x: { apiKey: "from-proj" } } }));
    const store = createStore(deps);
    store.register({
      plugin: "x",
      defaults: { apiKey: "" },
      schema: { apiKey: { type: "string" } },
      envVars: { apiKey: "OPENAI_KEY" },
    });
    expect(store.get<{ apiKey: string }>("x").apiKey).toBe("from-env");
  });

  it("deep-merges nested objects one level", () => {
    const { deps, fs } = makeDeps();
    fs.files.set(deps.homePath, JSON.stringify({ plugins: { x: { retry: { max: 5 } } } }));
    const store = createStore(deps);
    store.register({ plugin: "x", defaults: { retry: { max: 1, base: 100 } } });
    expect(store.get<any>("x").retry).toEqual({ max: 5, base: 100 });
  });

  it("arrays are replaced, not merged", () => {
    const { deps, fs } = makeDeps();
    fs.files.set(deps.homePath, JSON.stringify({ plugins: { x: { items: [3, 4] } } }));
    const store = createStore(deps);
    store.register({ plugin: "x", defaults: { items: [1, 2] } });
    expect(store.get<any>("x").items).toEqual([3, 4]);
  });

  it("throws on get for unregistered plugin", () => {
    const { deps } = makeDeps();
    const store = createStore(deps);
    expect(() => store.get("missing")).toThrow(/not registered/);
  });

  it("validation failure on boot falls back to defaults and logs", () => {
    const logs: string[] = [];
    const { deps, fs } = makeDeps({ log: (m) => logs.push(m) });
    fs.files.set(deps.homePath, JSON.stringify({ plugins: { x: { n: -1 } } }));
    const store = createStore(deps);
    store.register({
      plugin: "x",
      defaults: { n: 5 },
      schema: { n: { type: "number", min: 0 } },
    });
    expect(store.get<{ n: number }>("x")).toEqual({ n: 5 });
    expect(logs.join("\n")).toMatch(/x.*validation/i);
  });
});

describe("store — set", () => {
  it("writes the partial to home by default", async () => {
    const { deps, fs } = makeDeps();
    const store = createStore(deps);
    store.register({ plugin: "x", defaults: { a: 1 } });
    await store.set("x", { a: 2 });
    const written = JSON.parse(fs.files.get(deps.homePath)!);
    expect(written.plugins.x).toEqual({ a: 2 });
  });

  it("writes to project when scope=project", async () => {
    const { deps, fs } = makeDeps();
    const store = createStore(deps);
    store.register({ plugin: "x", defaults: { a: 1 } });
    await store.set("x", { a: 9 }, "project");
    expect(fs.files.get(deps.projectPath)).toBeDefined();
    expect(fs.files.get(deps.homePath)).toBeUndefined();
  });

  it("re-validates merged value and rejects invalid set", async () => {
    const { deps } = makeDeps();
    const store = createStore(deps);
    store.register({
      plugin: "x",
      defaults: { n: 1 },
      schema: { n: { type: "number", min: 0 } },
    });
    await expect(store.set("x", { n: -5 })).rejects.toThrow(/validation/i);
  });
});

describe("store — watch", () => {
  it("fires callback when a layer changes", () => {
    const fired: any[] = [];
    const { deps, fs } = makeDeps();
    const store = createStore(deps);
    store.register({ plugin: "x", defaults: { a: 1 } });
    store.watch<{ a: number }>("x", (v) => fired.push(v));
    fs.files.set(deps.homePath, JSON.stringify({ plugins: { x: { a: 7 } } }));
    (deps as any).fireWatch(deps.homePath);
    expect(fired).toEqual([{ a: 7 }]);
  });

  it("does not fire when validation fails", () => {
    const fired: any[] = [];
    const logs: string[] = [];
    const { deps, fs } = makeDeps({ log: (m) => logs.push(m) });
    const store = createStore(deps);
    store.register({
      plugin: "x",
      defaults: { n: 1 },
      schema: { n: { type: "number", min: 0 } },
    });
    store.watch<any>("x", (v) => fired.push(v));
    fs.files.set(deps.homePath, JSON.stringify({ plugins: { x: { n: -3 } } }));
    (deps as any).fireWatch(deps.homePath);
    expect(fired).toEqual([]);
    expect(logs.join("\n")).toMatch(/validation/i);
  });

  it("returns an unsubscribe function", () => {
    const fired: any[] = [];
    const { deps, fs } = makeDeps();
    const store = createStore(deps);
    store.register({ plugin: "x", defaults: { a: 1 } });
    const off = store.watch<{ a: number }>("x", (v) => fired.push(v));
    off();
    fs.files.set(deps.homePath, JSON.stringify({ plugins: { x: { a: 9 } } }));
    (deps as any).fireWatch(deps.homePath);
    expect(fired).toEqual([]);
  });
});

describe("store — list", () => {
  it("reports per-plugin paths and existence", () => {
    const { deps, fs } = makeDeps();
    fs.files.set(deps.homePath, JSON.stringify({ plugins: {} }));
    const store = createStore(deps);
    store.register({ plugin: "x", defaults: { a: 1 } });
    const rows = store.list();
    expect(rows).toHaveLength(1);
    expect(rows[0].plugin).toBe("x");
    expect(rows[0].homeExists).toBe(true);
    expect(rows[0].projectExists).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

```sh
cd plugins/llm-config && bun test test/store.test.ts
```

Expected: FAIL with "Cannot find module '../store.ts'".

- [ ] **Step 3: Implement `store.ts`**

```ts
// plugins/llm-config/store.ts
import type {
  ConfigSpec,
  ConfigScope,
  ConfigStoreService,
  ConfigStatus,
} from "llm-contracts/public";
import { validate, type ConfigSchema } from "./schema.ts";
import { applyEnvOverrides, type ResolutionSource } from "./envvars.ts";
import { atomicWriteJson, mergePluginSection, type HarnessConfigFile } from "./atomic-write.ts";

export interface StoreDeps {
  homePath: string;
  projectPath: string;
  readFile: (path: string) => string;          // throws ENOENT when missing
  writeFile: (path: string, value: unknown) => void;
  watchFile: (path: string, cb: () => void) => () => void;
  env: Record<string, string | undefined>;
  log: (msg: string) => void;
}

interface Entry {
  spec: ConfigSpec<unknown>;
  cachedValue: unknown;
  cachedResolution: Record<string, ResolutionSource>;
  watchers: Set<(v: unknown) => void>;
  unwatch?: () => void;
}

export function createStore(deps: StoreDeps): ConfigStoreService {
  const entries = new Map<string, Entry>();
  let homeFile = safeRead(deps, deps.homePath);
  let projectFile = safeRead(deps, deps.projectPath);

  const recomputeAll = () => {
    homeFile = safeRead(deps, deps.homePath);
    projectFile = safeRead(deps, deps.projectPath);
    for (const [name, entry] of entries) {
      const { value, resolution, ok } = resolve(name, entry.spec, homeFile, projectFile, deps);
      if (!ok) continue;
      entry.cachedValue = value;
      entry.cachedResolution = resolution;
      for (const cb of entry.watchers) cb(value);
    }
  };

  const watchHome = deps.watchFile(deps.homePath, recomputeAll);
  const watchProject = deps.watchFile(deps.projectPath, recomputeAll);
  // teardown handled by index.ts on plugin teardown (it calls store.teardown())
  void watchHome; void watchProject;

  return {
    register<T>(spec: ConfigSpec<T>): void {
      if (entries.has(spec.plugin)) {
        throw new Error(`llm-config: plugin '${spec.plugin}' already registered`);
      }
      const { value, resolution } = resolve(spec.plugin, spec as ConfigSpec<unknown>, homeFile, projectFile, deps);
      entries.set(spec.plugin, {
        spec: spec as ConfigSpec<unknown>,
        cachedValue: value,
        cachedResolution: resolution,
        watchers: new Set(),
      });
    },
    get<T>(plugin: string): T {
      const e = entries.get(plugin);
      if (!e) throw new Error(`llm-config: plugin '${plugin}' is not registered`);
      return e.cachedValue as T;
    },
    async set<T>(plugin: string, partial: Partial<T>, scope: ConfigScope = "home"): Promise<void> {
      const e = entries.get(plugin);
      if (!e) throw new Error(`llm-config: plugin '${plugin}' is not registered`);
      const path = scope === "home" ? deps.homePath : deps.projectPath;
      const current = scope === "home" ? homeFile : projectFile;
      const next = mergePluginSection(current, plugin, partial as Record<string, unknown>);
      // Pre-validate the resulting merged value
      const probeHome = scope === "home" ? next : homeFile;
      const probeProject = scope === "project" ? next : projectFile;
      const { ok, errors } = resolve(plugin, e.spec, probeHome, probeProject, deps);
      if (!ok) {
        throw new Error(
          `llm-config: validation failed for '${plugin}': ${errors!.map((e) => `${e.path}: ${e.message}`).join("; ")}`,
        );
      }
      atomicWriteJson(path, next);
      if (scope === "home") homeFile = next; else projectFile = next;
      // Recompute and notify
      const r = resolve(plugin, e.spec, homeFile, projectFile, deps);
      e.cachedValue = r.value;
      e.cachedResolution = r.resolution;
      for (const cb of e.watchers) cb(r.value);
    },
    watch<T>(plugin: string, cb: (v: T) => void): () => void {
      const e = entries.get(plugin);
      if (!e) throw new Error(`llm-config: plugin '${plugin}' is not registered`);
      e.watchers.add(cb as (v: unknown) => void);
      return () => { e.watchers.delete(cb as (v: unknown) => void); };
    },
    list(): ConfigStatus[] {
      return [...entries.entries()].map(([plugin, e]) => ({
        plugin,
        homePath: deps.homePath,
        projectPath: deps.projectPath,
        homeExists: Object.keys(homeFile.plugins).length > 0 || hasSection(homeFile, plugin),
        projectExists: hasSection(projectFile, plugin),
        resolution: e.cachedResolution,
      }));
    },
  };
}

function hasSection(file: HarnessConfigFile, plugin: string): boolean {
  return Boolean(file.plugins && plugin in file.plugins);
}

function safeRead(deps: StoreDeps, path: string): HarnessConfigFile {
  try {
    const raw = deps.readFile(path);
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { plugins: {} };
    return { plugins: {}, ...parsed, plugins: parsed.plugins ?? {} };
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      deps.log(`llm-config: failed to read ${path}: ${err.message}`);
    }
    return { plugins: {} };
  }
}

interface ResolveResult {
  ok: boolean;
  value: unknown;
  resolution: Record<string, ResolutionSource>;
  errors?: { path: string; message: string }[];
}

function resolve(
  plugin: string,
  spec: ConfigSpec<unknown>,
  homeFile: HarnessConfigFile,
  projectFile: HarnessConfigFile,
  deps: StoreDeps,
): ResolveResult {
  const homeSection = homeFile.plugins?.[plugin];
  const projectSection = projectFile.plugins?.[plugin];
  const merged = mergeLayers(spec.defaults as Record<string, unknown>, homeSection, projectSection);
  const resolution = pickResolution(spec.defaults as Record<string, unknown>, homeSection, projectSection);
  const { value: withEnv, resolution: finalRes } = applyEnvOverrides(
    merged,
    spec.schema as ConfigSchema<unknown> | undefined,
    spec.envVars as Record<string, string> | undefined,
    deps.env,
    resolution,
  );
  if (spec.schema) {
    const r = validate(withEnv, spec.schema as ConfigSchema<unknown>);
    if (!r.ok) {
      deps.log(
        `llm-config: validation failed for '${plugin}': ${r.errors.map((e) => `${e.path}: ${e.message}`).join("; ")} — using defaults`,
      );
      return { ok: false, value: spec.defaults, resolution: defaultResolution(spec.defaults as Record<string, unknown>), errors: r.errors };
    }
  }
  return { ok: true, value: withEnv, resolution: finalRes };
}

function mergeLayers(
  defaults: Record<string, unknown>,
  home?: Record<string, unknown>,
  project?: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...defaults };
  for (const layer of [home, project]) {
    if (!layer) continue;
    for (const [k, v] of Object.entries(layer)) {
      const prev = out[k];
      if (isPlainObject(prev) && isPlainObject(v)) {
        out[k] = { ...prev, ...v };
      } else {
        out[k] = v;
      }
    }
  }
  return out;
}

function pickResolution(
  defaults: Record<string, unknown>,
  home?: Record<string, unknown>,
  project?: Record<string, unknown>,
): Record<string, ResolutionSource> {
  const out: Record<string, ResolutionSource> = {};
  for (const k of Object.keys(defaults)) out[k] = "default";
  if (home) for (const k of Object.keys(home)) out[k] = "home";
  if (project) for (const k of Object.keys(project)) out[k] = "project";
  return out;
}

function defaultResolution(defaults: Record<string, unknown>): Record<string, ResolutionSource> {
  const out: Record<string, ResolutionSource> = {};
  for (const k of Object.keys(defaults)) out[k] = "default";
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
```

- [ ] **Step 4: Run tests, expect green**

```sh
cd plugins/llm-config && bun test test/store.test.ts
```

Expected: PASS, ~14 tests.

- [ ] **Step 5: Commit**

```sh
git add plugins/llm-config/store.ts plugins/llm-config/test/store.test.ts
git commit -m "feat(llm-config): store (load/merge/get/set/watch)"
```

---

## Task 8: Wire `index.ts` (plugin entry) + real fs deps

**Files:**
- Modify: `plugins/llm-config/index.ts`

- [ ] **Step 1: Replace the scaffolded `index.ts` with the wired version**

```ts
// plugins/llm-config/index.ts
import type { KaizenPlugin } from "kaizen/types";
import type { ConfigStoreService, SlashRegistryService } from "llm-contracts/public";
import { homedir } from "node:os";
import { readFileSync, watch } from "node:fs";
import { harnessKey, homeConfigPath, projectConfigPath, type HarnessIdentity } from "./paths.ts";
import { atomicWriteJson } from "./atomic-write.ts";
import { createStore, type StoreDeps } from "./store.ts";
import { registerSlashCommands } from "./slash.ts";

const plugin: KaizenPlugin = {
  name: "llm-config",
  apiVersion: "3.0.0",
  permissions: {
    tier: "scoped",
    fs: {
      read: ["~/.kaizen/harnesses/**", "./.kaizen/harnesses/**"],
      write: ["~/.kaizen/harnesses/**", "./.kaizen/harnesses/**"],
    },
  },
  services: {
    provides: ["config:store"],
    consumes: ["slash:registry"],
  },

  async setup(ctx) {
    const home = homedir();
    const cwd = process.cwd();
    const identity = ((ctx as { harness?: HarnessIdentity }).harness) ?? {};
    const key = harnessKey(identity);
    const homePath = homeConfigPath(home, key);
    const projectPath = projectConfigPath(cwd, key);

    const teardowns: Array<() => void> = [];

    const deps: StoreDeps = {
      homePath,
      projectPath,
      readFile: (p) => readFileSync(p, "utf8"),
      writeFile: (p, v) => atomicWriteJson(p, v),
      watchFile: (p, cb) => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const fire = () => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(cb, 150);
        };
        try {
          const w = watch(p, { persistent: false }, fire);
          // also watch the directory so newly-created files fire
          const dirWatcher = watch(p.replace(/\/[^/]+$/, ""), { persistent: false }, fire);
          return () => { w.close(); dirWatcher.close(); if (timer) clearTimeout(timer); };
        } catch {
          // Path or dir may not exist yet; degrade silently. fs.watch will be
          // retried only after a successful read introduces the path. For v0
          // we accept that newly-created config files require a restart.
          return () => {};
        }
      },
      env: process.env as Record<string, string | undefined>,
      log: ctx.log.bind(ctx),
    };

    const store = createStore(deps);
    ctx.provideService<ConfigStoreService>("config:store", store);

    try {
      const slash = ctx.useService<SlashRegistryService>("slash:registry");
      teardowns.push(...registerSlashCommands(slash, {
        store,
        homePath,
        projectPath,
        harnessKey: key,
        editor: process.env.EDITOR ?? "vi",
        log: ctx.log.bind(ctx),
      }));
    } catch (err) {
      ctx.log(`llm-config: slash:registry unavailable (${(err as Error).message}); /config commands disabled`);
    }

    return async () => {
      for (const off of teardowns) {
        try { off(); } catch { /* ignore */ }
      }
    };
  },
};

export default plugin;
```

- [ ] **Step 2: Commit**

```sh
git add plugins/llm-config/index.ts
git commit -m "feat(llm-config): wire plugin entry + fs.watch deps"
```

---

## Task 9: Implement `slash.ts` (/config commands) — TDD

**Files:**
- Create: `plugins/llm-config/slash.ts`
- Create: `plugins/llm-config/test/slash.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// plugins/llm-config/test/slash.test.ts
import { describe, it, expect } from "bun:test";
import { registerSlashCommands, type SlashRegistryLike, type SlashDeps } from "../slash.ts";
import type { ConfigStoreService } from "llm-contracts/public";

function makeRegistry() {
  const registered: { manifest: any; handler: any }[] = [];
  const reg: SlashRegistryLike = {
    register(manifest, handler) {
      registered.push({ manifest, handler });
      return () => {
        const i = registered.findIndex((r) => r.manifest.name === manifest.name);
        if (i >= 0) registered.splice(i, 1);
      };
    },
  };
  return { reg, registered };
}

function makeStore(over: Partial<ConfigStoreService> = {}): ConfigStoreService {
  return {
    register: () => {},
    get: (p: string) => ({ x: 1, plugin: p }),
    set: async () => {},
    watch: () => () => {},
    list: () => [{
      plugin: "openai-llm",
      homePath: "/h/config.json",
      projectPath: "/p/config.json",
      homeExists: true,
      projectExists: false,
      resolution: { baseUrl: "home", apiKey: "env" },
    }],
    ...over,
  } as ConfigStoreService;
}

function makeDeps(over: Partial<SlashDeps> = {}): SlashDeps {
  return {
    store: makeStore(),
    homePath: "/h/config.json",
    projectPath: "/p/config.json",
    harnessKey: "default",
    editor: "vi",
    log: () => {},
    spawnEditor: () => Promise.resolve(0),
    ...over,
  };
}

const call = async (handler: any, args = "") => {
  const lines: string[] = [];
  await handler({ args, print: async (t: string) => { lines.push(t); } });
  return lines.join("\n");
};

describe("/config list", () => {
  it("registers and prints the list", async () => {
    const { reg, registered } = makeRegistry();
    registerSlashCommands(reg, makeDeps());
    const cmd = registered.find((r) => r.manifest.name === "config:list");
    expect(cmd).toBeDefined();
    const out = await call(cmd!.handler);
    expect(out).toMatch(/openai-llm/);
  });
});

describe("/config get", () => {
  it("prints merged value for a plugin", async () => {
    const { reg, registered } = makeRegistry();
    registerSlashCommands(reg, makeDeps());
    const cmd = registered.find((r) => r.manifest.name === "config:get")!;
    const out = await call(cmd.handler, "openai-llm");
    expect(out).toMatch(/"x":\s*1/);
  });
});

describe("/config set", () => {
  it("parses scalar value and calls store.set with home scope by default", async () => {
    const calls: any[] = [];
    const { reg, registered } = makeRegistry();
    registerSlashCommands(reg, makeDeps({
      store: makeStore({ set: async (p, v, s) => { calls.push({ p, v, s }); } }),
    }));
    const cmd = registered.find((r) => r.manifest.name === "config:set")!;
    await call(cmd.handler, "openai-llm defaultModel=gpt-4");
    expect(calls).toEqual([{ p: "openai-llm", v: { defaultModel: "gpt-4" }, s: "home" }]);
  });

  it("uses project scope with --project flag", async () => {
    const calls: any[] = [];
    const { reg, registered } = makeRegistry();
    registerSlashCommands(reg, makeDeps({
      store: makeStore({ set: async (p, v, s) => { calls.push({ p, v, s }); } }),
    }));
    const cmd = registered.find((r) => r.manifest.name === "config:set")!;
    await call(cmd.handler, "openai-llm defaultModel=gpt-4 --project");
    expect(calls[0].s).toBe("project");
  });

  it("parses number-like values as numbers", async () => {
    const calls: any[] = [];
    const { reg, registered } = makeRegistry();
    registerSlashCommands(reg, makeDeps({
      store: makeStore({ set: async (p, v, s) => { calls.push({ p, v, s }); } }),
    }));
    const cmd = registered.find((r) => r.manifest.name === "config:set")!;
    await call(cmd.handler, "openai-llm defaultTemperature=0.5");
    expect(calls[0].v).toEqual({ defaultTemperature: 0.5 });
  });

  it("supports dotted key path (retry.maxAttempts=5)", async () => {
    const calls: any[] = [];
    const { reg, registered } = makeRegistry();
    registerSlashCommands(reg, makeDeps({
      store: makeStore({ set: async (p, v) => { calls.push({ p, v }); } }),
    }));
    const cmd = registered.find((r) => r.manifest.name === "config:set")!;
    await call(cmd.handler, "openai-llm retry.maxAttempts=5");
    expect(calls[0].v).toEqual({ retry: { maxAttempts: 5 } });
  });
});

describe("/config edit", () => {
  it("invokes the configured editor on the home path by default", async () => {
    const invocations: any[] = [];
    const { reg, registered } = makeRegistry();
    registerSlashCommands(reg, makeDeps({
      spawnEditor: async (editor, path) => { invocations.push({ editor, path }); return 0; },
    }));
    const cmd = registered.find((r) => r.manifest.name === "config:edit")!;
    await call(cmd.handler);
    expect(invocations).toEqual([{ editor: "vi", path: "/h/config.json" }]);
  });

  it("opens the project path with --project", async () => {
    const invocations: any[] = [];
    const { reg, registered } = makeRegistry();
    registerSlashCommands(reg, makeDeps({
      spawnEditor: async (editor, path) => { invocations.push({ editor, path }); return 0; },
    }));
    const cmd = registered.find((r) => r.manifest.name === "config:edit")!;
    await call(cmd.handler, "--project");
    expect(invocations[0].path).toBe("/p/config.json");
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

```sh
cd plugins/llm-config && bun test test/slash.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement `slash.ts`**

```ts
// plugins/llm-config/slash.ts
import type { ConfigStoreService, SlashCommandManifest, SlashCommandHandler } from "llm-contracts/public";

export interface SlashRegistryLike {
  register(manifest: SlashCommandManifest, handler: SlashCommandHandler): () => void;
}

export interface SlashDeps {
  store: ConfigStoreService;
  homePath: string;
  projectPath: string;
  harnessKey: string;
  editor: string;
  log: (msg: string) => void;
  spawnEditor: (editor: string, path: string) => Promise<number>;
}

export function registerSlashCommands(reg: SlashRegistryLike, deps: SlashDeps): Array<() => void> {
  const offs: Array<() => void> = [];

  offs.push(reg.register(
    {
      name: "config:list",
      description: "List registered plugin configs and their resolution paths.",
      source: "plugin",
    },
    async (ctx) => {
      const rows = deps.store.list();
      if (rows.length === 0) return ctx.print("No plugins registered with config:store.");
      const lines = rows.map((r) =>
        `${r.plugin}  home=${r.homeExists ? "yes" : "no"}  project=${r.projectExists ? "yes" : "no"}`,
      );
      lines.push("", `Harness: ${deps.harnessKey}`, `Home: ${deps.homePath}`, `Project: ${deps.projectPath}`);
      await ctx.print(lines.join("\n"));
    },
  ));

  offs.push(reg.register(
    {
      name: "config:get",
      description: "Print the merged config for a plugin. Usage: /config:get <plugin> [key.path]",
      source: "plugin",
    },
    async (ctx) => {
      const [plugin, keyPath] = ctx.args.trim().split(/\s+/);
      if (!plugin) return ctx.print("Usage: /config:get <plugin> [key.path]");
      let value: unknown;
      try { value = deps.store.get(plugin); }
      catch (err) { return ctx.print(`Error: ${(err as Error).message}`); }
      if (keyPath) {
        value = keyPath.split(".").reduce<any>((v, k) => (v == null ? v : v[k]), value);
      }
      await ctx.print(JSON.stringify(value, null, 2));
    },
  ));

  offs.push(reg.register(
    {
      name: "config:set",
      description: "Set a config value. Usage: /config:set <plugin> <key>=<value> [--project]",
      source: "plugin",
    },
    async (ctx) => {
      const tokens = ctx.args.trim().split(/\s+/);
      const scope = tokens.includes("--project") ? "project" : "home";
      const rest = tokens.filter((t) => t !== "--project");
      const plugin = rest.shift();
      const kv = rest.join(" ");
      if (!plugin || !kv.includes("=")) {
        return ctx.print("Usage: /config:set <plugin> <key>=<value> [--project]");
      }
      const eqIdx = kv.indexOf("=");
      const key = kv.slice(0, eqIdx);
      const raw = kv.slice(eqIdx + 1);
      const value = parseSlashValue(raw);
      const partial = buildDottedPath(key, value);
      try {
        await deps.store.set(plugin, partial as any, scope);
        await ctx.print(`Updated ${plugin}.${key} (${scope}).`);
      } catch (err) {
        await ctx.print(`Error: ${(err as Error).message}`);
      }
    },
  ));

  offs.push(reg.register(
    {
      name: "config:edit",
      description: "Open the harness config file in $EDITOR. Usage: /config:edit [--project]",
      source: "plugin",
    },
    async (ctx) => {
      const useProject = ctx.args.trim() === "--project";
      const path = useProject ? deps.projectPath : deps.homePath;
      try {
        const code = await deps.spawnEditor(deps.editor, path);
        await ctx.print(code === 0 ? `Saved ${path}` : `Editor exited with code ${code}; not reloaded.`);
      } catch (err) {
        await ctx.print(`Error: ${(err as Error).message}`);
      }
    },
  ));

  return offs;
}

function parseSlashValue(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  const asNumber = Number(raw);
  if (raw.trim() !== "" && Number.isFinite(asNumber) && raw.match(/^-?\d+(\.\d+)?$/)) return asNumber;
  // Strip optional surrounding quotes
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  return raw;
}

function buildDottedPath(key: string, value: unknown): Record<string, unknown> {
  const parts = key.split(".");
  if (parts.length === 1) return { [parts[0]!]: value };
  const out: Record<string, unknown> = {};
  let cur: Record<string, unknown> = out;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]!;
    cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
  return out;
}
```

Also create a real `spawnEditor` in `index.ts` — Task 8's stub doesn't include it. Add to `index.ts` and pass through:

```ts
// in index.ts setup(), within the slash try block:
import { spawn } from "node:child_process";
// ...
spawnEditor: (editor, path) => new Promise<number>((resolve, reject) => {
  const child = spawn(editor, [path], { stdio: "inherit" });
  child.on("exit", (code) => resolve(code ?? 0));
  child.on("error", reject);
}),
```

(Edit `index.ts` to add this. The plan's Task 8 left it as a TODO; this finishes it.)

- [ ] **Step 4: Run tests, expect green**

```sh
cd plugins/llm-config && bun test test/slash.test.ts
```

Expected: PASS, ~8 tests.

- [ ] **Step 5: Run the full plugin test suite**

```sh
cd plugins/llm-config && bun test
```

Expected: PASS, all tests across all files.

- [ ] **Step 6: Commit**

```sh
git add plugins/llm-config/slash.ts plugins/llm-config/test/slash.test.ts plugins/llm-config/index.ts
git commit -m "feat(llm-config): /config slash commands + editor shell-out"
```

---

## Task 10: `kaizen plugin validate` + marketplace + harness manifest

**Files:**
- Modify: `.kaizen/marketplace.json`
- Modify: `harnesses/openai-compatible.json`

- [ ] **Step 1: Validate the new plugin**

```sh
kaizen plugin validate plugins/llm-config
```

Expected: pass (no errors). If it fails, read the error, fix the manifest, retry.

- [ ] **Step 2: Add `llm-config` entry to `.kaizen/marketplace.json`**

Open `.kaizen/marketplace.json`. Find the `entries` array. Add (alphabetically near the other `llm-*` entries):

```json
{
  "kind": "plugin",
  "name": "llm-config",
  "description": "Harness-scoped plugin configuration store. Provides config:store.",
  "categories": ["foundation", "config"],
  "versions": [{ "version": "0.1.0", "source": { "type": "file", "path": "plugins/llm-config" } }]
}
```

Also bump the `llm-contracts` version entry to `0.2.0` (added in Task 1):

```json
{ "version": "0.2.0", "source": { "type": "file", "path": "plugins/llm-contracts" } }
```

(Keep the `0.1.0` entry as well so other consumers can pin if needed during transition; the harness will use `0.2.0`.)

- [ ] **Step 3: Update `harnesses/openai-compatible.json`**

Replace the contents with the version list below. `llm-contracts@0.2.0` (was 0.1.0), insert `llm-config@0.1.0` immediately after:

```json
{
  "plugins": [
    "official/llm-contracts@0.2.0",
    "official/llm-config@0.1.0",
    "official/llm-events@0.7.0",
    "official/llm-session-manager@0.1.1",
    "official/llm-tools-registry@0.3.0",
    "official/openai-llm@0.1.0",
    "official/llm-system-prompt@0.1.0",
    "official/llm-slash-commands@0.2.1",
    "official/llm-tui@0.2.0",
    "official/llm-native-dispatch@0.3.1",
    "official/llm-driver@0.2.1",
    "official/llm-local-tools@0.2.0",
    "official/llm-tavily-search@0.1.0",
    "official/llm-mcp-bridge@0.1.2",
    "official/llm-skills@0.1.2",
    "official/llm-memory@0.1.2",
    "official/llm-codemode@0.3.0",
    "official/llm-agents@0.2.1",
    "official/llm-status-items@0.1.1",
    "official/llm-hooks-shell@0.1.1",
    "official/llm-tool-approval@0.1.0"
  ]
}
```

Plugin version bumps for the nine migrating plugins come in their respective tasks; this commit only adds the new plugins. The `harnesses/openai-compatible.json` file will be re-touched at the end of each migration task to bump the migrated plugin's version (or batched at Task 23 — pick one and stick with it; recommended: batch in Task 23).

- [ ] **Step 4: Local-deploy `llm-contracts` and `llm-config`**

```sh
PLUGIN=llm-contracts
VERSION=$(jq -r .version plugins/$PLUGIN/package.json)
INSTALL_DIR=~/.kaizen/marketplaces/official/plugins/${PLUGIN}@${VERSION}
(cd plugins/$PLUGIN && bun build --target=bun --outfile=dist/index.js index.ts)
mkdir -p "$INSTALL_DIR/dist"
cp plugins/$PLUGIN/dist/index.js "$INSTALL_DIR/dist/index.js"
rsync -a --exclude='node_modules' --exclude='dist' plugins/$PLUGIN/ "$INSTALL_DIR/"

PLUGIN=llm-config
VERSION=$(jq -r .version plugins/$PLUGIN/package.json)
INSTALL_DIR=~/.kaizen/marketplaces/official/plugins/${PLUGIN}@${VERSION}
(cd plugins/$PLUGIN && bun build --target=bun --outfile=dist/index.js index.ts)
mkdir -p "$INSTALL_DIR/dist"
cp plugins/$PLUGIN/dist/index.js "$INSTALL_DIR/dist/index.js"
rsync -a --exclude='node_modules' --exclude='dist' plugins/$PLUGIN/ "$INSTALL_DIR/"
```

- [ ] **Step 5: Boot the harness; confirm no errors before any consumer migrates**

```sh
kaizen --harness ./harnesses/openai-compatible.json
```

Existing plugins still read their own config files; the new plugin provides `config:store` but nobody consumes it yet. The harness should boot identically to before. Exit immediately (Ctrl+C).

- [ ] **Step 6: Commit**

```sh
git add .kaizen/marketplace.json harnesses/openai-compatible.json
git commit -m "chore: register llm-config@0.1.0 + llm-contracts@0.2.0 in marketplace + harness"
```

---

## Tasks 11–19: Migrate consumer plugins

Each migration task: follow the Migration Recipe above. The task body shows the **register() call** specific to that plugin — that's the load-bearing change. The deletes and version bump are mechanical.

Before starting any migration, re-read the recipe at the top of this document.

---

## Task 11: Migrate `openai-llm`

**Files:**
- Modify: `plugins/openai-llm/index.ts`
- Modify: `plugins/openai-llm/package.json` (add `llm-config` dep, bump version 0.1.0 → 0.1.1)
- Delete: `plugins/openai-llm/config.ts`
- Delete: `plugins/openai-llm/test/config.test.ts`

- [ ] **Step 1: Add `llm-config` to dependencies**

In `plugins/openai-llm/package.json`, add to `dependencies`: `"llm-config": "workspace:*"`. Bump `version` to `0.1.1`.

- [ ] **Step 2: Read the current `config.ts` to capture defaults + validation**

```sh
cat plugins/openai-llm/config.ts
```

Capture: `DEFAULT_CONFIG`, the `validate()` rules. These become the schema.

- [ ] **Step 3: Update `index.ts` to use the service**

Read `plugins/openai-llm/index.ts`, find the existing `loadConfig(...)` call in `setup()`. Replace with:

```ts
import type { ConfigStoreService } from "llm-contracts/public";

// In services declaration:
//   consumes: [..., "config:store"]

// In setup(ctx):
ctx.consumeService("config:store");
const config = ctx.useService<ConfigStoreService>("config:store");
config.register({
  plugin: "openai-llm",
  defaults: {
    baseUrl: "http://localhost:1234/v1",
    apiKey: "",
    defaultModel: "local-model",
    defaultTemperature: 0.7,
    requestTimeoutMs: 120000,
    connectTimeoutMs: 10000,
    retry: { maxAttempts: 3, initialDelayMs: 500, maxDelayMs: 8000, jitter: "full" },
    extraHeaders: {},
  },
  schema: {
    baseUrl: { type: "string", min: 1 },
    apiKey: { type: "string" },
    defaultModel: { type: "string", min: 1 },
    defaultTemperature: { type: "number" },
    requestTimeoutMs: { type: "number", min: 1 },
    connectTimeoutMs: { type: "number", min: 1 },
    retry: {
      type: "object",
      properties: {
        maxAttempts: { type: "number", integer: true, min: 1 },
        initialDelayMs: { type: "number", min: 0 },
        maxDelayMs: { type: "number", min: 0 },
        jitter: { type: "enum", values: ["full", "none"] },
      },
    },
    extraHeaders: { type: "object", properties: {}, additionalProperties: { type: "string" } },
  },
  envVars: { apiKey: "OPENAI_API_KEY" },
});
const cfg = config.get<OpenAILLMConfig>("openai-llm");
```

Keep the `OpenAILLMConfig` type local (in `public.d.ts` or inline). All downstream code that previously used the loader's return value now uses `cfg`.

- [ ] **Step 4: Delete the old loader + test**

```sh
rm plugins/openai-llm/config.ts plugins/openai-llm/test/config.test.ts
```

If any other module in the plugin imports from `./config.ts`, replace those imports with the local type definition (move `OpenAILLMConfig` to `public.d.ts` and import from there).

- [ ] **Step 5: Run the plugin's tests**

```sh
cd plugins/openai-llm && bun test
```

Update any failing tests that mocked the old loader. Inject a stub `ConfigStoreService` where needed.

Expected: PASS.

- [ ] **Step 6: Validate the plugin**

```sh
kaizen plugin validate plugins/openai-llm
```

Expected: pass.

- [ ] **Step 7: Commit**

```sh
git add plugins/openai-llm/
git commit -m "refactor(openai-llm): consume config:store"
```

---

## Task 12: Migrate `llm-codemode`

**Files:**
- Modify: `plugins/llm-codemode/index.ts`, `package.json` (bump 0.3.0 → 0.3.1)
- Delete: `plugins/llm-codemode/config.ts`, `plugins/llm-codemode/test/config.test.ts`

- [ ] **Step 1: Update `package.json`** — add `"llm-config": "workspace:*"`, bump version.

- [ ] **Step 2: Replace `loadConfig` in `index.ts` with `register` + `get`**

```ts
config.register({
  plugin: "llm-codemode",
  defaults: {
    timeoutMs: 30000,
    maxStdoutBytes: 16384,
    maxReturnBytes: 4096,
    sandbox: "bun-worker",
  },
  schema: {
    timeoutMs: { type: "number", min: 1 },
    maxStdoutBytes: { type: "number", min: 1 },
    maxReturnBytes: { type: "number", min: 1 },
    sandbox: { type: "enum", values: ["bun-worker"] },
  },
});
const cfg = config.get<CodeModeConfig>("llm-codemode");
```

- [ ] **Step 3: Delete `config.ts` + test. Run plugin tests. Validate. Commit.**

```sh
rm plugins/llm-codemode/config.ts plugins/llm-codemode/test/config.test.ts
cd plugins/llm-codemode && bun test
kaizen plugin validate plugins/llm-codemode
cd ../.. && git add plugins/llm-codemode/ && git commit -m "refactor(llm-codemode): consume config:store"
```

---

## Task 13: Migrate `llm-memory`

**Files:**
- Modify: `plugins/llm-memory/index.ts`, `package.json` (bump 0.1.2 → 0.1.3)
- Delete: `plugins/llm-memory/config.ts`, `plugins/llm-memory/test/config.test.ts`

- [ ] **Step 1: Update `package.json`** — add `"llm-config": "workspace:*"`, bump version.

- [ ] **Step 2: Replace the loader call in `index.ts`**

```ts
config.register({
  plugin: "llm-memory",
  defaults: {
    globalDir: null,
    projectDir: null,
    injectionByteCap: 2048,
    autoExtract: false,
    extractTriggers: ["from now on", "remember that", "always", "never", "i prefer", "my "],
    denyTypes: [],
    staleTempMs: 60000,
  },
  schema: {
    injectionByteCap: { type: "number", min: 0 },
    autoExtract: { type: "boolean" },
    extractTriggers: { type: "array", items: { type: "string" } },
    denyTypes: { type: "array", items: { type: "enum", values: ["user", "feedback", "project", "reference"] } },
    staleTempMs: { type: "number", min: 0 },
  },
});
const cfg = config.get<MemoryConfig>("llm-memory");
```

Note: `globalDir`/`projectDir` fields keep their `string | null` type but are not strictly validated by the schema — the validator allows unknown top-level keys. If stricter typing is wanted, omit them from the schema (current approach) and rely on the type signature.

- [ ] **Step 3: Delete config.ts + test, run tests, validate, commit.**

```sh
rm plugins/llm-memory/config.ts plugins/llm-memory/test/config.test.ts
cd plugins/llm-memory && bun test
kaizen plugin validate plugins/llm-memory
cd ../.. && git add plugins/llm-memory/ && git commit -m "refactor(llm-memory): consume config:store"
```

---

## Task 14: Migrate `llm-mcp-bridge`

**Files:**
- Modify: `plugins/llm-mcp-bridge/index.ts`, `package.json` (bump 0.1.2 → 0.1.3)
- Delete: `plugins/llm-mcp-bridge/config.ts` (or trim — see below)
- Delete: `plugins/llm-mcp-bridge/test/config.test.ts`

**Special:** mcp-bridge's config is a `servers` map keyed by name. It also does `${env:FOO}` interpolation per-field. That interpolation is plugin-specific (not the same as `envVars` overrides). Keep the interpolation logic; only the loading + path resolution moves to `config:store`.

- [ ] **Step 1: Update `package.json`** — add dep, bump.

- [ ] **Step 2: Replace the loader**

```ts
config.register({
  plugin: "llm-mcp-bridge",
  defaults: { servers: {} as Record<string, ServerConfig> },
  schema: {
    servers: {
      type: "object",
      properties: {},
      additionalProperties: {
        type: "object",
        properties: {
          transport: { type: "enum", values: ["stdio", "sse", "http"] },
          enabled: { type: "boolean" },
          timeoutMs: { type: "number", min: 1 },
          healthCheckMs: { type: "number", min: 1 },
        },
        additionalProperties: true,
      },
    },
  },
});
const cfg = config.get<{ servers: Record<string, ServerConfig> }>("llm-mcp-bridge");
const resolved = resolveServers(cfg.servers, process.env);  // existing interpolation logic
```

If `ResolvedServerConfig` and the interpolation function live in the deleted `config.ts`, move them to a new `plugins/llm-mcp-bridge/servers.ts` first (commit that move separately if you want a clean history, or fold into this task).

- [ ] **Step 3: Delete the loader piece of `config.ts`** (keep server resolution code in a new file as noted). Delete `test/config.test.ts`.

- [ ] **Step 4: Run tests, validate, commit.**

```sh
cd plugins/llm-mcp-bridge && bun test
kaizen plugin validate plugins/llm-mcp-bridge
cd ../.. && git add plugins/llm-mcp-bridge/ && git commit -m "refactor(llm-mcp-bridge): consume config:store; keep server interpolation"
```

---

## Task 15: Migrate `llm-agents`

**Files:**
- Modify: `plugins/llm-agents/index.ts`, `package.json` (bump 0.2.1 → 0.2.2)
- Delete: `plugins/llm-agents/config.ts`, `plugins/llm-agents/test/config.test.ts`

- [ ] **Step 1: Update `package.json`** — add dep, bump.

- [ ] **Step 2: Replace the loader. `llm-agents` resolved tilde + relative paths in its loader; move that into setup() after `get()`.**

```ts
config.register({
  plugin: "llm-agents",
  defaults: {
    maxDepth: 3,
    userDir: "~/.kaizen/agents",
    projectDir: ".kaizen/agents",
  },
  schema: {
    maxDepth: { type: "number", integer: true, min: 1 },
    userDir: { type: "string", min: 1 },
    projectDir: { type: "string", min: 1 },
  },
});
const cfg = config.get<AgentsConfigFile>("llm-agents");
const resolvedUserDir = resolveDir(cfg.userDir!, home, cwd);
const resolvedProjectDir = resolveDir(cfg.projectDir!, home, cwd);
```

Move the `resolveDir` helper to a small module in the plugin (e.g. `paths.ts`) — it's still useful but separate from config loading.

- [ ] **Step 3: Delete `config.ts` + test, run tests, validate, commit.**

---

## Task 16: Migrate `llm-tavily-search`

**Files:**
- Modify: `plugins/llm-tavily-search/index.ts`, `package.json` (bump 0.1.0 → 0.1.1)
- Delete: `plugins/llm-tavily-search/config.ts`, `plugins/llm-tavily-search/test/config.test.ts`

- [ ] **Step 1: Update `package.json`** — add dep, bump.

- [ ] **Step 2: Replace the loader**

```ts
config.register({
  plugin: "llm-tavily-search",
  defaults: {
    apiKey: "",
    endpoint: "https://api.tavily.com/search",
    defaultMaxResults: 5,
    defaultSearchDepth: "basic",
    defaultIncludeAnswer: false,
    requestTimeoutMs: 30000,
  },
  schema: {
    apiKey: { type: "string" },
    endpoint: { type: "string", min: 1 },
    defaultMaxResults: { type: "number", integer: true, min: 1, max: 20 },
    defaultSearchDepth: { type: "enum", values: ["basic", "advanced"] },
    defaultIncludeAnswer: { type: "boolean" },
    requestTimeoutMs: { type: "number", min: 1 },
  },
  envVars: { apiKey: "TAVILY_API_KEY" },
});
const cfg = config.get<TavilyConfig>("llm-tavily-search");
```

- [ ] **Step 3: Delete config.ts + test, run tests, validate, commit.**

---

## Task 17: Migrate `llm-tool-approval`

**Files:**
- Modify: `plugins/llm-tool-approval/index.ts`, `package.json` (bump 0.1.0 → 0.1.1)
- Delete: `plugins/llm-tool-approval/config.ts`, `plugins/llm-tool-approval/test/config.test.ts`

**Special:** This plugin's loader uses three sources (`defaults.json` shipped with the plugin, global, project). `defaults.json` content stays bundled with the plugin and is passed as the `defaults` to `register()`. The plugin previously also wrote allow/deny rules at runtime via `appendAllowAtomic` — that becomes `config.set("llm-tool-approval", { allow: [...] })`.

- [ ] **Step 1: Update `package.json`** — add dep, bump.

- [ ] **Step 2: Replace loader + write path**

In `index.ts`:

```ts
import defaultsRaw from "./defaults.json" with { type: "json" };

config.register({
  plugin: "llm-tool-approval",
  defaults: {
    allow: Array.isArray((defaultsRaw as any).allow) ? (defaultsRaw as any).allow : [],
    deny: Array.isArray((defaultsRaw as any).deny) ? (defaultsRaw as any).deny : [],
  },
  schema: {
    allow: { type: "array", items: { type: "string" } },
    deny: { type: "array", items: { type: "string" } },
  },
});
// reads:
const { allow, deny } = config.get<{ allow: string[]; deny: string[] }>("llm-tool-approval");
// writes (replaces appendAllowAtomic):
await config.set("llm-tool-approval", { allow: dedupeSort([...allow, newRule]) }, "project");
```

Resolution choice between project and home was previously hand-rolled (`pickWriteTarget`). Now the slash side just passes `scope: "project"` if a project file exists; otherwise `"home"`. Make that decision based on `config.list()` for the plugin's row, or always default to `"project"` here since the original behavior preferred project. **Pick: always `"project"`** (matches the old behavior exactly).

- [ ] **Step 3: Update `slash.ts` of `llm-tool-approval`** — its `rulesBySource` and `writeTarget` helpers are gone. Replace with `config.list()` and direct `config.get()`. Update the slash tests accordingly.

- [ ] **Step 4: Delete `config.ts` + test, run tests, validate, commit.**

---

## Task 18: Migrate `llm-hooks-shell`

**Files:**
- Modify: `plugins/llm-hooks-shell/index.ts`, `package.json` (bump 0.1.1 → 0.1.2)
- Delete: `plugins/llm-hooks-shell/config.ts`, `plugins/llm-hooks-shell/test/config.test.ts`

**Special:** This plugin's config is an array of `HookEntry` objects (not a top-level object map). `register()` requires defaults to be an object. Wrap the array in `{ hooks: HookEntry[] }`.

- [ ] **Step 1: Update `package.json`** — add dep, bump.

- [ ] **Step 2: Replace loader**

```ts
interface HooksConfig { hooks: HookEntry[]; }

config.register<HooksConfig>({
  plugin: "llm-hooks-shell",
  defaults: { hooks: [] },
  schema: {
    hooks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          event: { type: "string", min: 1 },
          command: { type: "string", min: 1 },
          cwd: { type: "string" },
          block_on_nonzero: { type: "boolean" },
          timeout_ms: { type: "number", min: 1 },
        },
        additionalProperties: true,  // env, _source, etc.
      },
    },
  },
});
const cfg = config.get<HooksConfig>("llm-hooks-shell");
const entries: HookEntry[] = cfg.hooks;
```

The old loader merged home + project entries by concatenation. With config-store's default shallow merge, arrays are *replaced* (per the spec). To preserve concatenation, set the project layer to `{ hooks: [...home, ...project] }` — but that requires reading raw layers. Two options:

1. Accept the breaking semantics: project replaces home. Document in the plugin's README.
2. Add a tiny adapter in the plugin: read `config.list()`, manually read both files via the same path, concat the arrays, replace `cfg.hooks` accordingly.

**Pick: option 1** (replace). Cleaner; matches how the rest of the config store works. Hooks are usually defined in one place anyway.

- [ ] **Step 3: Delete config.ts + test, run tests, validate, commit.**

---

## Task 19: Migrate `llm-session-manager`

**Files:**
- Modify: `plugins/llm-session-manager/index.ts`, `package.json` (bump 0.1.1 → 0.1.2)

**Special:** This plugin doesn't have a `config.ts`. It reads `ctx.config` directly (a kaizen-injected per-plugin block). The migration adds `config:store` as a hard consumer and uses `register/get`. Update `services.consumes` accordingly. Verify by re-running the session-manager test suite (which was already deps-injected and shouldn't break).

- [ ] **Step 1: Update `package.json`** — add `"llm-config": "workspace:*"`, bump version.

- [ ] **Step 2: Update `index.ts`** — replace the `ctx.config` read:

Before:
```ts
const config = (ctx.config ?? {}) as SessionManagerConfig;
const sessionsBase = config.sessionsBase ?? join(homedir(), ".kaizen", "sessions");
```

After:
```ts
ctx.consumeService("config:store");
const cfgSvc = ctx.useService<ConfigStoreService>("config:store");
cfgSvc.register({
  plugin: "llm-session-manager",
  defaults: { sessionsBase: join(homedir(), ".kaizen", "sessions") },
  schema: { sessionsBase: { type: "string", min: 1 } },
});
const config = cfgSvc.get<SessionManagerConfig>("llm-session-manager");
const sessionsBase = config.sessionsBase;
```

Add `"config:store"` to `services.consumes`.

- [ ] **Step 3: Run tests**

```sh
cd plugins/llm-session-manager && bun test
```

Expected: PASS.

- [ ] **Step 4: Validate + commit**

```sh
kaizen plugin validate plugins/llm-session-manager
cd ../.. && git add plugins/llm-session-manager/ && git commit -m "refactor(llm-session-manager): consume config:store"
```

---

## Task 20: Update marketplace + harness to bumped versions

**Files:**
- Modify: `.kaizen/marketplace.json`
- Modify: `harnesses/openai-compatible.json`

- [ ] **Step 1: Add a new version entry to each migrated plugin's marketplace block**

For each of the 9 migrated plugins, append the new version to its `versions` array in `.kaizen/marketplace.json`. Example for openai-llm:

```json
{
  "kind": "plugin",
  "name": "openai-llm",
  ...
  "versions": [
    { "version": "0.1.0", "source": { "type": "file", "path": "plugins/openai-llm" } },
    { "version": "0.1.1", "source": { "type": "file", "path": "plugins/openai-llm" } }
  ]
}
```

Repeat for `llm-codemode` (0.3.1), `llm-memory` (0.1.3), `llm-mcp-bridge` (0.1.3), `llm-agents` (0.2.2), `llm-tavily-search` (0.1.1), `llm-tool-approval` (0.1.1), `llm-hooks-shell` (0.1.2), `llm-session-manager` (0.1.2).

- [ ] **Step 2: Update `harnesses/openai-compatible.json` to point at the bumped versions**

```json
{
  "plugins": [
    "official/llm-contracts@0.2.0",
    "official/llm-config@0.1.0",
    "official/llm-events@0.7.0",
    "official/llm-session-manager@0.1.2",
    "official/llm-tools-registry@0.3.0",
    "official/openai-llm@0.1.1",
    "official/llm-system-prompt@0.1.0",
    "official/llm-slash-commands@0.2.1",
    "official/llm-tui@0.2.0",
    "official/llm-native-dispatch@0.3.1",
    "official/llm-driver@0.2.1",
    "official/llm-local-tools@0.2.0",
    "official/llm-tavily-search@0.1.1",
    "official/llm-mcp-bridge@0.1.3",
    "official/llm-skills@0.1.2",
    "official/llm-memory@0.1.3",
    "official/llm-codemode@0.3.1",
    "official/llm-agents@0.2.2",
    "official/llm-status-items@0.1.1",
    "official/llm-hooks-shell@0.1.2",
    "official/llm-tool-approval@0.1.1"
  ]
}
```

- [ ] **Step 3: Local-deploy every bumped plugin**

```sh
for PLUGIN in llm-session-manager openai-llm llm-tavily-search llm-mcp-bridge llm-memory llm-codemode llm-agents llm-hooks-shell llm-tool-approval; do
  VERSION=$(jq -r .version plugins/$PLUGIN/package.json)
  INSTALL_DIR=~/.kaizen/marketplaces/official/plugins/${PLUGIN}@${VERSION}
  (cd plugins/$PLUGIN && bun build --target=bun --outfile=dist/index.js index.ts 2>/dev/null || bun build --target=bun --outfile=dist/index.js index.tsx)
  mkdir -p "$INSTALL_DIR/dist"
  cp plugins/$PLUGIN/dist/index.js "$INSTALL_DIR/dist/index.js"
  rsync -a --exclude='node_modules' --exclude='dist' plugins/$PLUGIN/ "$INSTALL_DIR/"
done
```

- [ ] **Step 4: Delete old per-plugin config files on dev machine**

```sh
rm -rf ~/.kaizen/plugins/openai-llm ~/.kaizen/plugins/llm-codemode ~/.kaizen/plugins/llm-memory \
       ~/.kaizen/plugins/llm-mcp-bridge ~/.kaizen/plugins/llm-agents ~/.kaizen/plugins/llm-tavily-search \
       ~/.kaizen/plugins/llm-tool-approval ~/.kaizen/plugins/llm-hooks-shell
```

- [ ] **Step 5: Run the whole repo test suite from root**

```sh
bun test
```

Expected: PASS across all plugins.

- [ ] **Step 6: Smoke test — boot the harness**

```sh
kaizen --harness ./harnesses/openai-compatible.json
```

Confirm: harness boots, no error logs about missing config, `/config:list` shows all 9 plugins registered, `/config:edit` opens an empty (default) harness config file.

If anything red, fix and re-test before committing.

- [ ] **Step 7: Commit**

```sh
git add .kaizen/marketplace.json harnesses/openai-compatible.json
git commit -m "chore: bump migrated plugins + point harness at new versions"
```

---

## Task 21: Final smoke + cleanup

- [ ] **Step 1: Use `/config:set` end-to-end**

In a live harness session:
- `/config:list` — see all rows
- `/config:set openai-llm defaultModel=test-model` — confirm "Updated openai-llm.defaultModel (home)."
- `/config:get openai-llm defaultModel` — confirm `"test-model"`
- Inspect `~/.kaizen/harnesses/local_openai-compatible/config.json` — confirm shape `{ "plugins": { "openai-llm": { "defaultModel": "test-model" } } }`
- `/config:edit` — opens the file in $EDITOR; confirm save reload works

- [ ] **Step 2: Run repo-wide tests one final time**

```sh
bun test
```

Expected: PASS.

- [ ] **Step 3: Mark TODO done**

Edit `docs/TODO.md` — remove item 1, or strike it through with the spec/plan path noted.

```sh
git add docs/TODO.md
git commit -m "docs(todo): llm-config plugin shipped"
```

---

## Self-review

**Spec coverage:**
- Contract definition ✓ Task 1
- Plugin scaffold + manifest ✓ Task 2
- Path/harness-key resolution ✓ Task 3
- Schema validator ✓ Task 4
- Env-var override ✓ Task 5
- Atomic write ✓ Task 6
- Store register/get/set/watch/list ✓ Task 7
- Plugin wiring ✓ Task 8
- Slash commands ✓ Task 9
- Marketplace + harness manifest ✓ Tasks 10, 20
- 9 plugin migrations ✓ Tasks 11–19
- Smoke test ✓ Task 21

**Placeholder scan:** no TBDs, all code blocks complete, every migration shows the specific register call.

**Type consistency:** `ConfigStoreService` signature is identical in Task 1 (definition), Task 7 (impl), Task 9 (slash deps), and every migration task. `ConfigSchema<T>`, `FieldSchema`, `ConfigScope`, `ConfigStatus`, and `ConfigSpec<T>` all match across uses.

**Notes / open follow-ups:**
- The `slash:registry` consume in `llm-config` is currently declared as hard (`services.consumes: ["slash:registry"]`) but used inside a try-catch — that's deferred-optional pattern. Task 8's setup function is correct (the try-catch lets the plugin run without slash). If `kaizen plugin validate` flags this as inconsistent, drop `"slash:registry"` from `services.consumes` (topo-hint still wanted but not strictly required).
- `llm-hooks-shell` migration changes semantics: hooks no longer accumulate across home + project. Document this in the plugin's README during Task 18.
- The plan does not version-bump `llm-events`, `llm-tools-registry`, `llm-tui`, `llm-driver`, `llm-native-dispatch`, `llm-system-prompt`, `llm-slash-commands`, `llm-skills`, `llm-local-tools`, `llm-status-items` — they don't consume config:store. Confirm during execution.
