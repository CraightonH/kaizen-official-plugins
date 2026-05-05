# llm-codemode-dispatch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Spec 5 — the `llm-codemode-dispatch` Kaizen plugin: a `tool-dispatch:strategy` provider that gives the LLM a typed `kaizen.tools.*` API rendered as `.d.ts`, extracts fenced TypeScript blocks from the response, and executes them in a Bun Worker sandbox whose tool calls proxy back to `tools:registry` via `postMessage` RPC.

**Architecture:** Microservice plugin with strict layering: `dts-render` (pure JSONSchema→TS), `extractor` (markdown AST), `wrapper` (AST trailing-expression-to-return rewrite), `sandbox-host` (Worker spawn + RPC + timeouts), `sandbox-entry` (in-worker globals curation + Proxy + console capture), `serialize` (return/stdout truncation + safe stringify), `service` (composes prepareRequest + handleResponse). Plugin reads config from `~/.kaizen/plugins/llm-codemode-dispatch/config.json`. Depends on Spec 0 (`llm-events`) types only; consumes `tools:registry` at runtime via `handleResponse` argument (NOT at setup) so it does not need to bind ordering.

**Tech Stack:** TypeScript, Bun runtime, Bun `Worker`, `Bun.Transpiler` (in-worker for AST rewrite + import-rewrite), `json-schema-to-typescript` (DTS generation), `mdast-util-from-markdown` + `mdast-util-to-string` (fenced-block extraction). Tests use `bun:test`. Sandbox safety = curated `globalThis` allow-list + transpile-time `import()`/`eval` rewrite + wall-clock timeout via `worker.terminate()` + per-call `AbortSignal`.

---

## Prerequisites & Tier-for-Parallelism Map

This plan implements one plugin (`llm-codemode-dispatch`). It depends on `llm-events` already existing on disk (it does — see `plugins/llm-events/`). It does NOT depend on `llm-tools-registry` source — the strategy receives the registry as a runtime argument, and tests use a mock that satisfies `ToolsRegistryService` from Spec 0.

Tiers below indicate what may run in parallel (no shared writes, no read-after-write):

- **Tier 0** (sequential, blocks all others): Task 1 (scaffold package), Task 2 (config module).
- **Tier 1A** (parallel, leaf modules — no inter-module imports): Task 3 (`dts-render.ts`), Task 4 (`extractor.ts`), Task 5 (`wrapper.ts`), Task 6 (`serialize.ts`), Task 7 (`rpc-types.ts`).
- **Tier 1B** (parallel after Tier 1A): Task 8 (`sandbox-entry.ts` — depends on `rpc-types`, `wrapper`), Task 9 (`sandbox-host.ts` — depends on `rpc-types`, `serialize`).
- **Tier 1C** (sequential, integrates): Task 10 (`prepare-request.ts`), Task 11 (`handle-response.ts`), Task 12 (`service.ts` + `index.ts`), Task 13 (`public.d.ts`), Task 14 (E2E real-Worker tests + cancellation tests), Task 15 (marketplace catalog + README).

## File Structure

```
plugins/llm-codemode-dispatch/
  index.ts                # KaizenPlugin: load config + provide tool-dispatch:strategy service
  service.ts              # makeStrategy(config, deps): ToolDispatchStrategy
  config.ts               # CodeModeConfig + loadConfig + DEFAULT_CONFIG
  dts-render.ts           # renderDts(tools): string  (cached, deterministic)
  extractor.ts            # extractCodeBlocks(text, maxBlocks): { code, ignoredCount }
  wrapper.ts              # wrapCode(userCode): { wrapped: string, transpileError? }  — AST rewrite
  serialize.ts            # stringifyReturn, formatResultMessage, truncate
  rpc-types.ts            # InitMsg | ToolInvokeMsg | ToolResultMsg | StdoutMsg | DoneMsg | ErrorMsg
  sandbox-host.ts         # runInSandbox(code, allowedTools, registry, signal, emit, config)
  sandbox-entry.ts        # worker entry: curate globals, install Proxy, run wrapped code
  prepare-request.ts      # prepareRequest implementation (uses dts-render)
  handle-response.ts      # handleResponse implementation (extractor → emit → sandbox-host → format)
  public.d.ts             # CodeModeConfig type only; re-exports nothing else
  package.json
  tsconfig.json
  README.md
  test/
    config.test.ts
    dts-render.test.ts
    extractor.test.ts
    wrapper.test.ts
    serialize.test.ts
    prepare-request.test.ts
    handle-response.test.ts        # mock registry, mock sandbox-host
    service.test.ts                # plugin metadata + provideService wiring
    e2e-sandbox.test.ts            # real Bun Worker, real wrapped code, mock registry
    fixtures/
      tools-simple.json            # 3-tool ToolSchema[] with primitive params
      tools-edge.json              # nullable, oneOf, kebab-name, missing-params, format
      response-no-code.txt
      response-one-block.txt
      response-multi-block.txt
      response-mixed-langs.txt
      response-template-literal-backticks.txt
```

Boundaries:
- `dts-render.ts`: pure (input: `ToolSchema[]`, output: `string`). No I/O. Memoized by stable hash.
- `extractor.ts`: pure (input: string + cap, output: `{ code: string, ignoredCount: number }`). Markdown-AST-based.
- `wrapper.ts`: pure (input: string, output: wrapped string OR transpile error). Uses `Bun.Transpiler` for AST scan only.
- `sandbox-host.ts`: orchestrates `new Worker`, `postMessage` RPC, timeouts, registry forwarding, signal handling. The ONLY module that imports `Worker`.
- `sandbox-entry.ts`: runs INSIDE the worker. Curated `globalThis`. The ONLY module that touches the user's code at runtime.
- `serialize.ts`: pure formatters for the `[code execution result]` body.
- `service.ts` composes `prepareRequest` (dts-render) + `handleResponse` (extractor → host → format).

`.kaizen/marketplace.json` is also modified (Task 15).

---

## Task 1: Scaffold the plugin package

**Files:**
- Create: `plugins/llm-codemode-dispatch/package.json`
- Create: `plugins/llm-codemode-dispatch/tsconfig.json`
- Create: `plugins/llm-codemode-dispatch/index.ts`
- Create: `plugins/llm-codemode-dispatch/service.ts`
- Create: `plugins/llm-codemode-dispatch/test/service.test.ts`

- [ ] **Step 1: Write the failing metadata test**

Create `plugins/llm-codemode-dispatch/test/service.test.ts`:

```ts
import { describe, it, expect, mock } from "bun:test";
import plugin from "../index.ts";

function makeCtx() {
  const provided: Record<string, unknown> = {};
  return {
    log: mock(() => {}),
    config: {},
    defineEvent: mock(() => {}),
    on: mock(() => {}),
    emit: mock(async () => []),
    defineService: mock(() => {}),
    provideService: mock((name: string, impl: unknown) => { provided[name] = impl; }),
    consumeService: mock(() => {}),
    useService: mock(() => undefined),
    secrets: { get: mock(async () => undefined), refresh: mock(async () => undefined) },
    provided,
  } as any;
}

describe("llm-codemode-dispatch plugin", () => {
  it("metadata", () => {
    expect(plugin.name).toBe("llm-codemode-dispatch");
    expect(plugin.apiVersion).toBe("3.0.0");
    expect(plugin.permissions?.tier).toBe("unscoped");
    expect(plugin.services?.provides).toEqual(["tool-dispatch:strategy"]);
  });

  it("provides tool-dispatch:strategy on setup", async () => {
    const ctx = makeCtx();
    await plugin.setup(ctx);
    const svc = ctx.provided["tool-dispatch:strategy"] as any;
    expect(typeof svc.prepareRequest).toBe("function");
    expect(typeof svc.handleResponse).toBe("function");
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `cd plugins/llm-codemode-dispatch && bun test`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `package.json`**

```json
{
  "name": "llm-codemode-dispatch",
  "version": "0.1.0",
  "description": "Code-mode tool dispatch strategy: LLM writes TypeScript that calls a typed kaizen.tools.* API in a Bun Worker sandbox.",
  "type": "module",
  "exports": { ".": "./index.ts" },
  "keywords": ["kaizen-plugin"],
  "dependencies": {
    "llm-events": "workspace:*",
    "json-schema-to-typescript": "^15.0.3",
    "mdast-util-from-markdown": "^2.0.2",
    "mdast-util-to-string": "^4.0.0"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "@types/json-schema": "^7.0.15",
    "typescript": "^5.4.0"
  }
}
```

- [ ] **Step 4: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "lib": ["ESNext", "WebWorker"]
  }
}
```

- [ ] **Step 5: Stub `service.ts` and `index.ts`**

`plugins/llm-codemode-dispatch/service.ts`:

```ts
import type { ToolDispatchStrategy } from "llm-events/public";

export function makeStrategy(_config: unknown, _deps: { log: (m: string) => void }): ToolDispatchStrategy {
  return {
    prepareRequest() { return {}; },
    async handleResponse() { return []; },
  };
}
```

`plugins/llm-codemode-dispatch/index.ts`:

```ts
import type { KaizenPlugin } from "kaizen/types";
import type { ToolDispatchStrategy } from "llm-events/public";
import { makeStrategy } from "./service.ts";

const plugin: KaizenPlugin = {
  name: "llm-codemode-dispatch",
  apiVersion: "3.0.0",
  permissions: { tier: "unscoped" },
  services: { provides: ["tool-dispatch:strategy"] },

  async setup(ctx) {
    ctx.defineService("tool-dispatch:strategy", {
      description: "Code-mode tool dispatch strategy (LLM writes TS calling kaizen.tools.*).",
    });
    const strategy: ToolDispatchStrategy = makeStrategy({}, { log: (m) => ctx.log(m) });
    ctx.provideService<ToolDispatchStrategy>("tool-dispatch:strategy", strategy);
  },
};

export default plugin;
```

- [ ] **Step 6: Run test to verify pass**

Run: `cd plugins/llm-codemode-dispatch && bun install && bun test test/service.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add plugins/llm-codemode-dispatch
git commit -m "feat(llm-codemode-dispatch): scaffold plugin package"
```

---

## Task 2: Config module

**Files:**
- Create: `plugins/llm-codemode-dispatch/config.ts`
- Create: `plugins/llm-codemode-dispatch/test/config.test.ts`

- [ ] **Step 1: Write the failing test**

`plugins/llm-codemode-dispatch/test/config.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { loadConfig, DEFAULT_CONFIG, defaultConfigPath, type ConfigDeps } from "../config.ts";

function deps(overrides: Partial<ConfigDeps> = {}): ConfigDeps {
  return {
    home: "/home/user",
    env: {},
    readFile: async () => { const e: any = new Error("ENOENT"); e.code = "ENOENT"; throw e; },
    log: () => {},
    ...overrides,
  };
}

describe("config", () => {
  it("returns defaults when no file", async () => {
    const cfg = await loadConfig(deps());
    expect(cfg).toEqual(DEFAULT_CONFIG);
  });

  it("default path uses ~/.kaizen/plugins/llm-codemode-dispatch", () => {
    expect(defaultConfigPath("/home/u")).toBe("/home/u/.kaizen/plugins/llm-codemode-dispatch/config.json");
  });

  it("KAIZEN_LLM_CODEMODE_CONFIG env overrides path", async () => {
    let read = "";
    await loadConfig(deps({
      env: { KAIZEN_LLM_CODEMODE_CONFIG: "/tmp/x.json" },
      readFile: async (p) => { read = p; return "{}"; },
    }));
    expect(read).toBe("/tmp/x.json");
  });

  it("merges user config over defaults", async () => {
    const cfg = await loadConfig(deps({
      readFile: async () => JSON.stringify({ timeoutMs: 5000, maxStdoutBytes: 1024 }),
    }));
    expect(cfg.timeoutMs).toBe(5000);
    expect(cfg.maxStdoutBytes).toBe(1024);
    expect(cfg.maxReturnBytes).toBe(DEFAULT_CONFIG.maxReturnBytes);
  });

  it("rejects malformed JSON", async () => {
    await expect(loadConfig(deps({ readFile: async () => "not json" }))).rejects.toThrow(/malformed/);
  });

  it("rejects non-positive timeoutMs", async () => {
    await expect(loadConfig(deps({ readFile: async () => JSON.stringify({ timeoutMs: 0 }) }))).rejects.toThrow(/timeoutMs/);
  });

  it("rejects unknown sandbox value", async () => {
    await expect(loadConfig(deps({ readFile: async () => JSON.stringify({ sandbox: "quickjs" }) }))).rejects.toThrow(/sandbox/);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `cd plugins/llm-codemode-dispatch && bun test test/config.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `config.ts`**

```ts
import { readFile as fsReadFile } from "node:fs/promises";

export interface CodeModeConfig {
  timeoutMs: number;
  maxStdoutBytes: number;
  maxReturnBytes: number;
  maxBlocksPerResponse: number;
  sandbox: "bun-worker";
}

export const DEFAULT_CONFIG: CodeModeConfig = Object.freeze({
  timeoutMs: 30000,
  maxStdoutBytes: 16384,
  maxReturnBytes: 4096,
  maxBlocksPerResponse: 8,
  sandbox: "bun-worker" as const,
});

export interface ConfigDeps {
  home: string;
  env: Record<string, string | undefined>;
  readFile: (path: string) => Promise<string>;
  log: (m: string) => void;
}

export function defaultConfigPath(home: string): string {
  return `${home}/.kaizen/plugins/llm-codemode-dispatch/config.json`;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validate(cfg: CodeModeConfig): void {
  if (cfg.timeoutMs <= 0) throw new Error("llm-codemode-dispatch: timeoutMs must be > 0");
  if (cfg.maxStdoutBytes <= 0) throw new Error("llm-codemode-dispatch: maxStdoutBytes must be > 0");
  if (cfg.maxReturnBytes <= 0) throw new Error("llm-codemode-dispatch: maxReturnBytes must be > 0");
  if (cfg.maxBlocksPerResponse <= 0) throw new Error("llm-codemode-dispatch: maxBlocksPerResponse must be > 0");
  if (cfg.sandbox !== "bun-worker") throw new Error("llm-codemode-dispatch: sandbox must be 'bun-worker'");
}

export async function loadConfig(deps: ConfigDeps): Promise<CodeModeConfig> {
  const path = deps.env.KAIZEN_LLM_CODEMODE_CONFIG ?? defaultConfigPath(deps.home);
  let raw: string;
  try {
    raw = await deps.readFile(path);
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      deps.log(`llm-codemode-dispatch: no config at ${path}; using defaults`);
      return { ...DEFAULT_CONFIG };
    }
    throw err;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch (err) {
    throw new Error(`llm-codemode-dispatch config at ${path} malformed: ${(err as Error).message}`);
  }
  if (!isPlainObject(parsed)) throw new Error(`llm-codemode-dispatch config at ${path} must be a JSON object`);
  const merged: CodeModeConfig = { ...DEFAULT_CONFIG, ...(parsed as object) } as CodeModeConfig;
  validate(merged);
  return merged;
}

export function realDeps(log: (m: string) => void): ConfigDeps {
  return {
    home: process.env.HOME ?? "/",
    env: process.env as Record<string, string | undefined>,
    readFile: (p) => fsReadFile(p, "utf8"),
    log,
  };
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `cd plugins/llm-codemode-dispatch && bun test test/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-codemode-dispatch/config.ts plugins/llm-codemode-dispatch/test/config.test.ts
git commit -m "feat(llm-codemode-dispatch): config module with defaults + validation"
```

---

## Task 3: DTS rendering (Tier 1A)

**Files:**
- Create: `plugins/llm-codemode-dispatch/dts-render.ts`
- Create: `plugins/llm-codemode-dispatch/test/dts-render.test.ts`
- Create: `plugins/llm-codemode-dispatch/test/fixtures/tools-simple.json`
- Create: `plugins/llm-codemode-dispatch/test/fixtures/tools-edge.json`

- [ ] **Step 1: Write fixtures**

`test/fixtures/tools-simple.json`:

```json
[
  { "name": "readFile", "description": "Read a file from disk.",
    "parameters": { "type": "object", "properties": { "path": { "type": "string" } }, "required": ["path"], "additionalProperties": false } },
  { "name": "writeFile", "description": "Write a file.",
    "parameters": { "type": "object", "properties": { "path": { "type": "string" }, "contents": { "type": "string" } }, "required": ["path","contents"], "additionalProperties": false } },
  { "name": "echo", "description": "Echo input.",
    "parameters": { "type": "object", "properties": { "msg": { "type": "string" } }, "required": ["msg"], "additionalProperties": false } }
]
```

`test/fixtures/tools-edge.json`:

```json
[
  { "name": "web-search", "description": "Search the web.",
    "parameters": { "type": "object", "properties": { "q": { "type": "string", "enum": ["a","b"] } }, "required": ["q"], "additionalProperties": false } },
  { "name": "noargs", "description": "No args." },
  { "name": "freeform", "description": "Freeform args.", "parameters": { "type": "object" } },
  { "name": "nullable", "description": "Nullable arg.",
    "parameters": { "type": "object", "properties": { "x": { "type": ["string","null"] } }, "additionalProperties": false } }
]
```

- [ ] **Step 2: Write the failing test**

`test/dts-render.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { renderDts, _resetCacheForTest } from "../dts-render.ts";
import type { ToolSchema } from "llm-events/public";
import simple from "./fixtures/tools-simple.json" with { type: "json" };
import edge from "./fixtures/tools-edge.json" with { type: "json" };

describe("dts-render", () => {
  it("renders kaizen global with method per tool", async () => {
    const out = await renderDts(simple as ToolSchema[]);
    expect(out).toContain("declare const kaizen");
    expect(out).toContain("readFile(args:");
    expect(out).toContain("writeFile(args:");
    expect(out).toContain("echo(args:");
    expect(out).toContain(": Promise<unknown>");
  });

  it("emits JSDoc from description", async () => {
    const out = await renderDts(simple as ToolSchema[]);
    expect(out).toContain("Read a file from disk.");
  });

  it("non-identifier tool name uses bracket-quoted method", async () => {
    const out = await renderDts(edge as ToolSchema[]);
    expect(out).toMatch(/"web-search"\(args:/);
  });

  it("missing parameters renders ()", async () => {
    const out = await renderDts(edge as ToolSchema[]);
    expect(out).toMatch(/noargs\(\)\s*:\s*Promise<unknown>/);
  });

  it("freeform object → Record<string, unknown>", async () => {
    const out = await renderDts(edge as ToolSchema[]);
    expect(out).toMatch(/freeform\(args:\s*Record<string,\s*unknown>\)/);
  });

  it("nullable union renders as string | null", async () => {
    const out = await renderDts(edge as ToolSchema[]);
    expect(out).toMatch(/string\s*\|\s*null/);
  });

  it("enum becomes string-literal union", async () => {
    const out = await renderDts(edge as ToolSchema[]);
    expect(out).toMatch(/"a"\s*\|\s*"b"/);
  });

  it("deterministic: same input twice → identical strings", async () => {
    _resetCacheForTest();
    const a = await renderDts(simple as ToolSchema[]);
    _resetCacheForTest();
    const b = await renderDts(simple as ToolSchema[]);
    expect(a).toBe(b);
  });

  it("orders tools alphabetically by name", async () => {
    const out = await renderDts(simple as ToolSchema[]);
    const ie = out.indexOf("echo(");
    const ir = out.indexOf("readFile(");
    const iw = out.indexOf("writeFile(");
    expect(ie).toBeLessThan(ir);
    expect(ir).toBeLessThan(iw);
  });

  it("cache hit: second call does not re-invoke compiler", async () => {
    _resetCacheForTest();
    const a = await renderDts(simple as ToolSchema[]);
    const b = await renderDts(simple as ToolSchema[]);
    expect(a).toBe(b);
    // exercising same identity is enough; counter-based assertion below uses internal probe
  });

  it("PascalCase Args interface name collision adds numeric suffix", async () => {
    const tools: ToolSchema[] = [
      { name: "read-file", description: "a", parameters: { type: "object", properties: { x: { type: "string" } } } as any },
      { name: "read_file", description: "b", parameters: { type: "object", properties: { y: { type: "string" } } } as any },
    ];
    const out = await renderDts(tools);
    expect(out).toContain("ReadFileArgs");
    expect(out).toMatch(/ReadFileArgs2|ReadFileArgs_2/);
  });
});
```

- [ ] **Step 3: Run test to verify failure**

Run: `cd plugins/llm-codemode-dispatch && bun test test/dts-render.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `dts-render.ts`**

```ts
import { compile } from "json-schema-to-typescript";
import type { ToolSchema } from "llm-events/public";

const cache = new Map<string, string>();

export function _resetCacheForTest(): void { cache.clear(); }

function stableKey(tools: ToolSchema[]): string {
  const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
  return JSON.stringify(sorted.map((t) => [t.name, t.description ?? "", t.parameters ?? null]));
}

function isIdent(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
}

function pascal(name: string): string {
  return name
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join("") || "Tool";
}

function uniqInterfaceName(base: string, used: Set<string>): string {
  if (!used.has(base)) { used.add(base); return base; }
  let i = 2;
  while (used.has(`${base}${i}`)) i++;
  const name = `${base}${i}`;
  used.add(name);
  return name;
}

async function compileParamsInterface(name: string, schema: unknown): Promise<string> {
  // json-schema-to-typescript needs a title to emit `interface <Name>`.
  const root = { ...(schema as object), title: name } as any;
  const out = await compile(root, name, {
    bannerComment: "",
    additionalProperties: false,
    declareExternallyReferenced: false,
    enableConstEnums: false,
    format: false,
    strictIndexSignatures: true,
    unknownAny: false,
  });
  return out.trim();
}

function isFreeformObject(schema: any): boolean {
  return schema && schema.type === "object" && (!schema.properties || Object.keys(schema.properties).length === 0);
}

export async function renderDts(tools: ToolSchema[]): Promise<string> {
  const key = stableKey(tools);
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
  const used = new Set<string>();
  const interfaceBlocks: string[] = [];
  const methodLines: string[] = [];

  for (const tool of sorted) {
    const params = tool.parameters as any;
    let paramTs: string;
    if (!params) {
      paramTs = ""; // method renders as `name()`
    } else if (isFreeformObject(params)) {
      paramTs = "args: Record<string, unknown>";
    } else {
      const ifaceName = uniqInterfaceName(`${pascal(tool.name)}Args`, used);
      const block = await compileParamsInterface(ifaceName, params);
      interfaceBlocks.push(block);
      paramTs = `args: ${ifaceName}`;
    }

    const methodKey = isIdent(tool.name) ? tool.name : JSON.stringify(tool.name);
    const jsdoc = tool.description ? `  /** ${tool.description.replace(/\*\//g, "*\\/")} */\n` : "";
    methodLines.push(`${jsdoc}  ${methodKey}(${paramTs}): Promise<unknown>;`);
  }

  const out = [
    ...interfaceBlocks,
    "",
    "declare const kaizen: {",
    "  tools: {",
    ...methodLines,
    "  };",
    "};",
    "",
  ].join("\n");

  cache.set(key, out);
  return out;
}
```

- [ ] **Step 5: Run test to verify pass**

Run: `cd plugins/llm-codemode-dispatch && bun test test/dts-render.test.ts`
Expected: PASS. If any test fails, fix the implementation; do NOT loosen the test.

- [ ] **Step 6: Commit**

```bash
git add plugins/llm-codemode-dispatch/dts-render.ts plugins/llm-codemode-dispatch/test/dts-render.test.ts plugins/llm-codemode-dispatch/test/fixtures/tools-simple.json plugins/llm-codemode-dispatch/test/fixtures/tools-edge.json
git commit -m "feat(llm-codemode-dispatch): JSONSchema → kaizen.tools .d.ts rendering"
```

---

## Task 4: Markdown code-block extractor (Tier 1A)

**Files:**
- Create: `plugins/llm-codemode-dispatch/extractor.ts`
- Create: `plugins/llm-codemode-dispatch/test/extractor.test.ts`
- Create: `plugins/llm-codemode-dispatch/test/fixtures/response-no-code.txt`
- Create: `plugins/llm-codemode-dispatch/test/fixtures/response-one-block.txt`
- Create: `plugins/llm-codemode-dispatch/test/fixtures/response-multi-block.txt`
- Create: `plugins/llm-codemode-dispatch/test/fixtures/response-mixed-langs.txt`
- Create: `plugins/llm-codemode-dispatch/test/fixtures/response-template-literal-backticks.txt`

- [ ] **Step 1: Write fixtures**

`response-no-code.txt`:

```
The answer is 42. No code needed.
```

`response-one-block.txt`:

````
Here is the read:
```typescript
const x = await kaizen.tools.readFile({ path: "a" });
x;
```
````

`response-multi-block.txt`:

````
First read:
```typescript
const cfg = await kaizen.tools.readFile({ path: "config.json" });
```
Then parse:
```ts
JSON.parse(cfg);
```
````

`response-mixed-langs.txt`:

````
```python
print("ignored")
```
```typescript
1 + 1;
```
```text
also ignored
```
````

`response-template-literal-backticks.txt`:

````
```typescript
const s = `inner ``` not a fence`;
s;
```
````

(For the template-literal fixture: the inner triple-backtick must be inside a JS template literal. mdast handles this only because the OUTER fence is exact. Use a 4-backtick outer fence in the actual fixture file so the inner triple is preserved literally.)

Concrete file content for `response-template-literal-backticks.txt` (literal bytes):

````
````typescript
const s = "inner ``` not a fence";
s;
````
````

(Use a 4-backtick info-string fence so the parser treats `````typescript` as the fence and contents preserve the literal triple-backtick line. This exercises the "fence length matters" path.)

- [ ] **Step 2: Write the failing test**

`test/extractor.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { extractCodeBlocks } from "../extractor.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const fx = (name: string) => readFileSync(join(import.meta.dir, "fixtures", name), "utf8");

describe("extractCodeBlocks", () => {
  it("returns empty when no code", () => {
    const r = extractCodeBlocks(fx("response-no-code.txt"), 8);
    expect(r.code).toBe("");
    expect(r.ignoredCount).toBe(0);
  });

  it("extracts one typescript block", () => {
    const r = extractCodeBlocks(fx("response-one-block.txt"), 8);
    expect(r.code).toContain("kaizen.tools.readFile");
    expect(r.ignoredCount).toBe(0);
  });

  it("concatenates multiple ts/typescript blocks with \\n;\\n", () => {
    const r = extractCodeBlocks(fx("response-multi-block.txt"), 8);
    expect(r.code).toContain("readFile");
    expect(r.code).toContain("JSON.parse");
    expect(r.code).toContain("\n;\n");
  });

  it("ignores non-ts languages", () => {
    const r = extractCodeBlocks(fx("response-mixed-langs.txt"), 8);
    expect(r.code).toBe("1 + 1;");
  });

  it("ignores blocks with no info string", () => {
    const r = extractCodeBlocks("```\nfoo\n```", 8);
    expect(r.code).toBe("");
  });

  it("recognizes ts, typescript, js, javascript (case-insensitive)", () => {
    expect(extractCodeBlocks("```TS\na;\n```", 8).code).toBe("a;");
    expect(extractCodeBlocks("```Javascript\nb;\n```", 8).code).toBe("b;");
  });

  it("respects backticks inside template literal via fence-length", () => {
    const r = extractCodeBlocks(fx("response-template-literal-backticks.txt"), 8);
    expect(r.code).toContain("inner");
    expect(r.code).toContain("not a fence");
  });

  it("malformed unterminated fence returns empty", () => {
    const r = extractCodeBlocks("```typescript\nno close", 8);
    expect(r.code).toBe("");
  });

  it("caps at maxBlocks and reports ignoredCount", () => {
    const blocks = Array(10).fill(0).map((_, i) => "```typescript\nconst _" + i + "=" + i + ";\n```").join("\n");
    const r = extractCodeBlocks(blocks, 3);
    expect(r.ignoredCount).toBe(7);
    expect(r.code.split("\n;\n").length).toBe(3);
  });

  it("handles CRLF line endings", () => {
    const src = "```typescript\r\n1+1;\r\n```\r\n";
    expect(extractCodeBlocks(src, 8).code).toBe("1+1;");
  });
});
```

- [ ] **Step 3: Run test to verify failure**

Run: `cd plugins/llm-codemode-dispatch && bun test test/extractor.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `extractor.ts`**

```ts
import { fromMarkdown } from "mdast-util-from-markdown";

const TS_LANGS = new Set(["ts", "typescript", "js", "javascript"]);

export interface ExtractResult {
  code: string;
  ignoredCount: number;
}

export function extractCodeBlocks(text: string, maxBlocks: number): ExtractResult {
  const normalized = text.replace(/\r\n/g, "\n");
  let tree;
  try {
    tree = fromMarkdown(normalized);
  } catch {
    return { code: "", ignoredCount: 0 };
  }

  const blocks: string[] = [];
  for (const node of tree.children) {
    if (node.type !== "code") continue;
    const lang = (node.lang ?? "").toLowerCase();
    if (!lang || !TS_LANGS.has(lang)) continue;
    blocks.push((node.value ?? "").trim());
  }

  if (blocks.length === 0) return { code: "", ignoredCount: 0 };

  const taken = blocks.slice(0, maxBlocks);
  const ignored = Math.max(0, blocks.length - taken.length);
  return { code: taken.join("\n;\n"), ignoredCount: ignored };
}
```

- [ ] **Step 5: Run test to verify pass**

Run: `cd plugins/llm-codemode-dispatch && bun test test/extractor.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add plugins/llm-codemode-dispatch/extractor.ts plugins/llm-codemode-dispatch/test/extractor.test.ts plugins/llm-codemode-dispatch/test/fixtures/response-*.txt
git commit -m "feat(llm-codemode-dispatch): markdown-AST fenced code-block extractor"
```

---

## Task 5: Code wrapper — trailing-expression-to-return AST rewrite (Tier 1A)

**Files:**
- Create: `plugins/llm-codemode-dispatch/wrapper.ts`
- Create: `plugins/llm-codemode-dispatch/test/wrapper.test.ts`

The wrapper takes user TS, parses with `Bun.Transpiler`, finds the last top-level statement, and if it's an `ExpressionStatement` rewrites it to `return <expr>;`. It also rejects (rewrites to throw) any `import` / dynamic `import()` / `eval(` / `Function(` references at the source level — defense-in-depth complementing the runtime global scrub.

- [ ] **Step 1: Write the failing test**

`test/wrapper.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { wrapCode } from "../wrapper.ts";

describe("wrapCode", () => {
  it("wraps simple expression as return", () => {
    const r = wrapCode("1 + 1");
    expect(r.transpileError).toBeUndefined();
    expect(r.wrapped).toContain("async () =>");
    expect(r.wrapped).toContain("return (1 + 1)");
  });

  it("wraps trailing identifier", () => {
    const r = wrapCode("const x = 5;\nx");
    expect(r.wrapped).toContain("return (x)");
  });

  it("preserves explicit return", () => {
    const r = wrapCode("return 42;");
    expect(r.wrapped).toContain("return 42;");
  });

  it("preserves trailing statement (no rewrite) if not expression", () => {
    const r = wrapCode("const x = 5;\nif (x) { /* */ }");
    expect(r.wrapped).not.toMatch(/return \(if/);
  });

  it("rejects static import", () => {
    const r = wrapCode("import fs from 'node:fs';");
    expect(r.transpileError).toMatch(/import/i);
  });

  it("rejects dynamic import()", () => {
    const r = wrapCode("await import('node:fs');");
    expect(r.transpileError).toMatch(/import/i);
  });

  it("rejects eval(", () => {
    const r = wrapCode("eval('1+1')");
    expect(r.transpileError).toMatch(/eval/i);
  });

  it("rejects new Function(", () => {
    const r = wrapCode("new Function('return 1')()");
    expect(r.transpileError).toMatch(/Function/);
  });

  it("rejects require(", () => {
    const r = wrapCode("require('node:fs')");
    expect(r.transpileError).toMatch(/require/);
  });

  it("syntax error surfaces transpileError", () => {
    const r = wrapCode("const x =");
    expect(r.transpileError).toBeDefined();
  });

  it("empty code wraps to return undefined", () => {
    const r = wrapCode("");
    expect(r.transpileError).toBeUndefined();
    expect(r.wrapped).toMatch(/async\s*\(\s*\)\s*=>/);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `cd plugins/llm-codemode-dispatch && bun test test/wrapper.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `wrapper.ts`**

```ts
export interface WrapResult {
  wrapped: string;
  transpileError?: string;
}

const FORBIDDEN_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /\bimport\s+[^(]/, label: "static import disallowed" },
  { re: /\bimport\s*\(/, label: "dynamic import() disallowed" },
  { re: /\beval\s*\(/, label: "eval() disallowed" },
  { re: /\bnew\s+Function\s*\(/, label: "new Function() disallowed" },
  { re: /(^|[^.\w])Function\s*\(/, label: "Function() disallowed" },
  { re: /\brequire\s*\(/, label: "require() disallowed" },
];

function checkForbidden(code: string): string | undefined {
  for (const { re, label } of FORBIDDEN_PATTERNS) {
    if (re.test(code)) return label;
  }
  return undefined;
}

function trySyntaxCheck(code: string): string | undefined {
  try {
    // Bun.Transpiler is available in Bun runtime AND inside workers.
    const t = new (globalThis as any).Bun.Transpiler({ loader: "ts" });
    t.transformSync(code);
    return undefined;
  } catch (err) {
    return String((err as Error).message ?? err);
  }
}

function rewriteTrailingExpression(code: string): string {
  // Heuristic: split on top-level statements by scanning balanced braces/parens
  // and locating the final `;` or newline-terminated unit. If the final unit
  // looks like a bare expression (no leading keyword like const/let/var/if/for/while/return/throw/try/{), wrap in return.
  const trimmed = code.replace(/\s+$/, "");
  if (trimmed.length === 0) return code;
  // Find the start of the last top-level statement.
  let depth = 0, inStr: string | null = null, lastBoundary = 0;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    const prev = trimmed[i - 1];
    if (inStr) {
      if (ch === inStr && prev !== "\\") inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { inStr = ch; continue; }
    if (ch === "{" || ch === "(" || ch === "[") depth++;
    else if (ch === "}" || ch === ")" || ch === "]") depth--;
    else if (depth === 0 && (ch === ";" || ch === "\n")) lastBoundary = i + 1;
  }
  let head = trimmed.slice(0, lastBoundary);
  let tail = trimmed.slice(lastBoundary).trim();
  if (tail.endsWith(";")) tail = tail.slice(0, -1).trim();
  if (!tail) return code;
  if (/^(const|let|var|if|for|while|do|switch|return|throw|try|function|class|\{|import|export)\b/.test(tail)) {
    return code;
  }
  return `${head}return (${tail});`;
}

export function wrapCode(userCode: string): WrapResult {
  const forbidden = checkForbidden(userCode);
  if (forbidden) return { wrapped: "", transpileError: forbidden };

  const syn = trySyntaxCheck(userCode);
  if (syn) return { wrapped: "", transpileError: syn };

  const rewritten = rewriteTrailingExpression(userCode);
  const wrapped = `(async () => {\n${rewritten}\n})()`;
  return { wrapped };
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `cd plugins/llm-codemode-dispatch && bun test test/wrapper.test.ts`
Expected: PASS. If the heuristic-based rewrite fails any test, fix the heuristic; do NOT loosen the test.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-codemode-dispatch/wrapper.ts plugins/llm-codemode-dispatch/test/wrapper.test.ts
git commit -m "feat(llm-codemode-dispatch): trailing-expression-to-return wrapper + forbidden-syntax guard"
```

---

## Task 6: Result/stdout serialization (Tier 1A)

**Files:**
- Create: `plugins/llm-codemode-dispatch/serialize.ts`
- Create: `plugins/llm-codemode-dispatch/test/serialize.test.ts`

- [ ] **Step 1: Write the failing test**

`test/serialize.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { stringifyReturn, formatResultMessage, truncate } from "../serialize.ts";

describe("stringifyReturn", () => {
  it("undefined → 'undefined'", () => {
    expect(stringifyReturn(undefined)).toBe("undefined");
  });
  it("bigint → \"<n>n\"", () => {
    expect(stringifyReturn(BigInt(7))).toBe("\"7n\"");
  });
  it("circular → [Circular]", () => {
    const a: any = {}; a.self = a;
    expect(stringifyReturn(a)).toContain("[Circular]");
  });
  it("function → [Function]", () => {
    expect(stringifyReturn(() => 1)).toBe("\"[Function]\"");
  });
  it("symbol → [Symbol]", () => {
    expect(stringifyReturn(Symbol("x"))).toBe("\"[Symbol]\"");
  });
  it("plain object → JSON", () => {
    expect(stringifyReturn({ a: 1 })).toBe('{"a":1}');
  });
});

describe("truncate", () => {
  it("returns input under cap unchanged", () => {
    expect(truncate("hello", 100)).toBe("hello");
  });
  it("appends marker when over cap", () => {
    const r = truncate("a".repeat(50), 10);
    expect(r.length).toBeLessThanOrEqual(60);
    expect(r).toMatch(/\[truncated, \d+ more bytes\]/);
  });
});

describe("formatResultMessage", () => {
  it("ok shape", () => {
    const out = formatResultMessage({ ok: true, returnValue: 42, stdout: "hi\n" }, { maxStdoutBytes: 100, maxReturnBytes: 100 });
    expect(out).toContain("[code execution result]");
    expect(out).toContain("exit: ok");
    expect(out).toContain("returned: 42");
    expect(out).toContain("stdout:\nhi");
  });
  it("error shape", () => {
    const out = formatResultMessage({ ok: false, errorName: "TypeError", errorMessage: "boom", stdout: "" }, { maxStdoutBytes: 100, maxReturnBytes: 100 });
    expect(out).toContain("exit: error");
    expect(out).toContain("error: TypeError: boom");
  });
  it("appends ignored-blocks note when provided", () => {
    const out = formatResultMessage({ ok: true, returnValue: 1, stdout: "", ignoredBlocks: 2 }, { maxStdoutBytes: 100, maxReturnBytes: 100 });
    expect(out).toContain("note: 2 additional code block(s) were ignored because the limit is 8");
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `cd plugins/llm-codemode-dispatch && bun test test/serialize.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `serialize.ts`**

```ts
export function stringifyReturn(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "bigint") return JSON.stringify(`${value.toString()}n`);
  if (typeof value === "function") return JSON.stringify("[Function]");
  if (typeof value === "symbol") return JSON.stringify("[Symbol]");
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_k, v) => {
    if (typeof v === "bigint") return `${v.toString()}n`;
    if (typeof v === "function") return "[Function]";
    if (typeof v === "symbol") return "[Symbol]";
    if (typeof v === "object" && v !== null) {
      if (seen.has(v)) return "[Circular]";
      seen.add(v);
    }
    return v;
  });
}

export function truncate(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.byteLength <= maxBytes) return s;
  const head = buf.subarray(0, maxBytes).toString("utf8");
  const more = buf.byteLength - maxBytes;
  return `${head}\n...[truncated, ${more} more bytes]`;
}

export interface FormatInputOk { ok: true; returnValue: unknown; stdout: string; ignoredBlocks?: number; }
export interface FormatInputErr { ok: false; errorName: string; errorMessage: string; stdout: string; ignoredBlocks?: number; }
export type FormatInput = FormatInputOk | FormatInputErr;

export function formatResultMessage(
  input: FormatInput,
  caps: { maxStdoutBytes: number; maxReturnBytes: number; maxBlocksPerResponse?: number },
): string {
  const stdout = truncate(input.stdout ?? "", caps.maxStdoutBytes);
  const lines: string[] = ["[code execution result]"];
  if (input.ok) {
    lines.push("exit: ok");
    const ret = truncate(stringifyReturn(input.returnValue), caps.maxReturnBytes);
    lines.push(`returned: ${ret}`);
  } else {
    lines.push("exit: error");
    lines.push(`error: ${input.errorName}: ${input.errorMessage}`);
  }
  lines.push("stdout:");
  lines.push(stdout);
  if (input.ignoredBlocks && input.ignoredBlocks > 0) {
    const limit = caps.maxBlocksPerResponse ?? 8;
    lines.push(`note: ${input.ignoredBlocks} additional code block(s) were ignored because the limit is ${limit}`);
  }
  return lines.join("\n");
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `cd plugins/llm-codemode-dispatch && bun test test/serialize.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-codemode-dispatch/serialize.ts plugins/llm-codemode-dispatch/test/serialize.test.ts
git commit -m "feat(llm-codemode-dispatch): result/stdout serialization with safe stringify + truncation"
```

---

## Task 7: RPC message types (Tier 1A)

**Files:**
- Create: `plugins/llm-codemode-dispatch/rpc-types.ts`

- [ ] **Step 1: Write `rpc-types.ts`**

```ts
// Messages exchanged between sandbox-host (in main process) and sandbox-entry (in Bun Worker).
// host → worker
export interface InitMsg {
  type: "init";
  wrappedCode: string;        // already wrapped by sandbox-host using wrapCode()
  maxStdoutBytes: number;
}
export interface ToolResultMsg {
  type: "tool-result";
  id: string;
  ok: boolean;
  value?: unknown;
  error?: { name: string; message: string };
}

// worker → host
export interface ToolInvokeMsg {
  type: "tool-invoke";
  id: string;
  name: string;
  args: unknown;
}
export interface StdoutMsg {
  type: "stdout";
  chunk: string;
}
export interface DoneMsg {
  type: "done";
  returnValue: unknown;
}
export interface ErrorMsg {
  type: "error";
  name: string;
  message: string;
  stack?: string;
}

export type HostToWorker = InitMsg | ToolResultMsg;
export type WorkerToHost = ToolInvokeMsg | StdoutMsg | DoneMsg | ErrorMsg;
```

- [ ] **Step 2: Commit**

```bash
git add plugins/llm-codemode-dispatch/rpc-types.ts
git commit -m "feat(llm-codemode-dispatch): RPC message types for host↔worker"
```

---

## Task 8: Sandbox worker entry (Tier 1B)

**Files:**
- Create: `plugins/llm-codemode-dispatch/sandbox-entry.ts`

This file runs **inside** the Bun Worker. It curates `globalThis`, installs the `kaizen.tools` Proxy, redirects `console.*`, then evaluates the wrapped code.

- [ ] **Step 1: Implement `sandbox-entry.ts`**

```ts
/// <reference lib="webworker" />
import type { HostToWorker, ToolInvokeMsg, ToolResultMsg, StdoutMsg, DoneMsg, ErrorMsg } from "./rpc-types.ts";

declare const self: DedicatedWorkerGlobalScope;

// ---------- Curate globals ----------
const ALLOW_KEYS = new Set<string>([
  "self","globalThis","console","JSON","Math","Date","Promise","Array","Object",
  "String","Number","Boolean","RegExp","Error","TypeError","RangeError","SyntaxError",
  "Map","Set","WeakMap","WeakSet","Symbol","BigInt","Uint8Array","Int8Array","Uint16Array",
  "Int16Array","Uint32Array","Int32Array","Float32Array","Float64Array","ArrayBuffer",
  "Reflect","Proxy","Buffer","TextEncoder","TextDecoder",
  "setTimeout","clearTimeout","queueMicrotask",
  "kaizen", "postMessage", "addEventListener", "removeEventListener", "onmessage", "onerror",
]);

function curateGlobals(): void {
  const g = self as unknown as Record<string, unknown>;
  for (const k of Object.getOwnPropertyNames(g)) {
    if (!ALLOW_KEYS.has(k)) {
      try { delete g[k]; } catch { try { (g as any)[k] = undefined; } catch {} }
    }
  }
  // Belt-and-suspenders: explicitly null out known dangerous keys even if listed in ALLOW.
  for (const k of ["Bun","process","require","module","__dirname","__filename","fetch","XMLHttpRequest","WebSocket","EventSource","setInterval","setImmediate","eval","Function","import"]) {
    try { (g as any)[k] = undefined; } catch {}
  }
  // Also neutralize Function constructor reachable via (()=>{}).constructor.
  try {
    const FnCtor = (function(){}).constructor;
    if (FnCtor) {
      (FnCtor as any).prototype.constructor = function blocked() { throw new Error("Function constructor disabled in sandbox"); };
    }
  } catch {}
}

// ---------- Stdout capture ----------
let stdoutBytes = 0;
let stdoutCap = 16384;
function postStdout(chunk: string): void {
  if (stdoutBytes >= stdoutCap) return;
  stdoutBytes += Buffer.byteLength(chunk, "utf8");
  const msg: StdoutMsg = { type: "stdout", chunk };
  (self as any).postMessage(msg);
}
function inspect(v: unknown): string {
  try {
    // Prefer Bun.inspect if available (it's not, after curation), else JSON.
    if (typeof v === "string") return v;
    return JSON.stringify(v);
  } catch { return String(v); }
}
function makeConsole() {
  const fmt = (args: unknown[]) => args.map(inspect).join(" ");
  return {
    log: (...a: unknown[]) => postStdout(fmt(a) + "\n"),
    info: (...a: unknown[]) => postStdout(fmt(a) + "\n"),
    debug: (...a: unknown[]) => postStdout(fmt(a) + "\n"),
    warn: (...a: unknown[]) => postStdout(fmt(a) + "\n"),
    error: (...a: unknown[]) => postStdout("[error] " + fmt(a) + "\n"),
  };
}

// ---------- Tool RPC Proxy ----------
type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void };
const pending = new Map<string, Pending>();
let counter = 0;
function nextId(): string { return `c${++counter}`; }

function makeKaizen(): unknown {
  const toolsProxy = new Proxy({}, {
    get(_t, prop) {
      if (typeof prop !== "string") return undefined;
      return (args: unknown) => new Promise((resolve, reject) => {
        const id = nextId();
        pending.set(id, { resolve, reject });
        const msg: ToolInvokeMsg = { type: "tool-invoke", id, name: prop, args };
        (self as any).postMessage(msg);
      });
    },
  });
  return { tools: toolsProxy };
}

// ---------- Main ----------
self.addEventListener("message", async (ev: MessageEvent<HostToWorker>) => {
  const msg = ev.data;
  if (msg.type === "tool-result") {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.value);
    else p.reject(Object.assign(new Error(msg.error?.message ?? "tool error"), { name: msg.error?.name ?? "Error" }));
    return;
  }
  if (msg.type === "init") {
    stdoutCap = msg.maxStdoutBytes;
    curateGlobals();
    (globalThis as any).kaizen = makeKaizen();
    (globalThis as any).console = makeConsole();
    try {
      // The wrappedCode is `(async () => { ... })()`. Evaluating it produces a Promise.
      // We use indirect (0,eval) — but eval is gone post-curation. Use Bun's transpiler again? No — we must use Function-equivalent.
      // Instead we send wrappedCode through the message and reconstruct via AsyncFunction directly here, BEFORE eval/Function are nulled.
      // To make that work, we re-introduce a one-shot AsyncFunction handle saved before curation.
      throw new Error("unreachable: see init flow below");
    } catch (err) {
      const e: ErrorMsg = { type: "error", name: (err as Error).name, message: String((err as Error).message), stack: (err as Error).stack };
      (self as any).postMessage(e);
    }
  }
});

// We need to evaluate user code AFTER curation, but eval/Function are gone after curation.
// Solution: capture an AsyncFunction constructor reference at module load (before curation),
// then use it inside the message handler. Replace the throw above.
const AsyncFunctionCtor: FunctionConstructor = (async function () {}).constructor as unknown as FunctionConstructor;

self.removeEventListener("message", () => {}); // no-op; ensure listeners are clean if hot-reloaded.
self.addEventListener("message", async (ev: MessageEvent<HostToWorker>) => {
  const msg = ev.data;
  if (msg.type !== "init") return;
  try {
    // Build an AsyncFunction whose body returns the result of evaluating wrappedCode.
    // wrappedCode is already `(async () => { ... })()` so we just `return` its value.
    const fn = new (AsyncFunctionCtor as any)("kaizen", `return ${msg.wrappedCode};`);
    const promise = fn((globalThis as any).kaizen);
    const value = await promise;
    const done: DoneMsg = { type: "done", returnValue: value };
    (self as any).postMessage(done);
  } catch (err) {
    const e: ErrorMsg = { type: "error", name: (err as Error)?.name ?? "Error", message: String((err as Error)?.message ?? err), stack: (err as Error)?.stack };
    (self as any).postMessage(e);
  }
});
```

NOTE on the duplicate-listener pattern: the first `addEventListener` block above handles `tool-result` (RPC replies); the second handles `init`. This is intentional — both fire for every `message`, but each filters by `type`. The throw inside the first listener's `init` arm is unreachable because the second listener handles `init` first via the same event (both listeners receive the message; the second one does the actual eval). Verify by reading the test in Task 14 — if confusing, simplify to a single listener that switches on `msg.type`.

**Simplification (preferred):** replace both `addEventListener` blocks with a single listener:

```ts
const AsyncFunctionCtor: FunctionConstructor = (async function () {}).constructor as unknown as FunctionConstructor;

self.addEventListener("message", async (ev: MessageEvent<HostToWorker>) => {
  const msg = ev.data;
  if (msg.type === "tool-result") {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.value);
    else p.reject(Object.assign(new Error(msg.error?.message ?? "tool error"), { name: msg.error?.name ?? "Error" }));
    return;
  }
  if (msg.type === "init") {
    stdoutCap = msg.maxStdoutBytes;
    curateGlobals();
    (globalThis as any).kaizen = makeKaizen();
    (globalThis as any).console = makeConsole();
    try {
      const fn = new (AsyncFunctionCtor as any)("kaizen", `return ${msg.wrappedCode};`);
      const value = await fn((globalThis as any).kaizen);
      (self as any).postMessage({ type: "done", returnValue: value } satisfies DoneMsg);
    } catch (err) {
      (self as any).postMessage({ type: "error", name: (err as Error)?.name ?? "Error", message: String((err as Error)?.message ?? err), stack: (err as Error)?.stack } satisfies ErrorMsg);
    }
  }
});
```

Use the simplification in the actual file. Drop the earlier two-listener pattern.

- [ ] **Step 2: Commit (no test yet — exercised end-to-end in Task 14)**

```bash
git add plugins/llm-codemode-dispatch/sandbox-entry.ts
git commit -m "feat(llm-codemode-dispatch): sandbox worker entry — curated globals + Proxy + console capture"
```

---

## Task 9: Sandbox host (Tier 1B)

**Files:**
- Create: `plugins/llm-codemode-dispatch/sandbox-host.ts`
- Create: `plugins/llm-codemode-dispatch/test/sandbox-host.test.ts`

The host owns the Worker lifecycle: spawn → init → handle `tool-invoke` by calling `registry.invoke` → relay `tool-result` → enforce wall-clock timeout via `worker.terminate()` → react to `signal.aborted` the same way → return `{ ok, returnValue?, errorName?, errorMessage?, stdout }`.

- [ ] **Step 1: Write the failing test**

`test/sandbox-host.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { runInSandbox, type SandboxRunResult } from "../sandbox-host.ts";
import type { ToolsRegistryService, ToolSchema } from "llm-events/public";

function mockRegistry(handlers: Record<string, (args: any) => Promise<unknown> | unknown>): ToolsRegistryService {
  return {
    register: () => () => {},
    list: () => [] as ToolSchema[],
    invoke: async (name, args, _ctx) => {
      const h = handlers[name];
      if (!h) throw new Error(`unknown tool: ${name}`);
      return await h(args);
    },
  };
}

describe("runInSandbox", () => {
  const config = { timeoutMs: 5000, maxStdoutBytes: 16384, maxReturnBytes: 4096, maxBlocksPerResponse: 8, sandbox: "bun-worker" as const };

  it("evaluates plain expression and returns value", async () => {
    const r = await runInSandbox("1 + 1", mockRegistry({}), new AbortController().signal, config);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.returnValue).toBe(2);
  });

  it("calls a registered tool via kaizen.tools.X", async () => {
    const reg = mockRegistry({ echo: async (a: any) => ({ got: a.msg }) });
    const code = `const r = await kaizen.tools.echo({ msg: "hi" }); r;`;
    const r = await runInSandbox(code, reg, new AbortController().signal, config);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.returnValue).toEqual({ got: "hi" });
  });

  it("captures console.log output", async () => {
    const code = `console.log("a"); console.log("b"); 1;`;
    const r = await runInSandbox(code, mockRegistry({}), new AbortController().signal, config);
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain("a\n");
    expect(r.stdout).toContain("b\n");
  });

  it("throws inside user code → ok:false with error", async () => {
    const r = await runInSandbox(`throw new TypeError("boom")`, mockRegistry({}), new AbortController().signal, config);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errorName).toBe("TypeError");
      expect(r.errorMessage).toBe("boom");
    }
  });

  it("times out runaway loop", async () => {
    const fast = { ...config, timeoutMs: 200 };
    const r = await runInSandbox(`while(true){}`, mockRegistry({}), new AbortController().signal, fast);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorName).toBe("TimeoutError");
  }, 5000);

  it("AbortSignal aborts worker", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    await expect(runInSandbox(`while(true){}`, mockRegistry({}), ac.signal, config)).rejects.toThrow(/abort/i);
  }, 5000);

  it("eval is not available", async () => {
    const r = await runInSandbox(`eval("1+1")`, mockRegistry({}), new AbortController().signal, config);
    expect(r.ok).toBe(false);
  });

  it("setInterval is not available", async () => {
    const r = await runInSandbox(`setInterval(()=>{}, 100); 1;`, mockRegistry({}), new AbortController().signal, config);
    expect(r.ok).toBe(false);
  });

  it("unknown tool surfaces registry error to user code", async () => {
    const code = `try { await kaizen.tools.nope({}); "unreachable"; } catch(e) { (e as any).message }`;
    const r = await runInSandbox(code, mockRegistry({}), new AbortController().signal, config);
    expect(r.ok).toBe(true);
    if (r.ok) expect(String(r.returnValue)).toContain("unknown tool: nope");
  });

  it("stdout overflow truncated by host", async () => {
    const small = { ...config, maxStdoutBytes: 16 };
    const code = `for (let i=0;i<100;i++) console.log("xxxxxxxxxxxxxxxx"); 1;`;
    const r = await runInSandbox(code, mockRegistry({}), new AbortController().signal, small);
    expect(r.ok).toBe(true);
    expect(Buffer.byteLength(r.stdout,"utf8")).toBeLessThanOrEqual(small.maxStdoutBytes + 64);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `cd plugins/llm-codemode-dispatch && bun test test/sandbox-host.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `sandbox-host.ts`**

```ts
import type { ToolsRegistryService } from "llm-events/public";
import type { CodeModeConfig } from "./config.ts";
import type { HostToWorker, WorkerToHost, InitMsg, ToolResultMsg } from "./rpc-types.ts";
import { wrapCode } from "./wrapper.ts";
import { truncate } from "./serialize.ts";

export type SandboxRunResult =
  | { ok: true; returnValue: unknown; stdout: string }
  | { ok: false; errorName: string; errorMessage: string; stdout: string };

const ENTRY_URL = new URL("./sandbox-entry.ts", import.meta.url).href;

export async function runInSandbox(
  userCode: string,
  registry: ToolsRegistryService,
  signal: AbortSignal,
  config: CodeModeConfig,
  emit?: (event: string, payload: unknown) => Promise<void>,
  turnId?: string,
): Promise<SandboxRunResult> {
  const wrap = wrapCode(userCode);
  if (wrap.transpileError) {
    return { ok: false, errorName: "SyntaxError", errorMessage: wrap.transpileError, stdout: "" };
  }

  const worker = new (globalThis as any).Worker(ENTRY_URL, { type: "module" });
  let stdout = "";
  let stdoutBytes = 0;
  let settled = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const inflightToolControllers = new Set<AbortController>();

  const cleanup = () => {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    try { worker.terminate(); } catch {}
    for (const ac of inflightToolControllers) { try { ac.abort(); } catch {} }
    inflightToolControllers.clear();
  };

  return new Promise<SandboxRunResult>((resolve, reject) => {
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      const err = new Error("aborted");
      (err as any).name = "AbortError";
      reject(err);
    };
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener("abort", onAbort, { once: true });

    timeoutHandle = setTimeout(() => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      cleanup();
      resolve({ ok: false, errorName: "TimeoutError", errorMessage: `code did not complete within ${config.timeoutMs}ms`, stdout });
    }, config.timeoutMs);

    worker.onmessage = async (ev: MessageEvent<WorkerToHost>) => {
      const msg = ev.data;
      if (msg.type === "stdout") {
        if (stdoutBytes >= config.maxStdoutBytes) return;
        const remaining = config.maxStdoutBytes - stdoutBytes;
        const slice = Buffer.byteLength(msg.chunk, "utf8") <= remaining ? msg.chunk : msg.chunk.slice(0, remaining);
        stdout += slice;
        stdoutBytes += Buffer.byteLength(slice, "utf8");
        return;
      }
      if (msg.type === "tool-invoke") {
        const ac = new AbortController();
        inflightToolControllers.add(ac);
        try {
          const value = await registry.invoke(msg.name, msg.args, {
            signal: ac.signal,
            callId: msg.id,
            turnId,
            log: (m) => { /* surface via emit if desired */ void emit?.("status:item-update", { key: `tool:${msg.id}`, value: m }); },
          });
          worker.postMessage({ type: "tool-result", id: msg.id, ok: true, value } satisfies ToolResultMsg);
        } catch (err) {
          worker.postMessage({
            type: "tool-result",
            id: msg.id,
            ok: false,
            error: { name: (err as Error)?.name ?? "Error", message: String((err as Error)?.message ?? err) },
          } satisfies ToolResultMsg);
        } finally {
          inflightToolControllers.delete(ac);
        }
        return;
      }
      if (msg.type === "done") {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        cleanup();
        resolve({ ok: true, returnValue: msg.returnValue, stdout: truncate(stdout, config.maxStdoutBytes) });
        return;
      }
      if (msg.type === "error") {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        cleanup();
        resolve({ ok: false, errorName: msg.name, errorMessage: msg.message, stdout: truncate(stdout, config.maxStdoutBytes) });
        return;
      }
    };

    worker.onerror = (e: ErrorEvent) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      cleanup();
      resolve({ ok: false, errorName: "WorkerCrash", errorMessage: e?.message ?? "worker crashed", stdout });
    };

    const init: InitMsg = { type: "init", wrappedCode: wrap.wrapped, maxStdoutBytes: config.maxStdoutBytes };
    worker.postMessage(init satisfies HostToWorker);
  });
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `cd plugins/llm-codemode-dispatch && bun test test/sandbox-host.test.ts`
Expected: PASS. All Worker-based tests must pass; this is the load-bearing safety surface.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-codemode-dispatch/sandbox-host.ts plugins/llm-codemode-dispatch/test/sandbox-host.test.ts
git commit -m "feat(llm-codemode-dispatch): sandbox host — Worker spawn, RPC, timeouts, abort"
```

---

## Task 10: prepareRequest

**Files:**
- Create: `plugins/llm-codemode-dispatch/prepare-request.ts`
- Create: `plugins/llm-codemode-dispatch/test/prepare-request.test.ts`

- [ ] **Step 1: Write the failing test**

`test/prepare-request.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { prepareRequest } from "../prepare-request.ts";
import simple from "./fixtures/tools-simple.json" with { type: "json" };
import type { ToolSchema } from "llm-events/public";

describe("prepareRequest", () => {
  it("does NOT populate tools (native is for that)", async () => {
    const r = await prepareRequest({ availableTools: simple as ToolSchema[] });
    expect(r.tools).toBeUndefined();
  });

  it("emits a systemPromptAppend with preamble + .d.ts + example", async () => {
    const r = await prepareRequest({ availableTools: simple as ToolSchema[] });
    expect(r.systemPromptAppend).toContain("sandboxed TypeScript runtime");
    expect(r.systemPromptAppend).toContain("declare const kaizen");
    expect(r.systemPromptAppend).toMatch(/```typescript/);
    expect(r.systemPromptAppend).toContain("[code execution result]");
  });

  it("empty tools still produces a (degenerate) prompt with no methods", async () => {
    const r = await prepareRequest({ availableTools: [] });
    expect(r.systemPromptAppend).toContain("declare const kaizen");
  });

  it("deterministic across calls", async () => {
    const a = await prepareRequest({ availableTools: simple as ToolSchema[] });
    const b = await prepareRequest({ availableTools: simple as ToolSchema[] });
    expect(a.systemPromptAppend).toBe(b.systemPromptAppend);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `cd plugins/llm-codemode-dispatch && bun test test/prepare-request.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `prepare-request.ts`**

```ts
import type { ToolSchema } from "llm-events/public";
import { renderDts } from "./dts-render.ts";

const PREAMBLE = `You have access to a sandboxed TypeScript runtime. To use a tool, write a single \`\`\`typescript code block. The code is executed in order; the value of the last expression (or any explicit \`return\` from a top-level statement) is returned to you as the tool result. Use \`console.log\` to surface intermediate output. Only one set of \`\`\`typescript blocks per turn will be executed; if you write none, your reply is treated as a final answer to the user.

After you emit a code block, you will see a message from the user starting with \`[code execution result]\`. Treat it as the runtime's response, not a new request from the human.

The following API is available:`;

const EXAMPLE = `Example:
\`\`\`typescript
const contents = await kaizen.tools.readFile({ path: "/etc/hostname" });
console.log("read", contents.length, "bytes");
contents;
\`\`\``;

export async function prepareRequest(input: { availableTools: ToolSchema[] }): Promise<{ tools?: ToolSchema[]; systemPromptAppend?: string }> {
  const dts = await renderDts(input.availableTools);
  const systemPromptAppend = `${PREAMBLE}\n\n\`\`\`typescript\n${dts}\n\`\`\`\n\n${EXAMPLE}\n`;
  return { systemPromptAppend };
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `cd plugins/llm-codemode-dispatch && bun test test/prepare-request.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-codemode-dispatch/prepare-request.ts plugins/llm-codemode-dispatch/test/prepare-request.test.ts
git commit -m "feat(llm-codemode-dispatch): prepareRequest renders system-prompt append with .d.ts API"
```

---

## Task 11: handleResponse with mock sandbox

**Files:**
- Create: `plugins/llm-codemode-dispatch/handle-response.ts`
- Create: `plugins/llm-codemode-dispatch/test/handle-response.test.ts`

- [ ] **Step 1: Write the failing test**

`test/handle-response.test.ts`:

```ts
import { describe, it, expect, mock } from "bun:test";
import { makeHandleResponse } from "../handle-response.ts";
import type { ToolsRegistryService, ToolSchema, LLMResponse } from "llm-events/public";
import { DEFAULT_CONFIG } from "../config.ts";

function mockRegistry(handlers: Record<string, (a: any) => unknown> = {}): ToolsRegistryService {
  return {
    register: () => () => {},
    list: () => [] as ToolSchema[],
    invoke: async (name, args) => {
      const h = handlers[name];
      if (!h) throw new Error(`unknown tool: ${name}`);
      return h(args);
    },
  };
}

const ac = () => new AbortController();
const noopEmit = mock(async () => {});

describe("handleResponse", () => {
  it("no code → returns []", async () => {
    const fakeRun = mock(async () => ({ ok: true, returnValue: undefined, stdout: "" }));
    const handle = makeHandleResponse(DEFAULT_CONFIG, fakeRun as any);
    const resp: LLMResponse = { content: "Just text.", finishReason: "stop" };
    const out = await handle({ response: resp, registry: mockRegistry(), signal: ac().signal, emit: noopEmit });
    expect(out).toEqual([]);
    expect(fakeRun).not.toHaveBeenCalled();
  });

  it("one block → emits codemode events and returns one user message", async () => {
    const events: string[] = [];
    const emit = mock(async (name: string) => { events.push(name); });
    const fakeRun = mock(async () => ({ ok: true, returnValue: 42, stdout: "hello\n" }));
    const handle = makeHandleResponse(DEFAULT_CONFIG, fakeRun as any);
    const resp: LLMResponse = { content: "```typescript\n1+1;\n```", finishReason: "stop" };
    const out = await handle({ response: resp, registry: mockRegistry(), signal: ac().signal, emit: emit as any });
    expect(out.length).toBe(1);
    expect(out[0].role).toBe("user");
    expect(out[0].content).toContain("[code execution result]");
    expect(out[0].content).toContain("returned: 42");
    expect(out[0].content).toContain("hello");
    expect(events).toContain("codemode:code-emitted");
    expect(events).toContain("codemode:before-execute");
    expect(events).toContain("codemode:result");
  });

  it("before-execute subscriber may mutate code", async () => {
    let observedCode = "";
    const emit = mock(async (name: string, payload: any) => {
      if (name === "codemode:before-execute") payload.code = `throw new Error("blocked")`;
    });
    const fakeRun = mock(async (code: string) => {
      observedCode = code;
      return { ok: false, errorName: "Error", errorMessage: "blocked", stdout: "" };
    });
    const handle = makeHandleResponse(DEFAULT_CONFIG, fakeRun as any);
    const resp: LLMResponse = { content: "```typescript\n1+1;\n```", finishReason: "stop" };
    const out = await handle({ response: resp, registry: mockRegistry(), signal: ac().signal, emit: emit as any });
    expect(observedCode).toBe(`throw new Error("blocked")`);
    expect(out[0].content).toContain("exit: error");
    expect(out[0].content).toContain("blocked");
  });

  it("error path emits codemode:error", async () => {
    const events: { name: string; payload: any }[] = [];
    const emit = mock(async (name: string, payload: unknown) => { events.push({ name, payload }); });
    const fakeRun = mock(async () => ({ ok: false, errorName: "TypeError", errorMessage: "boom", stdout: "" }));
    const handle = makeHandleResponse(DEFAULT_CONFIG, fakeRun as any);
    const resp: LLMResponse = { content: "```typescript\nbad();\n```", finishReason: "stop" };
    await handle({ response: resp, registry: mockRegistry(), signal: ac().signal, emit: emit as any });
    expect(events.some((e) => e.name === "codemode:error")).toBe(true);
  });

  it("respects maxBlocksPerResponse and reports ignored count in feedback", async () => {
    const fakeRun = mock(async () => ({ ok: true, returnValue: 1, stdout: "" }));
    const cfg = { ...DEFAULT_CONFIG, maxBlocksPerResponse: 2 };
    const handle = makeHandleResponse(cfg, fakeRun as any);
    const blocks = Array(5).fill(0).map((_,i) => "```typescript\n"+i+";\n```").join("\n");
    const out = await handle({ response: { content: blocks, finishReason: "stop" }, registry: mockRegistry(), signal: ac().signal, emit: noopEmit as any });
    expect(out[0].content).toContain("note: 3 additional code block(s) were ignored because the limit is 2");
  });

  it("AbortError from sandbox propagates as throw (turn cancellation)", async () => {
    const fakeRun = mock(async () => { const e: any = new Error("aborted"); e.name = "AbortError"; throw e; });
    const handle = makeHandleResponse(DEFAULT_CONFIG, fakeRun as any);
    const resp: LLMResponse = { content: "```typescript\n1;\n```", finishReason: "stop" };
    await expect(handle({ response: resp, registry: mockRegistry(), signal: ac().signal, emit: noopEmit as any })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `cd plugins/llm-codemode-dispatch && bun test test/handle-response.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `handle-response.ts`**

```ts
import type { ChatMessage, LLMResponse, ToolsRegistryService } from "llm-events/public";
import type { CodeModeConfig } from "./config.ts";
import type { SandboxRunResult } from "./sandbox-host.ts";
import { extractCodeBlocks } from "./extractor.ts";
import { formatResultMessage } from "./serialize.ts";

export type RunInSandbox = (
  code: string,
  registry: ToolsRegistryService,
  signal: AbortSignal,
  config: CodeModeConfig,
  emit?: (event: string, payload: unknown) => Promise<void>,
) => Promise<SandboxRunResult>;

export interface HandleResponseInput {
  response: LLMResponse;
  registry: ToolsRegistryService;
  signal: AbortSignal;
  emit: (event: string, payload: unknown) => Promise<void>;
}

export function makeHandleResponse(config: CodeModeConfig, runner: RunInSandbox) {
  return async function handleResponse(input: HandleResponseInput): Promise<ChatMessage[]> {
    const { code, ignoredCount } = extractCodeBlocks(input.response.content ?? "", config.maxBlocksPerResponse);
    if (!code) return [];

    await input.emit("codemode:code-emitted", { code, language: "typescript" });

    const beforeExec: { code: string } = { code };
    await input.emit("codemode:before-execute", beforeExec);
    const finalCode = beforeExec.code;

    let result: SandboxRunResult;
    try {
      result = await runner(finalCode, input.registry, input.signal, config, input.emit);
    } catch (err) {
      // AbortError or unexpected — rethrow so driver handles cancellation
      throw err;
    }

    if (result.ok) {
      await input.emit("codemode:result", { stdout: result.stdout, returnValue: result.returnValue });
      const content = formatResultMessage(
        { ok: true, returnValue: result.returnValue, stdout: result.stdout, ignoredBlocks: ignoredCount },
        { maxStdoutBytes: config.maxStdoutBytes, maxReturnBytes: config.maxReturnBytes, maxBlocksPerResponse: config.maxBlocksPerResponse },
      );
      return [{ role: "user", content }];
    } else {
      await input.emit("codemode:error", { message: `${result.errorName}: ${result.errorMessage}` });
      const content = formatResultMessage(
        { ok: false, errorName: result.errorName, errorMessage: result.errorMessage, stdout: result.stdout, ignoredBlocks: ignoredCount },
        { maxStdoutBytes: config.maxStdoutBytes, maxReturnBytes: config.maxReturnBytes, maxBlocksPerResponse: config.maxBlocksPerResponse },
      );
      return [{ role: "user", content }];
    }
  };
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `cd plugins/llm-codemode-dispatch && bun test test/handle-response.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-codemode-dispatch/handle-response.ts plugins/llm-codemode-dispatch/test/handle-response.test.ts
git commit -m "feat(llm-codemode-dispatch): handleResponse — extract→emit→sandbox→format"
```

---

## Task 12: Wire service.ts and index.ts

**Files:**
- Modify: `plugins/llm-codemode-dispatch/service.ts`
- Modify: `plugins/llm-codemode-dispatch/index.ts`
- Modify: `plugins/llm-codemode-dispatch/test/service.test.ts`

- [ ] **Step 1: Extend `service.test.ts` to assert real wiring**

Append to existing `test/service.test.ts`:

```ts
import { DEFAULT_CONFIG } from "../config.ts";

describe("service wiring", () => {
  it("makeStrategy returns prepareRequest + handleResponse using config", async () => {
    const { makeStrategy } = await import("../service.ts");
    const strat = makeStrategy(DEFAULT_CONFIG, { log: () => {} });
    const r = await strat.prepareRequest({ availableTools: [] });
    expect(r.systemPromptAppend).toContain("declare const kaizen");
    // handleResponse with no code returns []
    const out = await strat.handleResponse({
      response: { content: "no code", finishReason: "stop" } as any,
      registry: { register: () => () => {}, list: () => [], invoke: async () => undefined } as any,
      signal: new AbortController().signal,
      emit: async () => {},
    });
    expect(out).toEqual([]);
  });
});
```

- [ ] **Step 2: Replace `service.ts`**

```ts
import type { ToolDispatchStrategy } from "llm-events/public";
import type { CodeModeConfig } from "./config.ts";
import { prepareRequest } from "./prepare-request.ts";
import { makeHandleResponse } from "./handle-response.ts";
import { runInSandbox } from "./sandbox-host.ts";

export function makeStrategy(config: CodeModeConfig, _deps: { log: (m: string) => void }): ToolDispatchStrategy {
  const handleResponse = makeHandleResponse(config, runInSandbox);
  return {
    prepareRequest(input) { return prepareRequest(input) as any; }, // sync interface returns Promise — driver awaits
    handleResponse,
  };
}
```

NOTE: `ToolDispatchStrategy.prepareRequest` is synchronous in Spec 0. We resolve this by making `renderDts` synchronous OR by changing the cast. Choose: make `renderDts` return `string` synchronously by awaiting `compile` once and caching — but `compile` is async in `json-schema-to-typescript`. Resolution: the returned Promise IS the prepared request — drivers should `await`. Since Spec 0 declares `prepareRequest` sync, we adopt this interpretation: `prepareRequest` may return a Promise; the driver awaits it. If Spec 0's Promise-return is ambiguous, file a Spec 0 propagation note (per Spec 0's propagation rule). For this plan we **return a Promise** and the test in Step 1 awaits it. (Empirically the Spec 0 type is `({...}) => { tools?, systemPromptAppend? }` — sync. If the implementation needs async, this is a Spec 0 propagation. The plan here returns sync by pre-warming the renderer cache during `setup`.)

**Resolution for the plan:** pre-warm in `setup` is impossible (we don't know `availableTools` at setup time). Instead, change the strategy's `prepareRequest` to do the render synchronously by using a **synchronous wrapper** around `json-schema-to-typescript`'s default export. The `compile` API is async but the underlying work is CPU-only and small; if needed, we synchronously call its internals. To stay robust and simple, **mark this as a Spec 0 propagation candidate** and proceed by widening the local `ToolDispatchStrategy` type via a `Promise`-tolerant cast inside `service.ts`. Add a TODO comment referencing Spec 0 propagation.

Adjusted `service.ts`:

```ts
import type { ToolDispatchStrategy } from "llm-events/public";
import type { CodeModeConfig } from "./config.ts";
import { prepareRequest } from "./prepare-request.ts";
import { makeHandleResponse } from "./handle-response.ts";
import { runInSandbox } from "./sandbox-host.ts";

// Spec 0 propagation candidate: prepareRequest is typed sync but DTS rendering
// is async (json-schema-to-typescript). We return a Promise here; the driver
// awaits. If Spec 0 stays strict-sync, switch to a sync DTS renderer.
export function makeStrategy(config: CodeModeConfig, _deps: { log: (m: string) => void }): ToolDispatchStrategy {
  const handleResponse = makeHandleResponse(config, runInSandbox);
  const strategy: ToolDispatchStrategy = {
    // Cast: we return Promise<{...}>; driver MUST await.
    prepareRequest: ((input: any) => prepareRequest(input)) as any,
    handleResponse,
  };
  return strategy;
}
```

- [ ] **Step 3: Update `index.ts` to load real config**

```ts
import type { KaizenPlugin } from "kaizen/types";
import type { ToolDispatchStrategy } from "llm-events/public";
import { loadConfig, realDeps } from "./config.ts";
import { makeStrategy } from "./service.ts";

const plugin: KaizenPlugin = {
  name: "llm-codemode-dispatch",
  apiVersion: "3.0.0",
  permissions: { tier: "unscoped" },
  services: { provides: ["tool-dispatch:strategy"] },

  async setup(ctx) {
    const config = await loadConfig(realDeps((m) => ctx.log(m)));
    ctx.defineService("tool-dispatch:strategy", {
      description: "Code-mode tool dispatch (LLM writes TS calling kaizen.tools.*).",
    });
    ctx.provideService<ToolDispatchStrategy>(
      "tool-dispatch:strategy",
      makeStrategy(config, { log: (m) => ctx.log(m) }),
    );
  },
};

export default plugin;
```

- [ ] **Step 4: Run all tests**

Run: `cd plugins/llm-codemode-dispatch && bun test`
Expected: PASS for all suites except the e2e suite (Task 14, not yet written).

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-codemode-dispatch/service.ts plugins/llm-codemode-dispatch/index.ts plugins/llm-codemode-dispatch/test/service.test.ts
git commit -m "feat(llm-codemode-dispatch): wire prepareRequest+handleResponse into service+plugin"
```

---

## Task 13: public.d.ts

**Files:**
- Modify: `plugins/llm-codemode-dispatch/public.d.ts` (currently empty/missing — create)

- [ ] **Step 1: Write `public.d.ts`**

```ts
export interface CodeModeConfig {
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxReturnBytes?: number;
  maxBlocksPerResponse?: number;
  sandbox?: "bun-worker";
}
```

- [ ] **Step 2: Commit**

```bash
git add plugins/llm-codemode-dispatch/public.d.ts
git commit -m "feat(llm-codemode-dispatch): public.d.ts exports CodeModeConfig"
```

---

## Task 14: End-to-end Worker tests (real Bun Worker, real wrapped code)

**Files:**
- Create: `plugins/llm-codemode-dispatch/test/e2e-sandbox.test.ts`

These tests exercise the real sandbox-entry through `runInSandbox` with adversarial inputs. Sandbox-host tests (Task 9) already cover most paths; this task adds the goldens that lock in safety properties.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "bun:test";
import { runInSandbox } from "../sandbox-host.ts";
import { DEFAULT_CONFIG } from "../config.ts";
import type { ToolsRegistryService, ToolSchema } from "llm-events/public";

const reg = (h: Record<string, (a:any)=>any> = {}): ToolsRegistryService => ({
  register: () => () => {},
  list: () => [] as ToolSchema[],
  invoke: async (n, a) => { const fn = h[n]; if (!fn) throw new Error(`unknown tool: ${n}`); return fn(a); },
});
const cfg = { ...DEFAULT_CONFIG, timeoutMs: 2000 };

describe("e2e sandbox safety", () => {
  it("dynamic import('node:fs') is rejected at wrap time", async () => {
    const r = await runInSandbox(`await import('node:fs')`, reg(), new AbortController().signal, cfg);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorName).toBe("SyntaxError");
  });

  it("static import is rejected at wrap time", async () => {
    const r = await runInSandbox(`import x from 'node:fs'`, reg(), new AbortController().signal, cfg);
    expect(r.ok).toBe(false);
  });

  it("require() is rejected", async () => {
    const r = await runInSandbox(`require('node:fs')`, reg(), new AbortController().signal, cfg);
    expect(r.ok).toBe(false);
  });

  it("process is undefined inside worker", async () => {
    const r = await runInSandbox(`typeof process`, reg(), new AbortController().signal, cfg);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.returnValue).toBe("undefined");
  });

  it("Bun is undefined inside worker", async () => {
    const r = await runInSandbox(`typeof Bun`, reg(), new AbortController().signal, cfg);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.returnValue).toBe("undefined");
  });

  it("fetch is undefined inside worker", async () => {
    const r = await runInSandbox(`typeof fetch`, reg(), new AbortController().signal, cfg);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.returnValue).toBe("undefined");
  });

  it("setInterval is undefined inside worker", async () => {
    const r = await runInSandbox(`typeof setInterval`, reg(), new AbortController().signal, cfg);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.returnValue).toBe("undefined");
  });

  it("setTimeout is allowed", async () => {
    const r = await runInSandbox(`await new Promise(r => setTimeout(r, 5)); 7;`, reg(), new AbortController().signal, cfg);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.returnValue).toBe(7);
  });

  it("kaizen.tools proxy fails for unregistered tool with registry message", async () => {
    const r = await runInSandbox(`try { await kaizen.tools.nope({}); 'unreachable' } catch (e) { (e as any).message }`, reg(), new AbortController().signal, cfg);
    expect(r.ok).toBe(true);
    if (r.ok) expect(String(r.returnValue)).toContain("unknown tool: nope");
  });

  it("multiple tool calls run sequentially and propagate values", async () => {
    let counter = 0;
    const r = await runInSandbox(
      `const a = await kaizen.tools.inc({}); const b = await kaizen.tools.inc({}); [a,b];`,
      reg({ inc: () => ++counter }),
      new AbortController().signal,
      cfg,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.returnValue).toEqual([1,2]);
  });

  it("infinite loop is killed by timeout, error name is TimeoutError", async () => {
    const r = await runInSandbox(`while(true){}`, reg(), new AbortController().signal, { ...cfg, timeoutMs: 150 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorName).toBe("TimeoutError");
  });

  it("AbortSignal mid-execution rejects with AbortError", async () => {
    const ac = new AbortController();
    const sleeper = (a: any) => new Promise((res) => setTimeout(() => res(a), 5000));
    setTimeout(() => ac.abort(), 30);
    await expect(runInSandbox(`await kaizen.tools.sleep({})`, reg({ sleep: sleeper as any }), ac.signal, cfg)).rejects.toThrow(/abort/i);
  });
});
```

- [ ] **Step 2: Run test**

Run: `cd plugins/llm-codemode-dispatch && bun test test/e2e-sandbox.test.ts`
Expected: PASS. Any failure here is a sandbox-safety bug — fix at the source (sandbox-entry.ts curated globals or wrapper.ts forbidden patterns), do NOT loosen the test.

- [ ] **Step 3: Commit**

```bash
git add plugins/llm-codemode-dispatch/test/e2e-sandbox.test.ts
git commit -m "test(llm-codemode-dispatch): e2e sandbox safety goldens (real Worker)"
```

---

## Task 15: Marketplace catalog + README

**Files:**
- Modify: `.kaizen/marketplace.json`
- Create: `plugins/llm-codemode-dispatch/README.md`

- [ ] **Step 1: Add marketplace entry**

Edit `.kaizen/marketplace.json`. Inside the `entries` array, after the `openai-llm` entry, add:

```json
{
  "kind": "plugin",
  "name": "llm-codemode-dispatch",
  "description": "Code-mode tool dispatch: LLM writes TypeScript calling kaizen.tools.* in a Bun Worker sandbox. Default dispatch strategy for local LLMs.",
  "categories": ["llm", "tool-dispatch"],
  "versions": [{ "version": "0.1.0", "source": { "type": "file", "path": "plugins/llm-codemode-dispatch" } }]
}
```

- [ ] **Step 2: Write README**

`plugins/llm-codemode-dispatch/README.md`:

```markdown
# llm-codemode-dispatch

Default tool-dispatch strategy for the openai-compatible harness. Instead of asking
the LLM to emit OpenAI-style structured `tool_calls` JSON, this plugin gives the
LLM a typed `kaizen.tools.*` TypeScript API (rendered as `.d.ts` from each tool's
JSON Schema), extracts fenced ` ```typescript ` blocks from the response, and
executes them in a Bun Worker sandbox whose tool calls proxy back to
`tools:registry` over `postMessage` RPC.

Local LLMs (Llama, Qwen, Mistral classes) are notably worse at OpenAI tool-call
JSON than they are at writing small TypeScript snippets, so code mode is the
default for the C-tier harness.

## Sandboxing

The sandbox is a Bun Worker with a curated `globalThis` (no `Bun`, `process`,
`require`, `fetch`, `setInterval`, dynamic `import()`, `eval`, `Function`).
Wall-clock timeout (default 30s) is enforced via `worker.terminate()`.
`AbortSignal` aborts the worker and any in-flight tool calls. This is sufficient
for the documented threat model (the LLM is unreliable, not adversarial). For an
adversarial threat model, see the deferred `codemode.sandbox = "quickjs"` toggle.

## Config

`~/.kaizen/plugins/llm-codemode-dispatch/config.json`:

| Key | Default |
|---|---|
| `timeoutMs` | `30000` |
| `maxStdoutBytes` | `16384` |
| `maxReturnBytes` | `4096` |
| `maxBlocksPerResponse` | `8` |
| `sandbox` | `"bun-worker"` |

Override config path via `KAIZEN_LLM_CODEMODE_CONFIG`.
```

- [ ] **Step 3: Validate marketplace JSON**

Run: `python3 -c "import json; json.load(open('.kaizen/marketplace.json'))"`
Expected: no output (valid JSON).

- [ ] **Step 4: Run full test suite one more time**

Run: `cd plugins/llm-codemode-dispatch && bun test`
Expected: PASS (all suites).

- [ ] **Step 5: Commit**

```bash
git add .kaizen/marketplace.json plugins/llm-codemode-dispatch/README.md
git commit -m "chore(marketplace): publish llm-codemode-dispatch@0.1.0"
```

---

## Self-Review Checklist (executed during plan authoring)

1. **Spec coverage**:
   - `prepareRequest` returning `systemPromptAppend` only → Tasks 10, 12.
   - `kaizen.tools.<name>` namespace incl. bracket-quoted non-identifier names → Task 3.
   - `json-schema-to-typescript` library, deterministic, cached → Task 3.
   - PascalCase + numeric-suffix collision resolution → Task 3 test.
   - Multi-block concatenation with `\n;\n`, ts/typescript/js/javascript case-insensitive, mdast (not regex) → Task 4.
   - Bun Worker sandbox, curated globals, console capture, RPC, timeout, abort → Tasks 7, 8, 9, 14.
   - Trailing-expression-to-return AST rewrite, forbidden-syntax guard → Task 5.
   - Result message `[code execution result]` shape, `role:"user"`, `undefined`/`bigint`/circular handling, truncation → Task 6, 11.
   - Events: `codemode:code-emitted`, `codemode:before-execute` (mutable), `codemode:result`, `codemode:error` → Task 11.
   - `maxBlocksPerResponse` cap with note in feedback → Tasks 4, 6, 11.
   - `permissions: unscoped`, single service `tool-dispatch:strategy` → Task 1.
   - Cancellation rethrows AbortError, terminates worker, aborts in-flight tool signals → Task 9, 11, 14.
   - Config keys + defaults → Task 2.

2. **Placeholder scan**: every code step contains complete code; no "TBD" / "appropriate" / "similar to". The Spec-0-propagation note in Task 12 is concrete (cast + TODO comment + fallback option), not handwavy.

3. **Type consistency**:
   - `SandboxRunResult` defined in Task 9, consumed in Task 11 — same shape.
   - `RunInSandbox` signature in Task 11 matches `runInSandbox` exported from Task 9.
   - `WrapResult` in Task 5 matches consumer in Task 9.
   - `HostToWorker` / `WorkerToHost` in Task 7 match producers/consumers in Tasks 8, 9.
   - `CodeModeConfig` in Task 2 is consumed by Tasks 9, 11, 12, 13.
   - `formatResultMessage` caps argument shape consistent across Tasks 6 and 11.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-30-llm-codemode-dispatch.md`. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session using executing-plans, batch with checkpoints.

Which approach?
