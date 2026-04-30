# llm-mcp-bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement v0 of the `llm-mcp-bridge` Kaizen plugin (Spec 11) — own the lifecycle of one or more MCP servers configured in `~/.kaizen/mcp/servers.json` and re-publish their **tools and resources** (NOT prompts) into `tools:registry` as namespaced kaizen tools.

**Architecture:** Capability plugin (Tier 3) that, on `setup`, loads MCP config, instantiates one MCP client per enabled server (stdio/SSE/HTTP), and runs each through a state-machine lifecycle (`disabled → connecting → connected ↔ reconnecting → quarantined`). On `connected`, it lists tools and registers them as `mcp:<server>:<tool>` in `tools:registry`. Resources are surfaced via two universal tools (`read_mcp_resource`, `list_mcp_resources`) registered once globally. The plugin is **passive** after registration — health checks, reconnects, and `/mcp:reload` are the only re-engagements. Module boundaries match Spec 11's lifecycle phases for testability.

**Tech Stack:** TypeScript, Bun runtime, `@modelcontextprotocol/sdk` (pinned), Node `child_process` (via SDK transports), `bun:test`. No file watchers; reload is explicit.

---

## Prerequisites & Tier-for-Parallelism Map

This plan implements one plugin (`llm-mcp-bridge`) and assumes:
- `llm-events` (Spec 0) already exists on disk (created by Task 1 of `2026-04-30-openai-llm.md`).
- `llm-tools-registry` (Spec 4) is being implemented separately. **This plan does not assume it is on disk yet.** Instead, it depends on the `ToolsRegistryService` interface signature from `llm-events/public.d.ts`. At runtime, the bridge consumes `tools:registry` via `ctx.useService("tools:registry")`. If the service is missing at `setup`, the bridge logs an error and registers no tools (graceful degradation; harness still starts). Integration is verified end-to-end only when both plugins run in a harness — outside this plan.
- `llm-slash-commands` (Spec 8) — soft dependency. If absent, `/mcp:*` commands are not registered.

Tiers below indicate what may run in parallel (no shared writes, no read-after-write):

- **Tier 0** (sequential, blocks all others): Task 1 (scaffold plugin skeleton + package.json + tsconfig + placeholders).
- **Tier 1A** (parallel, leaf modules — no inter-task imports): Task 2 (`config.ts`), Task 3 (`names.ts` validators), Task 4 (`backoff.ts`), Task 5 (`mockServer.ts` test harness).
- **Tier 1B** (parallel after 1A): Task 6 (`client.ts` transport factory — depends on nothing internal but used by the lifecycle), Task 7 (`registration.ts` — translation pure functions, depends on `names.ts`).
- **Tier 1C** (sequential, integrates): Task 8 (`lifecycle.ts` state machine — depends on `client.ts`, `backoff.ts`, `registration.ts`), Task 9 (`service.ts` — `McpBridgeService` impl), Task 10 (`slash.ts` — slash command handlers), Task 11 (`index.ts` — plugin glue), Task 12 (`public.d.ts` re-exports), Task 13 (integration test against `@modelcontextprotocol/server-everything`), Task 14 (marketplace catalog + README).

## File Structure

```
plugins/llm-mcp-bridge/
  index.ts            # KaizenPlugin entry: load config, start lifecycle per server, provide mcp:bridge service
  public.d.ts         # Re-exports ServerStatus, ServerInfo, McpBridgeService
  config.ts           # ConfigDeps, loadConfig, env interpolation, name validation, transport inference
  names.ts            # validateServerName, kaizenToolName(server, tool), MCP_NAME_RE
  backoff.ts          # computeBackoffMs(attempt) -> 1s,2s,4s,8s,...,60s; pure
  client.ts           # createClient(serverConfig) -> { client, transport }; abstracts SDK transport choice
  lifecycle.ts        # ServerLifecycle class: state machine (Phases 1-5), reconcile tools on (re)connect
  registration.ts     # toKaizenToolSchema(server, mcpTool), makeToolHandler(client, server, mcpToolName, timeoutMs)
                      # plus makeResourceTools(getClientByServer): registers read_mcp_resource + list_mcp_resources
  service.ts          # makeService(lifecycles): McpBridgeService { list, get, reconnect, reload, shutdown }
  slash.ts            # registerSlashCommands(slashRegistry, bridgeService) -> unregister[]
  package.json
  tsconfig.json
  README.md
  test/
    config.test.ts
    names.test.ts
    backoff.test.ts
    registration.test.ts
    lifecycle.test.ts
    service.test.ts
    slash.test.ts
    mockServer.ts                # in-process MCP server used by tests
    fixtures/
      servers.user.json
      servers.project.json
      servers.merged-expected.json
    integration/
      server-everything.test.ts  # gated on KAIZEN_INTEGRATION=1
```

Boundaries:
- `config.ts` is pure I/O + parse. No SDK imports.
- `names.ts` and `backoff.ts` are pure functions.
- `client.ts` is the only place that imports SDK transport classes.
- `registration.ts` contains pure translation functions plus a thin handler factory; the handler closes over a `client` reference (mutable, swapped on reconnect via a getter pattern, not a captured value).
- `lifecycle.ts` is the only stateful module besides `service.ts`. It owns timers, retry counters, and the registered-unregisters list per server.
- `service.ts` is the public surface aggregator.
- `slash.ts` only imports `service.ts`'s `McpBridgeService`.
- `index.ts` is the only file allowed to call `ctx.defineService` / `ctx.provideService` / `ctx.useService`.

`.kaizen/marketplace.json` is also modified (Task 14).

---

## Task 1: Scaffold `llm-mcp-bridge` plugin skeleton

**Files:**
- Create: `plugins/llm-mcp-bridge/package.json`
- Create: `plugins/llm-mcp-bridge/tsconfig.json`
- Create: `plugins/llm-mcp-bridge/index.ts` (placeholder)
- Create: `plugins/llm-mcp-bridge/public.d.ts` (placeholder)
- Create: `plugins/llm-mcp-bridge/README.md` (placeholder)

The placeholder files are needed so `bun install` and TypeScript can resolve the workspace package; module bodies are filled in by later tasks.

- [ ] **Step 1: Verify parent dirs**

Run: `ls plugins/openai-llm/package.json` (sanity that we're at the repo root).
Expected: file path printed.

- [ ] **Step 2: Write `plugins/llm-mcp-bridge/package.json`**

```json
{
  "name": "llm-mcp-bridge",
  "version": "0.1.0",
  "description": "Bridge MCP servers (tools + resources) into the kaizen tools:registry.",
  "type": "module",
  "exports": { ".": "./index.ts" },
  "keywords": ["kaizen-plugin"],
  "dependencies": {
    "llm-events": "workspace:*",
    "@modelcontextprotocol/sdk": "1.0.4"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "@types/json-schema": "^7.0.15",
    "typescript": "^5.4.0"
  }
}
```

Pin to `@modelcontextprotocol/sdk@1.0.4` — verify on npm before installing; if a newer 1.x is GA at execution time, pin to that. Document the chosen version in the README (Task 14).

- [ ] **Step 3: Write `plugins/llm-mcp-bridge/tsconfig.json`** (mirrors `plugins/openai-llm/tsconfig.json`):

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true
  }
}
```

- [ ] **Step 4: Write placeholder `plugins/llm-mcp-bridge/index.ts`**

```ts
import type { KaizenPlugin } from "kaizen/types";

const plugin: KaizenPlugin = {
  name: "llm-mcp-bridge",
  apiVersion: "3.0.0",
  permissions: { tier: "unscoped" },
  services: { provides: ["mcp:bridge"], consumes: ["tools:registry", "llm-events:vocabulary"] },
  async setup(ctx) {
    // Filled in by Task 11.
    ctx.defineService("mcp:bridge", { description: "Owns MCP server lifecycles; surfaces their tools and resources." });
  },
};

export default plugin;
```

- [ ] **Step 5: Write placeholder `plugins/llm-mcp-bridge/public.d.ts`**

```ts
export type ServerStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "quarantined"
  | "disabled";

export interface ServerInfo {
  name: string;
  transport: "stdio" | "sse" | "http";
  status: ServerStatus;
  toolCount: number;
  resourceCount: number;
  promptCount: number;
  lastError?: string;
  connectedAt?: number;
  reconnectAttempts: number;
}

export interface McpBridgeService {
  list(): ServerInfo[];
  get(name: string): ServerInfo | undefined;
  reconnect(name: string): Promise<void>;
  reload(): Promise<{ added: string[]; removed: string[]; updated: string[] }>;
  shutdown(name: string): Promise<void>;
}
```

- [ ] **Step 6: Write minimal placeholder README.md**

```markdown
# llm-mcp-bridge

v0 of the MCP bridge plugin. Implementation in progress; see
`docs/superpowers/plans/2026-04-30-llm-mcp-bridge.md`.
```

- [ ] **Step 7: Install + typecheck**

Run: `bun install`
Expected: lockfile updated, no errors.

Run: `bun --bun tsc --noEmit -p plugins/llm-mcp-bridge/tsconfig.json plugins/llm-mcp-bridge/index.ts plugins/llm-mcp-bridge/public.d.ts`
Expected: no diagnostics.

- [ ] **Step 8: Commit**

```bash
git add plugins/llm-mcp-bridge/
git commit -m "feat(llm-mcp-bridge): scaffold plugin skeleton"
```

---

## Task 2: `config.ts` — load + merge MCP server config files

**Files:**
- Create: `plugins/llm-mcp-bridge/config.ts`
- Create: `plugins/llm-mcp-bridge/test/config.test.ts`
- Create: `plugins/llm-mcp-bridge/test/fixtures/servers.user.json`
- Create: `plugins/llm-mcp-bridge/test/fixtures/servers.project.json`

`config.ts` exposes `loadConfig(deps)` which:
1. Resolves source files in priority order: `${KAIZEN_MCP_CONFIG}` (if set) → `<project>/.kaizen/mcp/servers.json` → `~/.kaizen/mcp/servers.json`.
2. Merges multiple files (later sources override earlier; project beats user; env-var override beats both).
3. Resolves `${env:VAR}` interpolation in string values.
4. Validates server names (`/^[a-z0-9][a-z0-9_-]*$/`).
5. Infers `transport` if omitted (`command` → `stdio`, `url` only → `http`).
6. Returns a `Map<string, ResolvedServerConfig>` plus a list of warnings/errors per server.

- [ ] **Step 1: Write fixtures**

`plugins/llm-mcp-bridge/test/fixtures/servers.user.json`:

```json
{
  "servers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      "env": { "DEBUG": "1" }
    },
    "github": {
      "transport": "sse",
      "url": "https://mcp.example.com/sse",
      "headers": { "Authorization": "Bearer ${env:TEST_TOKEN}" }
    },
    "disabled-server": {
      "command": "true",
      "enabled": false
    }
  }
}
```

`plugins/llm-mcp-bridge/test/fixtures/servers.project.json`:

```json
{
  "servers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/code"]
    },
    "internal-api": {
      "url": "http://localhost:8080/mcp",
      "headers": { "X-API-Key": "${env:INTERNAL_KEY}" }
    }
  }
}
```

- [ ] **Step 2: Write the failing tests**

`plugins/llm-mcp-bridge/test/config.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { loadConfig } from "../config.ts";
import { readFile } from "node:fs/promises";

function makeDeps(overrides: Partial<Parameters<typeof loadConfig>[0]> = {}) {
  const logs: string[] = [];
  return {
    home: "/home/u",
    cwd: "/proj",
    env: {} as Record<string, string | undefined>,
    readFile: async (p: string) => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
    log: (m: string) => logs.push(m),
    _logs: logs,
    ...overrides,
  };
}

describe("loadConfig", () => {
  it("returns empty map and logs info when no files exist", async () => {
    const deps = makeDeps();
    const result = await loadConfig(deps);
    expect(result.servers.size).toBe(0);
    expect(deps._logs.some((l) => l.includes("no MCP config"))).toBe(true);
  });

  it("loads user file when only ~/.kaizen/mcp/servers.json exists", async () => {
    const userJson = await readFile("plugins/llm-mcp-bridge/test/fixtures/servers.user.json", "utf8");
    const deps = makeDeps({
      readFile: async (p: string) => {
        if (p === "/home/u/.kaizen/mcp/servers.json") return userJson;
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
      env: { TEST_TOKEN: "tok123" },
    });
    const result = await loadConfig(deps);
    expect(result.servers.has("filesystem")).toBe(true);
    expect(result.servers.has("github")).toBe(true);
    expect(result.servers.get("github")!.headers!.Authorization).toBe("Bearer tok123");
    // Disabled server is in the map with status precursor "disabled"
    expect(result.servers.get("disabled-server")!.enabled).toBe(false);
  });

  it("project overrides user on conflict", async () => {
    const userJson = await readFile("plugins/llm-mcp-bridge/test/fixtures/servers.user.json", "utf8");
    const projJson = await readFile("plugins/llm-mcp-bridge/test/fixtures/servers.project.json", "utf8");
    const deps = makeDeps({
      readFile: async (p: string) => {
        if (p === "/home/u/.kaizen/mcp/servers.json") return userJson;
        if (p === "/proj/.kaizen/mcp/servers.json") return projJson;
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
      env: { TEST_TOKEN: "tok", INTERNAL_KEY: "k" },
    });
    const result = await loadConfig(deps);
    const fs = result.servers.get("filesystem")!;
    expect(fs.args).toEqual(["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/code"]);
    // user-only entries survive
    expect(result.servers.has("github")).toBe(true);
    // project-only entries are added
    expect(result.servers.has("internal-api")).toBe(true);
    expect(result.warnings.some((w) => w.includes("filesystem") && w.toLowerCase().includes("override"))).toBe(true);
  });

  it("KAIZEN_MCP_CONFIG env var overrides both", async () => {
    const userJson = await readFile("plugins/llm-mcp-bridge/test/fixtures/servers.user.json", "utf8");
    const deps = makeDeps({
      readFile: async (p: string) => {
        if (p === "/cfg/override.json") return userJson;
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
      env: { KAIZEN_MCP_CONFIG: "/cfg/override.json", TEST_TOKEN: "x" },
    });
    const result = await loadConfig(deps);
    expect(result.servers.has("filesystem")).toBe(true);
  });

  it("infers transport: command -> stdio, url -> http, explicit sse honored", async () => {
    const userJson = await readFile("plugins/llm-mcp-bridge/test/fixtures/servers.user.json", "utf8");
    const projJson = await readFile("plugins/llm-mcp-bridge/test/fixtures/servers.project.json", "utf8");
    const deps = makeDeps({
      readFile: async (p: string) => {
        if (p === "/home/u/.kaizen/mcp/servers.json") return userJson;
        if (p === "/proj/.kaizen/mcp/servers.json") return projJson;
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
      env: { TEST_TOKEN: "x", INTERNAL_KEY: "y" },
    });
    const result = await loadConfig(deps);
    expect(result.servers.get("filesystem")!.transport).toBe("stdio");
    expect(result.servers.get("github")!.transport).toBe("sse");
    expect(result.servers.get("internal-api")!.transport).toBe("http");
  });

  it("rejects invalid server names; keeps others", async () => {
    const deps = makeDeps({
      readFile: async (p: string) => {
        if (p === "/home/u/.kaizen/mcp/servers.json") {
          return JSON.stringify({
            servers: {
              "Bad Name!": { command: "true" },
              "ok-name": { command: "true" },
            },
          });
        }
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
    });
    const result = await loadConfig(deps);
    expect(result.servers.has("ok-name")).toBe(true);
    expect(result.servers.has("Bad Name!")).toBe(false);
    expect(result.warnings.some((w) => w.includes("Bad Name!"))).toBe(true);
  });

  it("missing env interpolation skips that server with warning", async () => {
    const deps = makeDeps({
      readFile: async (p: string) => {
        if (p === "/home/u/.kaizen/mcp/servers.json") {
          return JSON.stringify({
            servers: {
              "needs-env": {
                transport: "sse",
                url: "https://x",
                headers: { Authorization: "Bearer ${env:MISSING_VAR}" },
              },
              "fine": { command: "true" },
            },
          });
        }
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
    });
    const result = await loadConfig(deps);
    expect(result.servers.has("needs-env")).toBe(false);
    expect(result.servers.has("fine")).toBe(true);
    expect(result.warnings.some((w) => w.includes("MISSING_VAR"))).toBe(true);
  });

  it("malformed JSON in any source produces a warning, others continue", async () => {
    const deps = makeDeps({
      readFile: async (p: string) => {
        if (p === "/home/u/.kaizen/mcp/servers.json") return "not json{{";
        if (p === "/proj/.kaizen/mcp/servers.json") {
          return JSON.stringify({ servers: { "p": { command: "true" } } });
        }
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
    });
    const result = await loadConfig(deps);
    expect(result.servers.has("p")).toBe(true);
    expect(result.warnings.some((w) => w.toLowerCase().includes("malformed"))).toBe(true);
  });

  it("defaults: enabled=true, timeoutMs=30000, healthCheckMs=60000", async () => {
    const deps = makeDeps({
      readFile: async (p: string) => {
        if (p === "/home/u/.kaizen/mcp/servers.json") {
          return JSON.stringify({ servers: { "x": { command: "true" } } });
        }
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
    });
    const result = await loadConfig(deps);
    const x = result.servers.get("x")!;
    expect(x.enabled).toBe(true);
    expect(x.timeoutMs).toBe(30000);
    expect(x.healthCheckMs).toBe(60000);
  });
});
```

- [ ] **Step 3: Run tests to verify failure**

Run: `bun test plugins/llm-mcp-bridge/test/config.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write `config.ts`**

```ts
import { readFile as fsReadFile } from "node:fs/promises";

export type Transport = "stdio" | "sse" | "http";

export interface ResolvedServerConfig {
  name: string;
  transport: Transport;
  enabled: boolean;
  timeoutMs: number;
  healthCheckMs: number;
  // stdio
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  // sse / http
  url?: string;
  headers?: Record<string, string>;
}

export interface ConfigLoadResult {
  servers: Map<string, ResolvedServerConfig>;
  warnings: string[];
}

export interface ConfigDeps {
  home: string;
  cwd: string;
  env: Record<string, string | undefined>;
  readFile: (path: string) => Promise<string>;
  log: (msg: string) => void;
}

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
const ENV_INTERP_RE = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

interface FileRead {
  path: string;
  json: unknown | null;
  parseError?: string;
}

async function tryRead(deps: ConfigDeps, path: string): Promise<FileRead | null> {
  let raw: string;
  try {
    raw = await deps.readFile(path);
  } catch (err: any) {
    if (err?.code === "ENOENT") return null;
    return { path, json: null, parseError: String(err?.message ?? err) };
  }
  try {
    return { path, json: JSON.parse(raw) };
  } catch (err) {
    return { path, json: null, parseError: `malformed JSON: ${(err as Error).message}` };
  }
}

function interpolateEnv(value: string, env: Record<string, string | undefined>): { ok: true; out: string } | { ok: false; missing: string } {
  let missing: string | null = null;
  const out = value.replace(ENV_INTERP_RE, (_m, name: string) => {
    const v = env[name];
    if (v === undefined || v === "") {
      if (missing === null) missing = name;
      return "";
    }
    return v;
  });
  if (missing !== null) return { ok: false, missing };
  return { ok: true, out };
}

function deepInterpolate(node: unknown, env: Record<string, string | undefined>): { ok: true; out: unknown } | { ok: false; missing: string } {
  if (typeof node === "string") return interpolateEnv(node, env);
  if (Array.isArray(node)) {
    const out: unknown[] = [];
    for (const v of node) {
      const r = deepInterpolate(v, env);
      if (!r.ok) return r;
      out.push(r.out);
    }
    return { ok: true, out };
  }
  if (isPlainObject(node)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      const r = deepInterpolate(v, env);
      if (!r.ok) return r;
      out[k] = r.out;
    }
    return { ok: true, out };
  }
  return { ok: true, out: node };
}

function inferTransport(raw: Record<string, unknown>): Transport | null {
  const t = raw.transport;
  if (t === "stdio" || t === "sse" || t === "http") return t;
  if (t !== undefined) return null;
  if (typeof raw.command === "string") return "stdio";
  if (typeof raw.url === "string") return "http";
  return null;
}

function resolveOne(
  name: string,
  raw: Record<string, unknown>,
  env: Record<string, string | undefined>,
  warnings: string[],
): ResolvedServerConfig | null {
  const interp = deepInterpolate(raw, env);
  if (!interp.ok) {
    warnings.push(`server "${name}": missing env var \${env:${interp.missing}}; skipping`);
    return null;
  }
  const obj = interp.out as Record<string, unknown>;
  const transport = inferTransport(obj);
  if (!transport) {
    warnings.push(`server "${name}": cannot infer transport (need command or url); skipping`);
    return null;
  }
  const enabled = obj.enabled !== false;
  const timeoutMs = typeof obj.timeoutMs === "number" ? obj.timeoutMs : 30000;
  const healthCheckMs = typeof obj.healthCheckMs === "number" ? obj.healthCheckMs : 60000;
  const cfg: ResolvedServerConfig = { name, transport, enabled, timeoutMs, healthCheckMs };
  if (transport === "stdio") {
    if (typeof obj.command !== "string") {
      warnings.push(`server "${name}": stdio transport requires "command"; skipping`);
      return null;
    }
    cfg.command = obj.command;
    if (Array.isArray(obj.args)) cfg.args = obj.args.filter((x): x is string => typeof x === "string");
    if (isPlainObject(obj.env)) cfg.env = Object.fromEntries(Object.entries(obj.env).filter(([, v]) => typeof v === "string")) as Record<string, string>;
    if (typeof obj.cwd === "string") cfg.cwd = obj.cwd;
  } else {
    if (typeof obj.url !== "string") {
      warnings.push(`server "${name}": ${transport} transport requires "url"; skipping`);
      return null;
    }
    cfg.url = obj.url;
    if (isPlainObject(obj.headers)) cfg.headers = Object.fromEntries(Object.entries(obj.headers).filter(([, v]) => typeof v === "string")) as Record<string, string>;
  }
  return cfg;
}

export async function loadConfig(deps: ConfigDeps): Promise<ConfigLoadResult> {
  // Resolution: lowest priority first, highest last.
  // Order: user (lowest), project, env override (highest).
  const sources: string[] = [
    `${deps.home}/.kaizen/mcp/servers.json`,
    `${deps.cwd}/.kaizen/mcp/servers.json`,
  ];
  if (deps.env.KAIZEN_MCP_CONFIG) sources.push(deps.env.KAIZEN_MCP_CONFIG);

  const reads: FileRead[] = [];
  for (const p of sources) {
    const r = await tryRead(deps, p);
    if (r !== null) reads.push(r);
  }

  const warnings: string[] = [];
  const servers = new Map<string, ResolvedServerConfig>();

  if (reads.length === 0) {
    deps.log("llm-mcp-bridge: no MCP config files found; registering zero MCP servers");
    return { servers, warnings };
  }

  for (const r of reads) {
    if (r.parseError) {
      warnings.push(`config "${r.path}" malformed: ${r.parseError}; ignoring this file`);
      deps.log(`llm-mcp-bridge: ${r.parseError} at ${r.path}`);
      continue;
    }
    if (!isPlainObject(r.json)) {
      warnings.push(`config "${r.path}" must be a JSON object; ignoring`);
      continue;
    }
    const block = (r.json as Record<string, unknown>).servers;
    if (!isPlainObject(block)) {
      warnings.push(`config "${r.path}" missing "servers" object; ignoring`);
      continue;
    }
    for (const [name, raw] of Object.entries(block)) {
      if (!NAME_RE.test(name)) {
        warnings.push(`server name "${name}" invalid (must match ${NAME_RE}); skipping`);
        continue;
      }
      if (!isPlainObject(raw)) {
        warnings.push(`server "${name}": entry must be an object; skipping`);
        continue;
      }
      const resolved = resolveOne(name, raw, deps.env, warnings);
      if (!resolved) continue;
      if (servers.has(name)) {
        warnings.push(`server "${name}": override from ${r.path}`);
      }
      servers.set(name, resolved);
    }
  }

  return { servers, warnings };
}

export function realDeps(log: (msg: string) => void): ConfigDeps {
  return {
    home: process.env.HOME ?? "/",
    cwd: process.cwd(),
    env: process.env as Record<string, string | undefined>,
    readFile: (p) => fsReadFile(p, "utf8"),
    log,
  };
}
```

- [ ] **Step 5: Run tests**

Run: `bun test plugins/llm-mcp-bridge/test/config.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 6: Commit**

```bash
git add plugins/llm-mcp-bridge/config.ts plugins/llm-mcp-bridge/test/config.test.ts plugins/llm-mcp-bridge/test/fixtures/
git commit -m "feat(llm-mcp-bridge): config loader with project/user/env merge and env interpolation"
```

---

## Task 3: `names.ts` — server-name validation + kaizen tool naming

**Files:**
- Create: `plugins/llm-mcp-bridge/names.ts`
- Create: `plugins/llm-mcp-bridge/test/names.test.ts`

- [ ] **Step 1: Write the failing test**

`plugins/llm-mcp-bridge/test/names.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { isValidServerName, kaizenToolName, kaizenToolTags, MCP_NAME_RE } from "../names.ts";

describe("names", () => {
  it("MCP_NAME_RE matches lowercase alnum + _ + - starting alnum", () => {
    expect(MCP_NAME_RE.test("filesystem")).toBe(true);
    expect(MCP_NAME_RE.test("github_v2")).toBe(true);
    expect(MCP_NAME_RE.test("a-b-c")).toBe(true);
    expect(MCP_NAME_RE.test("0abc")).toBe(true);
    expect(MCP_NAME_RE.test("-abc")).toBe(false);
    expect(MCP_NAME_RE.test("Abc")).toBe(false);
    expect(MCP_NAME_RE.test("a b")).toBe(false);
    expect(MCP_NAME_RE.test("")).toBe(false);
  });

  it("isValidServerName mirrors the regex", () => {
    expect(isValidServerName("ok")).toBe(true);
    expect(isValidServerName("not ok")).toBe(false);
  });

  it("kaizenToolName produces mcp:<server>:<tool>", () => {
    expect(kaizenToolName("github", "search_code")).toBe("mcp:github:search_code");
  });

  it("kaizenToolTags produces [mcp, mcp:<server>]", () => {
    expect(kaizenToolTags("github")).toEqual(["mcp", "mcp:github"]);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `bun test plugins/llm-mcp-bridge/test/names.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `names.ts`**

```ts
export const MCP_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

export function isValidServerName(name: string): boolean {
  return MCP_NAME_RE.test(name);
}

export function kaizenToolName(server: string, mcpToolName: string): string {
  return `mcp:${server}:${mcpToolName}`;
}

export function kaizenToolTags(server: string): string[] {
  return ["mcp", `mcp:${server}`];
}
```

- [ ] **Step 4: Run tests**

Run: `bun test plugins/llm-mcp-bridge/test/names.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-mcp-bridge/names.ts plugins/llm-mcp-bridge/test/names.test.ts
git commit -m "feat(llm-mcp-bridge): server-name validators and kaizen tool naming helpers"
```

---

## Task 4: `backoff.ts` — exponential backoff curve

**Files:**
- Create: `plugins/llm-mcp-bridge/backoff.ts`
- Create: `plugins/llm-mcp-bridge/test/backoff.test.ts`

Spec curve: 1s, 2s, 4s, 8s, …, capped at 60s. Retry budget: 5 attempts. On the 6th failure, quarantine.

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect } from "bun:test";
import { computeBackoffMs, MAX_BACKOFF_MS, RETRY_BUDGET } from "../backoff.ts";

describe("backoff", () => {
  it("attempt 1 -> 1000ms", () => expect(computeBackoffMs(1)).toBe(1000));
  it("attempt 2 -> 2000ms", () => expect(computeBackoffMs(2)).toBe(2000));
  it("attempt 3 -> 4000ms", () => expect(computeBackoffMs(3)).toBe(4000));
  it("attempt 4 -> 8000ms", () => expect(computeBackoffMs(4)).toBe(8000));
  it("attempt 5 -> 16000ms", () => expect(computeBackoffMs(5)).toBe(16000));
  it("attempt 6 -> capped at 60000ms", () => expect(computeBackoffMs(6)).toBe(60000));
  it("attempt 999 -> still capped", () => expect(computeBackoffMs(999)).toBe(MAX_BACKOFF_MS));
  it("RETRY_BUDGET is 5", () => expect(RETRY_BUDGET).toBe(5));
});
```

- [ ] **Step 2: Run test (should fail — module missing)**

Run: `bun test plugins/llm-mcp-bridge/test/backoff.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `backoff.ts`**

```ts
export const MAX_BACKOFF_MS = 60_000;
export const RETRY_BUDGET = 5;

export function computeBackoffMs(attempt: number): number {
  if (attempt < 1) return 0;
  // 1s, 2s, 4s, 8s, 16s, ...; cap at MAX.
  const exp = Math.pow(2, attempt - 1) * 1000;
  return Math.min(exp, MAX_BACKOFF_MS);
}
```

- [ ] **Step 4: Run tests**

Run: `bun test plugins/llm-mcp-bridge/test/backoff.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-mcp-bridge/backoff.ts plugins/llm-mcp-bridge/test/backoff.test.ts
git commit -m "feat(llm-mcp-bridge): backoff curve and retry budget"
```

---

## Task 5: `mockServer.ts` — in-process fake MCP client for tests

**Files:**
- Create: `plugins/llm-mcp-bridge/test/mockServer.ts`

We build a hand-rolled fake `Client` interface (matching the surface the bridge consumes from `@modelcontextprotocol/sdk`) so tests don't spin subprocesses. Lifecycle tests stub `createClient()` to return one of these. The fake exposes:
- `connect()` — resolves or rejects on demand.
- `close()` — records calls.
- `listTools()` — returns canned tool list.
- `listResources()` — returns canned resource list.
- `callTool({name, arguments})` — returns canned result or throws.
- `readResource({uri})` — returns canned content.
- `ping()` — resolves or rejects on demand.
- `setCapabilities({tools?, resources?, prompts?})` — controls what `getServerCapabilities` returns.
- `simulateClose()` — fires the `onclose` handler the bridge attached.

This is **only used by tests**, so it does not import from the SDK at all. The type contract is duplicated minimally in this file and re-asserted via `client.ts`'s exported `McpClientLike` type (Task 6).

- [ ] **Step 1: Write `mockServer.ts`**

```ts
import type { McpClientLike } from "../client.ts";

export interface MockTool {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties?: Record<string, unknown>; required?: string[] };
}

export interface MockResource { uri: string; name?: string; mimeType?: string }

export interface MockBehavior {
  capabilities?: { tools?: object; resources?: object; prompts?: object };
  tools?: MockTool[];
  resources?: MockResource[];
  // mcpToolName -> result (object) or thrown Error
  toolHandler?: (name: string, args: unknown) => Promise<unknown>;
  resourceHandler?: (uri: string) => Promise<unknown>;
  pingFails?: boolean;
  connectFails?: Error | null;
  // when initialize() is called, returns this; defaults to "ok"
  initializeError?: Error | null;
}

export interface MockClient extends McpClientLike {
  // test handles
  closeCount: number;
  callsCallTool: Array<{ name: string; args: unknown }>;
  setBehavior(b: Partial<MockBehavior>): void;
  simulateClose(): void;
  getOnClose(): (() => void) | undefined;
}

export function makeMockClient(initial: MockBehavior = {}): MockClient {
  let behavior: MockBehavior = { ...initial };
  let onclose: (() => void) | undefined;
  const calls: Array<{ name: string; args: unknown }> = [];

  const client: MockClient = {
    closeCount: 0,
    callsCallTool: calls,
    setBehavior(b) { behavior = { ...behavior, ...b }; },
    simulateClose() { onclose?.(); },
    getOnClose() { return onclose; },

    async connect() {
      if (behavior.connectFails) throw behavior.connectFails;
    },
    async initialize() {
      if (behavior.initializeError) throw behavior.initializeError;
      return { capabilities: behavior.capabilities ?? {} };
    },
    getServerCapabilities() {
      return behavior.capabilities ?? {};
    },
    async listTools() {
      return { tools: behavior.tools ?? [] };
    },
    async listResources() {
      return { resources: behavior.resources ?? [] };
    },
    async callTool(req) {
      calls.push({ name: req.name, args: req.arguments });
      const h = behavior.toolHandler;
      if (!h) return { content: [{ type: "text", text: "ok" }] };
      const out = await h(req.name, req.arguments);
      // wrap non-content shapes
      if (typeof out === "object" && out !== null && "content" in (out as object)) return out;
      return { content: [{ type: "text", text: JSON.stringify(out) }] };
    },
    async readResource(req) {
      const h = behavior.resourceHandler;
      if (!h) return { contents: [{ uri: req.uri, mimeType: "text/plain", text: "stub" }] };
      const out = await h(req.uri);
      return out as any;
    },
    async ping() {
      if (behavior.pingFails) throw new Error("ping failed");
    },
    async close() { client.closeCount++; },
    set onclose(cb: (() => void) | undefined) { onclose = cb; },
    get onclose(): (() => void) | undefined { return onclose; },
  };
  return client;
}
```

- [ ] **Step 2: Verify it compiles (no test yet)**

Run: `bun --bun tsc --noEmit plugins/llm-mcp-bridge/test/mockServer.ts`
Expected: FAIL — `client.ts` does not yet export `McpClientLike`. This is intentional; resolved by Task 6.

(This task does not commit independently; it commits with Task 6.)

---

## Task 6: `client.ts` — MCP client factory + `McpClientLike` interface

**Files:**
- Create: `plugins/llm-mcp-bridge/client.ts`

Provides the SDK adapter. Exports:
- `McpClientLike` — the minimal interface the bridge consumes (matches what we expect from `@modelcontextprotocol/sdk`'s `Client` class).
- `createClient(cfg, version)` — factory that picks the correct transport (`StdioClientTransport`, `SSEClientTransport`, `StreamableHTTPClientTransport`) and returns a connected-ready `McpClientLike`. Note: `connect()` is called by `lifecycle.ts`, not here; this factory only wires transport + client.

This file is the **only** file that imports `@modelcontextprotocol/sdk`.

- [ ] **Step 1: Write `client.ts`**

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ResolvedServerConfig } from "./config.ts";

/**
 * The minimal client surface the bridge depends on.
 * Implemented by both the real SDK Client wrapper and our test mocks.
 */
export interface McpClientLike {
  connect(): Promise<void>;
  initialize?(): Promise<{ capabilities: object }>;
  getServerCapabilities(): { tools?: object; resources?: object; prompts?: object } | undefined;
  listTools(): Promise<{ tools: Array<{ name: string; description?: string; inputSchema?: object }> }>;
  listResources(): Promise<{ resources: Array<{ uri: string; name?: string; mimeType?: string }> }>;
  callTool(req: { name: string; arguments: unknown }): Promise<unknown>;
  readResource(req: { uri: string }): Promise<unknown>;
  ping(): Promise<void>;
  close(): Promise<void>;
  onclose?: (() => void) | undefined;
  // Subscribe to MCP `notifications/tools/list_changed`
  setNotificationHandler?(method: string, handler: (notif: unknown) => void): void;
}

export interface CreateClientResult {
  client: McpClientLike;
  /** Process pid for stdio transport, undefined otherwise. Used by health checks. */
  pid?: number;
}

export interface CreateClientDeps {
  log: (msg: string) => void;
  version: string;
}

export function createClient(cfg: ResolvedServerConfig, deps: CreateClientDeps): CreateClientResult {
  let transport;
  let pid: number | undefined;
  if (cfg.transport === "stdio") {
    if (!cfg.command) throw new Error(`server "${cfg.name}": stdio transport missing command`);
    transport = new StdioClientTransport({
      command: cfg.command,
      args: cfg.args ?? [],
      env: cfg.env,
      cwd: cfg.cwd,
      stderr: "pipe",
    });
    // Capture stderr at debug level. The SDK exposes a process handle after start;
    // see https://github.com/modelcontextprotocol/typescript-sdk
    const proc = (transport as any).process;
    if (proc?.stderr) {
      proc.stderr.on("data", (chunk: Buffer) => deps.log(`[mcp:${cfg.name}] ${chunk.toString().trimEnd()}`));
    }
    pid = proc?.pid;
  } else if (cfg.transport === "sse") {
    if (!cfg.url) throw new Error(`server "${cfg.name}": sse transport missing url`);
    transport = new SSEClientTransport(new URL(cfg.url), {
      requestInit: { headers: cfg.headers ?? {} },
    });
  } else {
    if (!cfg.url) throw new Error(`server "${cfg.name}": http transport missing url`);
    transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
      requestInit: { headers: cfg.headers ?? {} },
    });
  }

  const sdkClient = new Client(
    { name: "kaizen-mcp-bridge", version: deps.version },
    { capabilities: {} },
  );
  // Bridge real SDK client to our minimal interface. The SDK already exposes
  // these methods; we keep the cast tight to surface mismatches at compile time.
  (sdkClient as any).__transport = transport;
  // The SDK's connect handles the initialize handshake.
  const adapted: McpClientLike = {
    connect: () => sdkClient.connect(transport),
    getServerCapabilities: () => (sdkClient as any).getServerCapabilities() ?? {},
    listTools: () => sdkClient.listTools() as Promise<any>,
    listResources: () => sdkClient.listResources() as Promise<any>,
    callTool: (req) => sdkClient.callTool(req) as Promise<unknown>,
    readResource: (req) => sdkClient.readResource(req) as Promise<unknown>,
    ping: () => sdkClient.ping().then(() => undefined),
    close: () => sdkClient.close(),
    setNotificationHandler: (method, handler) => {
      // Bridge to SDK's specific notification subscription API.
      // For v0 we wire only `notifications/tools/list_changed`.
      (sdkClient as any).setNotificationHandler?.({ method }, handler);
    },
  };
  // SDK exposes onclose via the transport.
  (transport as any).onclose = () => adapted.onclose?.();
  return { client: adapted, pid };
}
```

> **Note for the implementer:** the real SDK API surface for transports / notification handlers may have evolved. Before merging, verify each SDK call against the pinned `@modelcontextprotocol/sdk` version's `dist/` types. If the SDK's `setNotificationHandler` signature or transport stderr exposure differs, update the adapter; do **not** push the difference into `lifecycle.ts`. Keep `client.ts` the only file that knows the SDK API shape.

- [ ] **Step 2: Verify it compiles together with the mock**

Run: `bun --bun tsc --noEmit -p plugins/llm-mcp-bridge/tsconfig.json plugins/llm-mcp-bridge/client.ts plugins/llm-mcp-bridge/config.ts plugins/llm-mcp-bridge/test/mockServer.ts`
Expected: no diagnostics.

- [ ] **Step 3: Commit**

```bash
git add plugins/llm-mcp-bridge/client.ts plugins/llm-mcp-bridge/test/mockServer.ts
git commit -m "feat(llm-mcp-bridge): SDK client factory and test mock surface"
```

---

## Task 7: `registration.ts` — translate MCP capabilities to kaizen tool registrations

**Files:**
- Create: `plugins/llm-mcp-bridge/registration.ts`
- Create: `plugins/llm-mcp-bridge/test/registration.test.ts`

This module is **pure translation**. It does NOT import the registry; it builds `ToolSchema` + `ToolHandler` pairs that callers register.

Key shapes (from `llm-events/public`):
- `ToolSchema = { name, description, parameters: JSONSchema7, tags?: string[] }`
- `ToolHandler = (args: unknown, ctx: { signal, callId, log }) => Promise<unknown>`

This task implements:
1. `toToolRegistration(server, mcpTool, getClient, timeoutMs)` → `{ schema, handler }` for one MCP tool.
2. `makeReadMcpResourceTool(getClient)` → `{ schema, handler }` for the universal `read_mcp_resource` tool.
3. `makeListMcpResourcesTool(getClients)` → `{ schema, handler }` for `list_mcp_resources`.

`getClient` is a closure (`(name: string) => McpClientLike | undefined`) so reconnects swap clients without re-registering tools.

- [ ] **Step 1: Write the failing test**

`plugins/llm-mcp-bridge/test/registration.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { toToolRegistration, makeReadMcpResourceTool, makeListMcpResourcesTool } from "../registration.ts";
import { makeMockClient } from "./mockServer.ts";

const dummyCtx = { signal: new AbortController().signal, callId: "c1", log: () => {} };

describe("toToolRegistration", () => {
  it("namespaces tool name and tags", () => {
    const c = makeMockClient();
    const reg = toToolRegistration("github", {
      name: "search_code",
      description: "Search GitHub code.",
      inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
    }, () => c, 30000);
    expect(reg.schema.name).toBe("mcp:github:search_code");
    expect(reg.schema.description).toBe("Search GitHub code.");
    expect(reg.schema.tags).toEqual(["mcp", "mcp:github"]);
    expect(reg.schema.parameters).toEqual({ type: "object", properties: { q: { type: "string" } }, required: ["q"] });
  });

  it("falls back to a permissive schema when inputSchema is missing", () => {
    const c = makeMockClient();
    const reg = toToolRegistration("x", { name: "t", description: "" }, () => c, 30000);
    expect(reg.schema.parameters).toEqual({ type: "object", properties: {} });
  });

  it("handler proxies callTool and flattens text content", async () => {
    const c = makeMockClient({
      toolHandler: async (n, args) => ({ content: [{ type: "text", text: "hello" }] }),
    });
    const reg = toToolRegistration("srv", { name: "do", description: "" }, () => c, 30000);
    const out = await reg.handler({ x: 1 }, dummyCtx);
    expect(out).toBe("hello");
    expect(c.callsCallTool[0].args).toEqual({ x: 1 });
  });

  it("handler preserves multi-block text content as joined string", async () => {
    const c = makeMockClient({
      toolHandler: async () => ({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }),
    });
    const reg = toToolRegistration("s", { name: "t", description: "" }, () => c, 30000);
    expect(await reg.handler({}, dummyCtx)).toBe("a\nb");
  });

  it("handler returns structured JSON for non-text content blocks", async () => {
    const c = makeMockClient({
      toolHandler: async () => ({ content: [{ type: "image", data: "b64", mimeType: "image/png" }] }),
    });
    const reg = toToolRegistration("s", { name: "t", description: "" }, () => c, 30000);
    const out = await reg.handler({}, dummyCtx) as any;
    expect(Array.isArray(out)).toBe(true);
    expect(out[0].type).toBe("image");
  });

  it("handler throws mapped error on MCP failure", async () => {
    const c = makeMockClient({
      toolHandler: async () => { throw new Error("boom"); },
    });
    const reg = toToolRegistration("srv", { name: "t", description: "" }, () => c, 30000);
    await expect(reg.handler({}, dummyCtx)).rejects.toThrow(/mcp:srv:t failed: boom/);
  });

  it("handler fast-fails when getClient returns undefined (quarantined)", async () => {
    const reg = toToolRegistration("srv", { name: "t", description: "" }, () => undefined, 30000);
    await expect(reg.handler({}, dummyCtx)).rejects.toThrow(/mcp_server_unavailable/);
  });

  it("handler times out after timeoutMs", async () => {
    const c = makeMockClient({
      toolHandler: () => new Promise((r) => setTimeout(() => r({ content: [{ type: "text", text: "x" }] }), 200)),
    });
    const reg = toToolRegistration("srv", { name: "t", description: "" }, () => c, 50);
    await expect(reg.handler({}, dummyCtx)).rejects.toThrow(/timed out after 50ms/);
  });

  it("handler honors abort signal", async () => {
    const c = makeMockClient({
      toolHandler: () => new Promise((r) => setTimeout(() => r({ content: [{ type: "text", text: "x" }] }), 500)),
    });
    const ac = new AbortController();
    const reg = toToolRegistration("srv", { name: "t", description: "" }, () => c, 60000);
    const p = reg.handler({}, { ...dummyCtx, signal: ac.signal });
    setTimeout(() => ac.abort(), 10);
    await expect(p).rejects.toThrow(/aborted|cancel/i);
  });
});

describe("read_mcp_resource", () => {
  it("schema name + parameters", () => {
    const reg = makeReadMcpResourceTool(() => undefined);
    expect(reg.schema.name).toBe("read_mcp_resource");
    expect(reg.schema.parameters).toEqual({
      type: "object",
      properties: {
        server: { type: "string", description: "The configured MCP server name." },
        uri: { type: "string", description: "The MCP resource URI to read." },
      },
      required: ["server", "uri"],
    });
  });

  it("handler proxies readResource for the named server", async () => {
    const c = makeMockClient({
      resourceHandler: async (uri) => ({ contents: [{ uri, mimeType: "text/plain", text: "hi" }] }),
    });
    const reg = makeReadMcpResourceTool((name) => name === "fs" ? c : undefined);
    const out = await reg.handler({ server: "fs", uri: "file:///tmp/x" }, dummyCtx) as any;
    expect(out.contents[0].text).toBe("hi");
  });

  it("handler errors on unknown server", async () => {
    const reg = makeReadMcpResourceTool(() => undefined);
    await expect(reg.handler({ server: "missing", uri: "x" }, dummyCtx)).rejects.toThrow(/unknown MCP server: missing/);
  });

  it("handler errors on missing args", async () => {
    const reg = makeReadMcpResourceTool(() => undefined);
    await expect(reg.handler({}, dummyCtx)).rejects.toThrow(/server.*required/i);
  });
});

describe("list_mcp_resources", () => {
  it("aggregates across all healthy servers when server arg omitted", async () => {
    const a = makeMockClient({ resources: [{ uri: "file:///a" }] });
    const b = makeMockClient({ resources: [{ uri: "file:///b" }] });
    const reg = makeListMcpResourcesTool(() => [
      { name: "a", client: a },
      { name: "b", client: b },
    ]);
    const out = await reg.handler({}, dummyCtx) as any[];
    expect(out.map((r) => r.uri).sort()).toEqual(["file:///a", "file:///b"]);
    expect(out.find((r) => r.uri === "file:///a").server).toBe("a");
  });

  it("filters to one server when server arg present", async () => {
    const a = makeMockClient({ resources: [{ uri: "file:///a" }] });
    const b = makeMockClient({ resources: [{ uri: "file:///b" }] });
    const reg = makeListMcpResourcesTool(() => [
      { name: "a", client: a },
      { name: "b", client: b },
    ]);
    const out = await reg.handler({ server: "b" }, dummyCtx) as any[];
    expect(out.map((r) => r.uri)).toEqual(["file:///b"]);
  });
});
```

- [ ] **Step 2: Run test (should fail)**

Run: `bun test plugins/llm-mcp-bridge/test/registration.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `registration.ts`**

```ts
import type { JSONSchema7 } from "json-schema";
import type { McpClientLike } from "./client.ts";
import { kaizenToolName, kaizenToolTags } from "./names.ts";

export interface KaizenToolReg {
  schema: { name: string; description: string; parameters: JSONSchema7; tags?: string[] };
  handler: (args: unknown, ctx: { signal: AbortSignal; callId: string; log: (msg: string) => void }) => Promise<unknown>;
}

interface McpToolMeta {
  name: string;
  description?: string;
  inputSchema?: object;
}

function asJsonSchema(s: object | undefined): JSONSchema7 {
  if (!s || typeof s !== "object") return { type: "object", properties: {} };
  return s as JSONSchema7;
}

function flattenContent(result: unknown): unknown {
  if (typeof result !== "object" || result === null) return result;
  const r = result as { content?: unknown };
  if (!Array.isArray(r.content)) return result;
  const blocks = r.content as Array<Record<string, unknown>>;
  const allText = blocks.length > 0 && blocks.every((b) => b?.type === "text" && typeof b.text === "string");
  if (allText) return (blocks as Array<{ text: string }>).map((b) => b.text).join("\n");
  // Non-text content: return the structured array verbatim for the LLM/dispatcher to handle.
  return blocks;
}

export function toToolRegistration(
  server: string,
  mcpTool: McpToolMeta,
  getClient: () => McpClientLike | undefined,
  timeoutMs: number,
): KaizenToolReg {
  const fqName = kaizenToolName(server, mcpTool.name);
  const schema = {
    name: fqName,
    description: mcpTool.description ?? "",
    parameters: asJsonSchema(mcpTool.inputSchema),
    tags: kaizenToolTags(server),
  };

  const handler: KaizenToolReg["handler"] = async (args, ctx) => {
    const client = getClient();
    if (!client) {
      const err = new Error(`mcp_server_unavailable: ${server}`);
      throw err;
    }
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    if (ctx.signal.aborted) ac.abort();
    else ctx.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => ac.abort(new Error(`mcp:${server}:${mcpTool.name} timed out after ${timeoutMs}ms`)), timeoutMs);
    try {
      const racePromise = client.callTool({ name: mcpTool.name, arguments: args });
      const abortPromise = new Promise<never>((_, reject) => {
        ac.signal.addEventListener("abort", () => {
          const reason = (ac.signal as any).reason;
          if (reason instanceof Error) reject(reason);
          else if (ctx.signal.aborted) reject(new Error(`mcp:${server}:${mcpTool.name} aborted`));
          else reject(new Error(`mcp:${server}:${mcpTool.name} aborted`));
        }, { once: true });
      });
      const result = await Promise.race([racePromise, abortPromise]);
      return flattenContent(result);
    } catch (err: any) {
      // Re-throw timeout/abort verbatim
      if (typeof err?.message === "string" && (err.message.includes("timed out") || err.message.includes("aborted") || err.message.startsWith("mcp_server_unavailable"))) {
        throw err;
      }
      throw new Error(`mcp:${server}:${mcpTool.name} failed: ${err?.message ?? String(err)}`);
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
    }
  };

  return { schema, handler };
}

export function makeReadMcpResourceTool(getClient: (server: string) => McpClientLike | undefined): KaizenToolReg {
  return {
    schema: {
      name: "read_mcp_resource",
      description: "Read an MCP resource by URI. Use list_mcp_resources to discover URIs.",
      parameters: {
        type: "object",
        properties: {
          server: { type: "string", description: "The configured MCP server name." },
          uri: { type: "string", description: "The MCP resource URI to read." },
        },
        required: ["server", "uri"],
      },
    },
    handler: async (args, _ctx) => {
      const a = (args ?? {}) as { server?: unknown; uri?: unknown };
      if (typeof a.server !== "string") throw new Error("read_mcp_resource: 'server' (string) is required");
      if (typeof a.uri !== "string") throw new Error("read_mcp_resource: 'uri' (string) is required");
      const c = getClient(a.server);
      if (!c) throw new Error(`unknown MCP server: ${a.server}`);
      return await c.readResource({ uri: a.uri });
    },
  };
}

export interface NamedClient { name: string; client: McpClientLike }

export function makeListMcpResourcesTool(getHealthy: () => NamedClient[]): KaizenToolReg {
  return {
    schema: {
      name: "list_mcp_resources",
      description: "List MCP resources across configured servers (or one if `server` is given).",
      parameters: {
        type: "object",
        properties: {
          server: { type: "string", description: "Optional server name to restrict the listing to." },
        },
      },
    },
    handler: async (args, _ctx) => {
      const a = (args ?? {}) as { server?: unknown };
      const servers = getHealthy();
      const targets = typeof a.server === "string"
        ? servers.filter((s) => s.name === a.server)
        : servers;
      const out: Array<Record<string, unknown>> = [];
      for (const { name, client } of targets) {
        try {
          const r = await client.listResources();
          for (const res of r.resources ?? []) out.push({ ...res, server: name });
        } catch (err) {
          // skip failing server, continue aggregation
        }
      }
      return out;
    },
  };
}
```

- [ ] **Step 4: Run tests**

Run: `bun test plugins/llm-mcp-bridge/test/registration.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-mcp-bridge/registration.ts plugins/llm-mcp-bridge/test/registration.test.ts
git commit -m "feat(llm-mcp-bridge): translate MCP tools/resources to kaizen tool registrations"
```

---

## Task 8: `lifecycle.ts` — `ServerLifecycle` state machine

**Files:**
- Create: `plugins/llm-mcp-bridge/lifecycle.ts`
- Create: `plugins/llm-mcp-bridge/test/lifecycle.test.ts`

The most complex module. Implements per-server state machine driving:
- Phase 1: connect (delegated to `createClient` + `client.connect()`).
- Phase 2: handshake — SDK's `connect()` already issues `initialize`; after it returns, read capabilities.
- Phase 3: health-check timer (`ping()` every `healthCheckMs`).
- Phase 4: backoff retry loop on disconnect, transition to `quarantined` after `RETRY_BUDGET` failures.
- Phase 5: graceful shutdown (timeouts, force-close).
- Tool reconciliation on (re)connect: list current tools, register adds, unregister removes.
- Subscribe to `notifications/tools/list_changed` (best-effort) to re-reconcile on demand.

Public surface used by `index.ts` and `service.ts`:

```ts
class ServerLifecycle {
  constructor(deps: LifecycleDeps);
  start(): void;                  // begins Phase 1 asynchronously; returns immediately
  shutdown(): Promise<void>;      // Phase 5
  forceReconnect(): Promise<void>;
  disable(): void;
  info(): ServerInfo;
  getClient(): McpClientLike | undefined;  // returns client only when status === connected
}
```

`LifecycleDeps`:

```ts
interface LifecycleDeps {
  cfg: ResolvedServerConfig;
  registry: { register: (schema, handler) => () => void };
  log: (msg: string) => void;
  // Injectable for tests:
  createClient: (cfg: ResolvedServerConfig) => CreateClientResult;
  setTimeout: (cb: () => void, ms: number) => unknown;
  clearTimeout: (h: unknown) => void;
  now: () => number;
  retryBudget?: number;            // default RETRY_BUDGET
  computeBackoffMs?: (attempt: number) => number;
  // signal for status updates (used by service.list); the lifecycle pushes ServerInfo snapshots.
  onStatusChange?: (info: ServerInfo) => void;
}
```

- [ ] **Step 1: Write the failing tests**

`plugins/llm-mcp-bridge/test/lifecycle.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { ServerLifecycle } from "../lifecycle.ts";
import type { ResolvedServerConfig } from "../config.ts";
import { makeMockClient, type MockClient } from "./mockServer.ts";

class FakeRegistry {
  registered = new Map<string, { schema: any; handler: any; unregistered: boolean }>();
  register(schema: any, handler: any) {
    if (this.registered.has(schema.name) && !this.registered.get(schema.name)!.unregistered) {
      throw new Error(`duplicate: ${schema.name}`);
    }
    this.registered.set(schema.name, { schema, handler, unregistered: false });
    return () => { this.registered.get(schema.name)!.unregistered = true; };
  }
  liveSchemas() { return [...this.registered.values()].filter((v) => !v.unregistered).map((v) => v.schema); }
}

class FakeTimers {
  next = 1;
  scheduled = new Map<number, { cb: () => void; due: number }>();
  nowMs = 0;
  set(cb: () => void, ms: number) { const id = this.next++; this.scheduled.set(id, { cb, due: this.nowMs + ms }); return id; }
  clear(h: unknown) { this.scheduled.delete(h as number); }
  advance(ms: number) {
    this.nowMs += ms;
    const due = [...this.scheduled.entries()].filter(([, e]) => e.due <= this.nowMs).sort((a, b) => a[1].due - b[1].due);
    for (const [id, e] of due) {
      this.scheduled.delete(id);
      e.cb();
    }
  }
}

function tick(ms = 0) { return new Promise((r) => setTimeout(r, ms)); }

function baseCfg(overrides: Partial<ResolvedServerConfig> = {}): ResolvedServerConfig {
  return {
    name: "srv",
    transport: "stdio",
    enabled: true,
    timeoutMs: 30000,
    healthCheckMs: 60000,
    command: "true",
    ...overrides,
  };
}

describe("ServerLifecycle — happy path", () => {
  it("connects, lists tools, registers them with namespaced names", async () => {
    const c = makeMockClient({
      capabilities: { tools: {} },
      tools: [{ name: "do", description: "Do.", inputSchema: { type: "object", properties: {} } }],
    });
    const reg = new FakeRegistry();
    const t = new FakeTimers();
    const lc = new ServerLifecycle({
      cfg: baseCfg(),
      registry: reg,
      log: () => {},
      createClient: () => ({ client: c }),
      setTimeout: (cb, ms) => t.set(cb, ms),
      clearTimeout: (h) => t.clear(h),
      now: () => t.nowMs,
    });
    lc.start();
    await tick(); await tick();
    expect(lc.info().status).toBe("connected");
    expect(lc.info().toolCount).toBe(1);
    expect(reg.liveSchemas().map((s) => s.name)).toContain("mcp:srv:do");
  });

  it("ignores prompts capability (v0): does not list prompts, promptCount stays 0", async () => {
    const c = makeMockClient({
      capabilities: { tools: {}, prompts: {} },
      tools: [{ name: "t", description: "", inputSchema: { type: "object" } }],
    });
    const reg = new FakeRegistry();
    const t = new FakeTimers();
    const lc = new ServerLifecycle({
      cfg: baseCfg(),
      registry: reg,
      log: () => {},
      createClient: () => ({ client: c }),
      setTimeout: (cb, ms) => t.set(cb, ms),
      clearTimeout: (h) => t.clear(h),
      now: () => t.nowMs,
    });
    lc.start();
    await tick(); await tick();
    expect(lc.info().promptCount).toBe(0);
    expect(reg.liveSchemas().some((s) => s.name.startsWith("mcp:srv:") && s.name !== "mcp:srv:t")).toBe(false);
  });
});

describe("ServerLifecycle — disconnect + backoff", () => {
  it("on disconnect, schedules reconnect with 1s, 2s, 4s, 8s, 16s; quarantines on 6th failure", async () => {
    let attempts = 0;
    const c = makeMockClient({ capabilities: { tools: {} }, tools: [] });
    c.setBehavior({ connectFails: null });
    const reg = new FakeRegistry();
    const t = new FakeTimers();
    const lc = new ServerLifecycle({
      cfg: baseCfg(),
      registry: reg,
      log: () => {},
      createClient: () => {
        attempts++;
        if (attempts === 1) return { client: c };
        // subsequent attempts fail
        const f = makeMockClient({ connectFails: new Error("nope") });
        return { client: f };
      },
      setTimeout: (cb, ms) => t.set(cb, ms),
      clearTimeout: (h) => t.clear(h),
      now: () => t.nowMs,
      retryBudget: 5,
    });
    lc.start();
    await tick(); await tick();
    expect(lc.info().status).toBe("connected");
    // Simulate the transport closing
    c.simulateClose();
    await tick();
    expect(lc.info().status).toBe("reconnecting");
    // attempt 1 schedules at 1000ms
    t.advance(1000); await tick(); await tick();
    // attempt 2 -> 2000ms
    t.advance(2000); await tick(); await tick();
    // attempt 3 -> 4000ms
    t.advance(4000); await tick(); await tick();
    // attempt 4 -> 8000ms
    t.advance(8000); await tick(); await tick();
    // attempt 5 -> 16000ms (still under 60s cap)
    t.advance(16000); await tick(); await tick();
    expect(lc.info().status).toBe("quarantined");
    expect(lc.info().reconnectAttempts).toBeGreaterThanOrEqual(5);
  });

  it("tools registered before quarantine remain registered (no churn)", async () => {
    const c = makeMockClient({
      capabilities: { tools: {} },
      tools: [{ name: "t", description: "", inputSchema: { type: "object" } }],
    });
    const reg = new FakeRegistry();
    const t = new FakeTimers();
    let attempts = 0;
    const lc = new ServerLifecycle({
      cfg: baseCfg(),
      registry: reg,
      log: () => {},
      createClient: () => {
        attempts++;
        if (attempts === 1) return { client: c };
        return { client: makeMockClient({ connectFails: new Error("nope") }) };
      },
      setTimeout: (cb, ms) => t.set(cb, ms),
      clearTimeout: (h) => t.clear(h),
      now: () => t.nowMs,
    });
    lc.start();
    await tick(); await tick();
    c.simulateClose();
    for (const ms of [1000, 2000, 4000, 8000, 16000]) { t.advance(ms); await tick(); await tick(); }
    expect(lc.info().status).toBe("quarantined");
    expect(reg.liveSchemas().map((s) => s.name)).toContain("mcp:srv:t");
  });
});

describe("ServerLifecycle — health checks", () => {
  it("ping failure transitions to reconnecting", async () => {
    const c = makeMockClient({ capabilities: { tools: {} }, tools: [] });
    const reg = new FakeRegistry();
    const t = new FakeTimers();
    const lc = new ServerLifecycle({
      cfg: baseCfg({ healthCheckMs: 60000 }),
      registry: reg,
      log: () => {},
      createClient: () => ({ client: c }),
      setTimeout: (cb, ms) => t.set(cb, ms),
      clearTimeout: (h) => t.clear(h),
      now: () => t.nowMs,
    });
    lc.start();
    await tick(); await tick();
    expect(lc.info().status).toBe("connected");
    c.setBehavior({ pingFails: true });
    t.advance(60000); await tick(); await tick();
    expect(lc.info().status).toBe("reconnecting");
  });
});

describe("ServerLifecycle — forceReconnect", () => {
  it("clears quarantine and re-runs Phase 1", async () => {
    let attempts = 0;
    const reg = new FakeRegistry();
    const t = new FakeTimers();
    const c = makeMockClient({ capabilities: { tools: {} }, tools: [] });
    const lc = new ServerLifecycle({
      cfg: baseCfg(),
      registry: reg,
      log: () => {},
      createClient: () => {
        attempts++;
        if (attempts <= 5) return { client: makeMockClient({ connectFails: new Error("no") }) };
        return { client: c };
      },
      setTimeout: (cb, ms) => t.set(cb, ms),
      clearTimeout: (h) => t.clear(h),
      now: () => t.nowMs,
    });
    lc.start();
    await tick(); await tick();
    for (const ms of [1000, 2000, 4000, 8000, 16000]) { t.advance(ms); await tick(); await tick(); }
    expect(lc.info().status).toBe("quarantined");
    await lc.forceReconnect();
    await tick(); await tick();
    expect(lc.info().status).toBe("connected");
    expect(lc.info().reconnectAttempts).toBe(0);
  });
});

describe("ServerLifecycle — shutdown", () => {
  it("Phase 5 closes client and unregisters tools", async () => {
    const c = makeMockClient({
      capabilities: { tools: {} },
      tools: [{ name: "t", description: "", inputSchema: { type: "object" } }],
    });
    const reg = new FakeRegistry();
    const t = new FakeTimers();
    const lc = new ServerLifecycle({
      cfg: baseCfg(),
      registry: reg,
      log: () => {},
      createClient: () => ({ client: c }),
      setTimeout: (cb, ms) => t.set(cb, ms),
      clearTimeout: (h) => t.clear(h),
      now: () => t.nowMs,
    });
    lc.start();
    await tick(); await tick();
    expect(reg.liveSchemas().length).toBe(1);
    await lc.shutdown();
    expect(c.closeCount).toBe(1);
    expect(reg.liveSchemas().length).toBe(0);
  });
});

describe("ServerLifecycle — disabled config", () => {
  it("does not start when enabled=false", async () => {
    const reg = new FakeRegistry();
    const t = new FakeTimers();
    let created = 0;
    const lc = new ServerLifecycle({
      cfg: baseCfg({ enabled: false }),
      registry: reg,
      log: () => {},
      createClient: () => { created++; return { client: makeMockClient() }; },
      setTimeout: (cb, ms) => t.set(cb, ms),
      clearTimeout: (h) => t.clear(h),
      now: () => t.nowMs,
    });
    lc.start();
    await tick(); await tick();
    expect(lc.info().status).toBe("disabled");
    expect(created).toBe(0);
  });
});

describe("ServerLifecycle — reconciliation on reconnect", () => {
  it("removed tools are unregistered, new tools registered, schema-changed tools updated", async () => {
    const reg = new FakeRegistry();
    const t = new FakeTimers();
    let attempts = 0;
    const c1 = makeMockClient({
      capabilities: { tools: {} },
      tools: [
        { name: "stays", description: "v1", inputSchema: { type: "object" } },
        { name: "removed", description: "", inputSchema: { type: "object" } },
      ],
    });
    const c2 = makeMockClient({
      capabilities: { tools: {} },
      tools: [
        { name: "stays", description: "v2", inputSchema: { type: "object" } },
        { name: "added", description: "", inputSchema: { type: "object" } },
      ],
    });
    const lc = new ServerLifecycle({
      cfg: baseCfg(),
      registry: reg,
      log: () => {},
      createClient: () => { attempts++; return { client: attempts === 1 ? c1 : c2 }; },
      setTimeout: (cb, ms) => t.set(cb, ms),
      clearTimeout: (h) => t.clear(h),
      now: () => t.nowMs,
    });
    lc.start();
    await tick(); await tick();
    expect(reg.liveSchemas().map((s) => s.name).sort()).toEqual(["mcp:srv:removed", "mcp:srv:stays"]);
    c1.simulateClose();
    t.advance(1000); await tick(); await tick();
    const live = reg.liveSchemas().map((s) => s.name).sort();
    expect(live).toEqual(["mcp:srv:added", "mcp:srv:stays"]);
    expect(reg.liveSchemas().find((s) => s.name === "mcp:srv:stays")!.description).toBe("v2");
  });
});
```

- [ ] **Step 2: Run tests (should fail)**

Run: `bun test plugins/llm-mcp-bridge/test/lifecycle.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `lifecycle.ts`**

```ts
import type { ResolvedServerConfig } from "./config.ts";
import type { McpClientLike, CreateClientResult } from "./client.ts";
import { computeBackoffMs as defaultBackoff, RETRY_BUDGET as DEFAULT_BUDGET } from "./backoff.ts";
import { toToolRegistration } from "./registration.ts";
import type { ServerInfo, ServerStatus } from "./public.d.ts";

export interface RegistryLike {
  register(schema: { name: string; description: string; parameters: object; tags?: string[] }, handler: (args: unknown, ctx: any) => Promise<unknown>): () => void;
}

export interface LifecycleDeps {
  cfg: ResolvedServerConfig;
  registry: RegistryLike;
  log: (msg: string) => void;
  createClient: (cfg: ResolvedServerConfig) => CreateClientResult;
  setTimeout: (cb: () => void, ms: number) => unknown;
  clearTimeout: (h: unknown) => void;
  now: () => number;
  retryBudget?: number;
  computeBackoffMs?: (attempt: number) => number;
  onStatusChange?: (info: ServerInfo) => void;
}

interface RegisteredTool {
  mcpName: string;
  schema: { name: string; description: string; parameters: object; tags?: string[] };
  unregister: () => void;
}

export class ServerLifecycle {
  private status: ServerStatus;
  private client: McpClientLike | undefined;
  private healthTimer: unknown;
  private reconnectTimer: unknown;
  private attempts = 0;
  private connectedAt: number | undefined;
  private lastError: string | undefined;
  private registered = new Map<string, RegisteredTool>(); // key: mcpName
  private resourceCount = -1;
  private shutdownCalled = false;

  constructor(private deps: LifecycleDeps) {
    this.status = deps.cfg.enabled ? "connecting" : "disabled";
  }

  info(): ServerInfo {
    return {
      name: this.deps.cfg.name,
      transport: this.deps.cfg.transport,
      status: this.status,
      toolCount: this.registered.size,
      resourceCount: this.resourceCount,
      promptCount: 0,
      lastError: this.lastError,
      connectedAt: this.connectedAt,
      reconnectAttempts: this.attempts,
    };
  }

  getClient(): McpClientLike | undefined {
    return this.status === "connected" ? this.client : undefined;
  }

  start(): void {
    if (!this.deps.cfg.enabled) {
      this.setStatus("disabled");
      return;
    }
    this.setStatus("connecting");
    void this.tryConnect();
  }

  disable(): void {
    void this.shutdown().then(() => this.setStatus("disabled"));
  }

  async forceReconnect(): Promise<void> {
    this.cancelTimers();
    if (this.client) {
      try { await this.client.close(); } catch { /* ignore */ }
    }
    this.attempts = 0;
    this.lastError = undefined;
    this.setStatus("connecting");
    await this.tryConnect();
  }

  async shutdown(): Promise<void> {
    if (this.shutdownCalled) return;
    this.shutdownCalled = true;
    this.cancelTimers();
    const c = this.client;
    this.client = undefined;
    if (c) {
      try {
        await Promise.race([
          c.close(),
          new Promise<void>((resolve) => this.deps.setTimeout(() => resolve(), 5000)),
        ]);
      } catch (err) {
        this.deps.log(`mcp:${this.deps.cfg.name}: close errored: ${(err as Error).message}`);
      }
    }
    // Unregister all tools.
    for (const r of this.registered.values()) {
      try { r.unregister(); } catch { /* ignore */ }
    }
    this.registered.clear();
  }

  private cancelTimers(): void {
    if (this.healthTimer !== undefined) { this.deps.clearTimeout(this.healthTimer); this.healthTimer = undefined; }
    if (this.reconnectTimer !== undefined) { this.deps.clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined; }
  }

  private setStatus(s: ServerStatus): void {
    this.status = s;
    this.deps.onStatusChange?.(this.info());
  }

  private async tryConnect(): Promise<void> {
    if (this.shutdownCalled) return;
    let result: CreateClientResult;
    try {
      result = this.deps.createClient(this.deps.cfg);
    } catch (err) {
      this.lastError = (err as Error).message;
      this.deps.log(`mcp:${this.deps.cfg.name}: createClient failed: ${this.lastError}`);
      this.scheduleRetry();
      return;
    }
    const client = result.client;
    client.onclose = () => this.handleDisconnect("transport closed");
    try {
      await client.connect();
    } catch (err) {
      this.lastError = (err as Error).message;
      this.deps.log(`mcp:${this.deps.cfg.name}: connect failed: ${this.lastError}`);
      this.scheduleRetry();
      return;
    }
    if (this.shutdownCalled) {
      try { await client.close(); } catch { /* ignore */ }
      return;
    }
    this.client = client;
    this.connectedAt = this.deps.now();
    this.attempts = 0;
    this.lastError = undefined;
    this.setStatus("connected");

    const caps = (client.getServerCapabilities() ?? {}) as { tools?: object; resources?: object; prompts?: object };
    if (caps.tools) {
      try { await this.reconcileTools(); }
      catch (err) { this.deps.log(`mcp:${this.deps.cfg.name}: tools/list failed: ${(err as Error).message}`); }
    }
    if (caps.resources) {
      try { const r = await client.listResources(); this.resourceCount = r.resources?.length ?? 0; }
      catch { this.resourceCount = -1; }
    }
    if (caps.prompts) {
      this.deps.log(`mcp:${this.deps.cfg.name}: prompts capability advertised; ignored in v0`);
    }

    // Subscribe to tools/list_changed
    client.setNotificationHandler?.("notifications/tools/list_changed", () => {
      this.reconcileTools().catch((err) => this.deps.log(`mcp:${this.deps.cfg.name}: reconcile failed: ${(err as Error).message}`));
    });

    // Schedule periodic ping
    this.scheduleHealthCheck();
  }

  private scheduleHealthCheck(): void {
    if (this.shutdownCalled) return;
    this.healthTimer = this.deps.setTimeout(() => {
      void this.runHealthCheck();
    }, this.deps.cfg.healthCheckMs);
  }

  private async runHealthCheck(): Promise<void> {
    if (this.status !== "connected" || !this.client) return;
    try {
      await this.client.ping();
      this.scheduleHealthCheck();
    } catch (err) {
      this.deps.log(`mcp:${this.deps.cfg.name}: health check failed: ${(err as Error).message}`);
      this.handleDisconnect((err as Error).message);
    }
  }

  private handleDisconnect(why: string): void {
    if (this.shutdownCalled) return;
    if (this.status === "reconnecting" || this.status === "quarantined" || this.status === "disabled") return;
    this.lastError = why;
    this.client = undefined;
    if (this.healthTimer !== undefined) { this.deps.clearTimeout(this.healthTimer); this.healthTimer = undefined; }
    this.setStatus("reconnecting");
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.shutdownCalled) return;
    const budget = this.deps.retryBudget ?? DEFAULT_BUDGET;
    if (this.attempts >= budget) {
      this.setStatus("quarantined");
      return;
    }
    this.attempts++;
    const delay = (this.deps.computeBackoffMs ?? defaultBackoff)(this.attempts);
    this.setStatus("reconnecting");
    this.reconnectTimer = this.deps.setTimeout(() => {
      this.reconnectTimer = undefined;
      this.setStatus("connecting");
      void this.tryConnect();
    }, delay);
  }

  private async reconcileTools(): Promise<void> {
    if (!this.client) return;
    const list = await this.client.listTools();
    const seen = new Set<string>();
    for (const t of list.tools ?? []) {
      seen.add(t.name);
      const existing = this.registered.get(t.name);
      const mcpDescription = t.description ?? "";
      const mcpInputSchema = t.inputSchema ?? { type: "object", properties: {} };
      const newReg = toToolRegistration(this.deps.cfg.name, t, () => this.getClient(), this.deps.cfg.timeoutMs);
      if (existing) {
        const same = existing.schema.description === newReg.schema.description &&
                     JSON.stringify(existing.schema.parameters) === JSON.stringify(newReg.schema.parameters);
        if (same) continue;
        try { existing.unregister(); } catch { /* ignore */ }
        this.registered.delete(t.name);
      }
      try {
        const unregister = this.deps.registry.register(newReg.schema, newReg.handler);
        this.registered.set(t.name, { mcpName: t.name, schema: newReg.schema, unregister });
      } catch (err) {
        this.deps.log(`mcp:${this.deps.cfg.name}: register ${newReg.schema.name} failed: ${(err as Error).message}`);
      }
    }
    // Unregister tools no longer present
    for (const [name, r] of this.registered) {
      if (!seen.has(name)) {
        try { r.unregister(); } catch { /* ignore */ }
        this.registered.delete(name);
      }
    }
  }
}
```

- [ ] **Step 4: Run tests**

Run: `bun test plugins/llm-mcp-bridge/test/lifecycle.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-mcp-bridge/lifecycle.ts plugins/llm-mcp-bridge/test/lifecycle.test.ts
git commit -m "feat(llm-mcp-bridge): per-server lifecycle state machine with backoff and reconciliation"
```

---

## Task 9: `service.ts` — `McpBridgeService` aggregator

**Files:**
- Create: `plugins/llm-mcp-bridge/service.ts`
- Create: `plugins/llm-mcp-bridge/test/service.test.ts`

The service wraps the per-server `ServerLifecycle` instances and implements `McpBridgeService` from `public.d.ts`. It also owns the global resource tools (`read_mcp_resource`, `list_mcp_resources`) — these are registered once at first construction; their handlers route across servers via the shared `getClient(server)` lookup.

`reload(newConfig)` diffs the new config against the running set:
- New servers → instantiate + start.
- Removed → shutdown.
- Changed (any field differs) → shutdown + recreate.
- Unchanged → leave alone.

- [ ] **Step 1: Write the failing test**

`plugins/llm-mcp-bridge/test/service.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { makeBridgeService } from "../service.ts";
import type { ResolvedServerConfig } from "../config.ts";
import { makeMockClient } from "./mockServer.ts";

class FakeRegistry {
  registered = new Map<string, { schema: any; handler: any; unregistered: boolean }>();
  register(schema: any, handler: any) {
    if (this.registered.has(schema.name) && !this.registered.get(schema.name)!.unregistered) {
      throw new Error(`duplicate: ${schema.name}`);
    }
    this.registered.set(schema.name, { schema, handler, unregistered: false });
    return () => { this.registered.get(schema.name)!.unregistered = true; };
  }
  liveSchemas() { return [...this.registered.values()].filter((v) => !v.unregistered).map((v) => v.schema); }
}

function tick(ms = 0) { return new Promise((r) => setTimeout(r, ms)); }

const baseCfg = (name: string, overrides: Partial<ResolvedServerConfig> = {}): ResolvedServerConfig => ({
  name, transport: "stdio", enabled: true, timeoutMs: 30000, healthCheckMs: 60000, command: "true", ...overrides,
});

describe("makeBridgeService", () => {
  it("registers global resource tools once", async () => {
    const reg = new FakeRegistry();
    const svc = makeBridgeService({
      registry: reg,
      log: () => {},
      createClient: () => ({ client: makeMockClient({ capabilities: { tools: {} }, tools: [] }) }),
      initialServers: new Map(),
    });
    expect(reg.liveSchemas().map((s) => s.name).sort()).toEqual(["list_mcp_resources", "read_mcp_resource"]);
    await svc.shutdownAll();
  });

  it("starts all enabled servers and exposes them via list()", async () => {
    const reg = new FakeRegistry();
    const a = baseCfg("a");
    const b = baseCfg("b", { enabled: false });
    const svc = makeBridgeService({
      registry: reg,
      log: () => {},
      createClient: () => ({ client: makeMockClient({ capabilities: { tools: {} }, tools: [] }) }),
      initialServers: new Map([[a.name, a], [b.name, b]]),
    });
    await tick(); await tick();
    const list = svc.list();
    expect(list.find((i) => i.name === "a")!.status).toBe("connected");
    expect(list.find((i) => i.name === "b")!.status).toBe("disabled");
    await svc.shutdownAll();
  });

  it("reload adds, removes, updates", async () => {
    const reg = new FakeRegistry();
    const svc = makeBridgeService({
      registry: reg,
      log: () => {},
      createClient: () => ({ client: makeMockClient({ capabilities: { tools: {} }, tools: [] }) }),
      initialServers: new Map([
        ["keep", baseCfg("keep")],
        ["change", baseCfg("change", { command: "old" })],
        ["remove", baseCfg("remove")],
      ]),
    });
    await tick(); await tick();
    const diff = await svc.reload(new Map([
      ["keep", baseCfg("keep")],
      ["change", baseCfg("change", { command: "new" })],
      ["add", baseCfg("add")],
    ]));
    expect(diff.added).toEqual(["add"]);
    expect(diff.removed).toEqual(["remove"]);
    expect(diff.updated).toEqual(["change"]);
    await tick(); await tick();
    expect(svc.list().map((i) => i.name).sort()).toEqual(["add", "change", "keep"]);
    await svc.shutdownAll();
  });

  it("get(name) returns undefined for unknown server", async () => {
    const reg = new FakeRegistry();
    const svc = makeBridgeService({
      registry: reg, log: () => {},
      createClient: () => ({ client: makeMockClient() }),
      initialServers: new Map(),
    });
    expect(svc.get("missing")).toBeUndefined();
    await svc.shutdownAll();
  });

  it("shutdown(name) closes one server and unregisters its tools", async () => {
    const reg = new FakeRegistry();
    const svc = makeBridgeService({
      registry: reg, log: () => {},
      createClient: () => ({
        client: makeMockClient({
          capabilities: { tools: {} },
          tools: [{ name: "t", description: "", inputSchema: { type: "object" } }],
        }),
      }),
      initialServers: new Map([["a", baseCfg("a")]]),
    });
    await tick(); await tick();
    expect(reg.liveSchemas().map((s) => s.name)).toContain("mcp:a:t");
    await svc.shutdown("a");
    expect(reg.liveSchemas().map((s) => s.name)).not.toContain("mcp:a:t");
    await svc.shutdownAll();
  });
});
```

- [ ] **Step 2: Run tests (should fail)**

Run: `bun test plugins/llm-mcp-bridge/test/service.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `service.ts`**

```ts
import type { ResolvedServerConfig } from "./config.ts";
import type { McpClientLike, CreateClientResult } from "./client.ts";
import { ServerLifecycle, type LifecycleDeps, type RegistryLike } from "./lifecycle.ts";
import { makeReadMcpResourceTool, makeListMcpResourcesTool, type NamedClient } from "./registration.ts";
import type { ServerInfo, McpBridgeService } from "./public.d.ts";

export interface BridgeDeps {
  registry: RegistryLike;
  log: (msg: string) => void;
  createClient: (cfg: ResolvedServerConfig) => CreateClientResult;
  initialServers: Map<string, ResolvedServerConfig>;
  // Test injection points; default to globalThis equivalents.
  setTimeout?: (cb: () => void, ms: number) => unknown;
  clearTimeout?: (h: unknown) => void;
  now?: () => number;
}

export interface InternalBridge extends McpBridgeService {
  shutdownAll(): Promise<void>;
}

export function makeBridgeService(deps: BridgeDeps): InternalBridge {
  const lifecycles = new Map<string, ServerLifecycle>();
  const setT = deps.setTimeout ?? ((cb, ms) => globalThis.setTimeout(cb, ms));
  const clrT = deps.clearTimeout ?? ((h) => globalThis.clearTimeout(h as any));
  const nowFn = deps.now ?? (() => Date.now());

  const makeLifecycle = (cfg: ResolvedServerConfig): ServerLifecycle => {
    const lcDeps: LifecycleDeps = {
      cfg,
      registry: deps.registry,
      log: deps.log,
      createClient: deps.createClient,
      setTimeout: setT,
      clearTimeout: clrT,
      now: nowFn,
    };
    return new ServerLifecycle(lcDeps);
  };

  // Register the two global resource tools once.
  const getClientByServer = (server: string): McpClientLike | undefined => lifecycles.get(server)?.getClient();
  const getHealthyClients = (): NamedClient[] => {
    const out: NamedClient[] = [];
    for (const [name, lc] of lifecycles) {
      const c = lc.getClient();
      if (c) out.push({ name, client: c });
    }
    return out;
  };
  const readReg = makeReadMcpResourceTool(getClientByServer);
  const listReg = makeListMcpResourcesTool(getHealthyClients);
  const unregisterRead = deps.registry.register(readReg.schema as any, readReg.handler as any);
  const unregisterList = deps.registry.register(listReg.schema as any, listReg.handler as any);

  // Start initial set.
  for (const [name, cfg] of deps.initialServers) {
    const lc = makeLifecycle(cfg);
    lifecycles.set(name, lc);
    lc.start();
  }

  function configsEqual(a: ResolvedServerConfig, b: ResolvedServerConfig): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  const svc: InternalBridge = {
    list(): ServerInfo[] {
      return [...lifecycles.values()].map((lc) => lc.info());
    },
    get(name: string) { return lifecycles.get(name)?.info(); },
    async reconnect(name: string) {
      const lc = lifecycles.get(name);
      if (!lc) throw new Error(`unknown server: ${name}`);
      await lc.forceReconnect();
    },
    async reload(newConfig: Map<string, ResolvedServerConfig>) {
      const added: string[] = []; const removed: string[] = []; const updated: string[] = [];
      // remove
      for (const [name, lc] of [...lifecycles]) {
        if (!newConfig.has(name)) {
          await lc.shutdown();
          lifecycles.delete(name);
          removed.push(name);
        }
      }
      // add or update
      for (const [name, cfg] of newConfig) {
        const existing = lifecycles.get(name);
        if (!existing) {
          const lc = makeLifecycle(cfg);
          lifecycles.set(name, lc);
          lc.start();
          added.push(name);
        } else {
          // Compare against the cfg we constructed it with.
          // We don't keep prior cfg snapshots, so we compare against the lifecycle's cfg via a stash.
          const prev = (existing as any).deps.cfg as ResolvedServerConfig;
          if (!configsEqual(prev, cfg)) {
            await existing.shutdown();
            const lc = makeLifecycle(cfg);
            lifecycles.set(name, lc);
            lc.start();
            updated.push(name);
          }
        }
      }
      return { added, removed, updated };
    },
    async shutdown(name: string) {
      const lc = lifecycles.get(name);
      if (!lc) return;
      await lc.shutdown();
      lifecycles.delete(name);
    },
    async shutdownAll() {
      for (const lc of lifecycles.values()) await lc.shutdown();
      lifecycles.clear();
      try { unregisterRead(); } catch { /* ignore */ }
      try { unregisterList(); } catch { /* ignore */ }
    },
  };

  return svc;
}

export type { ResolvedServerConfig };
```

> **Implementation note:** the `(existing as any).deps.cfg` peek into `ServerLifecycle.deps` is a deliberate ergonomic compromise documented here; if you'd rather, expose `lc.config(): ResolvedServerConfig` on `ServerLifecycle` and use that. Keep the surface area tight.

- [ ] **Step 4: If you chose the `.config()` getter, add it to `ServerLifecycle`**

In `lifecycle.ts`, add:

```ts
config(): ResolvedServerConfig { return this.deps.cfg; }
```

…and replace the `(existing as any).deps.cfg` peek in `service.ts` with `existing.config()`.

- [ ] **Step 5: Run tests**

Run: `bun test plugins/llm-mcp-bridge/test/service.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add plugins/llm-mcp-bridge/service.ts plugins/llm-mcp-bridge/lifecycle.ts plugins/llm-mcp-bridge/test/service.test.ts
git commit -m "feat(llm-mcp-bridge): McpBridgeService aggregator + reload diff"
```

---

## Task 10: `slash.ts` — `/mcp:list`, `/mcp:reload`, `/mcp:reconnect`, `/mcp:disable`

**Files:**
- Create: `plugins/llm-mcp-bridge/slash.ts`
- Create: `plugins/llm-mcp-bridge/test/slash.test.ts`

`registerSlashCommands(slashRegistry, bridge, reloadFromDisk, log)` registers the four commands and returns an array of unregister functions. All commands have `source: "plugin"` and use the namespaced `mcp:<verb>` form per Spec 8.

The reload command needs a way to re-read config from disk, so it accepts a `reloadFromDisk: () => Promise<Map<string, ResolvedServerConfig>>` thunk (the index wires this to `loadConfig(realDeps(...))`).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "bun:test";
import { registerSlashCommands } from "../slash.ts";
import type { ResolvedServerConfig } from "../config.ts";

class FakeSlashRegistry {
  registered: Array<{ manifest: any; handler?: any }> = [];
  register(manifest: any, handler: any) {
    this.registered.push({ manifest, handler });
    return () => { this.registered = this.registered.filter((e) => e.manifest.name !== manifest.name); };
  }
}

function makeBridge() {
  const events: string[] = [];
  return {
    events,
    list: () => [
      { name: "a", transport: "stdio" as const, status: "connected" as const, toolCount: 3, resourceCount: 0, promptCount: 0, reconnectAttempts: 0 },
      { name: "b", transport: "http" as const, status: "quarantined" as const, toolCount: 0, resourceCount: -1, promptCount: 0, reconnectAttempts: 5, lastError: "boom" },
    ],
    get: (n: string) => undefined,
    reconnect: async (n: string) => { events.push(`reconnect:${n}`); },
    reload: async (_: Map<string, ResolvedServerConfig>) => ({ added: ["c"], removed: [], updated: [] }),
    shutdown: async (n: string) => { events.push(`shutdown:${n}`); },
  };
}

describe("registerSlashCommands", () => {
  it("registers four namespaced plugin commands", () => {
    const sr = new FakeSlashRegistry();
    registerSlashCommands(sr as any, makeBridge() as any, async () => new Map(), () => {});
    const names = sr.registered.map((e) => e.manifest.name).sort();
    expect(names).toEqual(["mcp:disable", "mcp:list", "mcp:reconnect", "mcp:reload"]);
    for (const e of sr.registered) {
      expect(e.manifest.source).toBe("plugin");
    }
  });

  it("/mcp:list emits a status table", async () => {
    const sr = new FakeSlashRegistry();
    const out: string[] = [];
    registerSlashCommands(sr as any, makeBridge() as any, async () => new Map(), (m) => out.push(m));
    const list = sr.registered.find((e) => e.manifest.name === "mcp:list")!;
    const emitted: Array<{ name: string; payload: unknown }> = [];
    await list.handler({
      args: "",
      emit: async (n: string, p: unknown) => { emitted.push({ name: n, payload: p }); },
      signal: new AbortController().signal,
    });
    const last = emitted[emitted.length - 1];
    expect(last.name).toBe("conversation:system-message");
    expect(String((last.payload as any).content)).toContain("a");
    expect(String((last.payload as any).content)).toContain("connected");
    expect(String((last.payload as any).content)).toContain("quarantined");
  });

  it("/mcp:reload calls bridge.reload and reports diff", async () => {
    const sr = new FakeSlashRegistry();
    const out: string[] = [];
    registerSlashCommands(sr as any, makeBridge() as any, async () => new Map(), (m) => out.push(m));
    const r = sr.registered.find((e) => e.manifest.name === "mcp:reload")!;
    const emitted: Array<{ name: string; payload: unknown }> = [];
    await r.handler({
      args: "",
      emit: async (n: string, p: unknown) => { emitted.push({ name: n, payload: p }); },
      signal: new AbortController().signal,
    });
    const txt = String((emitted.at(-1)?.payload as any).content);
    expect(txt).toContain("added: c");
  });

  it("/mcp:reconnect <name> calls bridge.reconnect", async () => {
    const sr = new FakeSlashRegistry();
    const bridge = makeBridge();
    registerSlashCommands(sr as any, bridge as any, async () => new Map(), () => {});
    const r = sr.registered.find((e) => e.manifest.name === "mcp:reconnect")!;
    await r.handler({ args: "a", emit: async () => {}, signal: new AbortController().signal });
    expect(bridge.events).toContain("reconnect:a");
  });

  it("/mcp:reconnect with no arg emits usage", async () => {
    const sr = new FakeSlashRegistry();
    const bridge = makeBridge();
    registerSlashCommands(sr as any, bridge as any, async () => new Map(), () => {});
    const r = sr.registered.find((e) => e.manifest.name === "mcp:reconnect")!;
    const emitted: Array<{ name: string; payload: unknown }> = [];
    await r.handler({ args: "", emit: async (n, p) => { emitted.push({ name: n, payload: p }); }, signal: new AbortController().signal });
    expect(String((emitted.at(-1)?.payload as any).content).toLowerCase()).toContain("usage");
  });

  it("/mcp:disable <name> calls bridge.shutdown", async () => {
    const sr = new FakeSlashRegistry();
    const bridge = makeBridge();
    registerSlashCommands(sr as any, bridge as any, async () => new Map(), () => {});
    const r = sr.registered.find((e) => e.manifest.name === "mcp:disable")!;
    await r.handler({ args: "a", emit: async () => {}, signal: new AbortController().signal });
    expect(bridge.events).toContain("shutdown:a");
  });
});
```

- [ ] **Step 2: Run tests (should fail)**

Run: `bun test plugins/llm-mcp-bridge/test/slash.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `slash.ts`**

```ts
import type { McpBridgeService, ServerInfo } from "./public.d.ts";
import type { ResolvedServerConfig } from "./config.ts";

export interface SlashCommandManifestLike {
  name: string;
  description: string;
  source: "plugin";
}
export interface SlashCommandContextLike {
  args: string;
  emit: (event: string, payload: unknown) => Promise<void>;
  signal: AbortSignal;
}
export interface SlashCommandHandlerLike {
  (ctx: SlashCommandContextLike): Promise<void>;
}
export interface SlashRegistryLike {
  register(manifest: SlashCommandManifestLike, handler: SlashCommandHandlerLike): () => void;
}

function pad(s: string, n: number): string { return s.length >= n ? s : s + " ".repeat(n - s.length); }

function renderTable(rows: ServerInfo[]): string {
  const headers = ["name", "transport", "status", "tools", "resources", "lastError"];
  const data = rows.map((r) => [r.name, r.transport, r.status, String(r.toolCount), r.resourceCount < 0 ? "?" : String(r.resourceCount), r.lastError ?? ""]);
  const widths = headers.map((h, i) => Math.max(h.length, ...data.map((row) => row[i].length)));
  const fmt = (cols: string[]) => cols.map((c, i) => pad(c, widths[i])).join("  ");
  return [fmt(headers), fmt(headers.map(() => "----")), ...data.map(fmt)].join("\n");
}

async function emitSystem(ctx: SlashCommandContextLike, content: string): Promise<void> {
  await ctx.emit("conversation:system-message", { content });
}

export function registerSlashCommands(
  slash: SlashRegistryLike,
  bridge: McpBridgeService,
  reloadFromDisk: () => Promise<Map<string, ResolvedServerConfig>>,
  log: (msg: string) => void,
): Array<() => void> {
  const unregs: Array<() => void> = [];

  unregs.push(slash.register(
    { name: "mcp:list", description: "List configured MCP servers and their status.", source: "plugin" },
    async (ctx) => {
      const rows = bridge.list();
      const table = rows.length ? renderTable(rows) : "(no MCP servers configured)";
      await emitSystem(ctx, "MCP servers:\n" + table);
    },
  ));

  unregs.push(slash.register(
    { name: "mcp:reload", description: "Re-read MCP server config and apply changes.", source: "plugin" },
    async (ctx) => {
      try {
        const cfg = await reloadFromDisk();
        const diff = await bridge.reload(cfg);
        await emitSystem(ctx, `MCP reload applied. added: ${diff.added.join(", ") || "(none)"}; removed: ${diff.removed.join(", ") || "(none)"}; updated: ${diff.updated.join(", ") || "(none)"}.`);
      } catch (err) {
        log(`/mcp:reload failed: ${(err as Error).message}`);
        await emitSystem(ctx, `MCP reload failed: ${(err as Error).message}`);
      }
    },
  ));

  unregs.push(slash.register(
    { name: "mcp:reconnect", description: "Force reconnect a server. Usage: /mcp:reconnect <server>", source: "plugin" },
    async (ctx) => {
      const name = ctx.args.trim();
      if (!name) { await emitSystem(ctx, "usage: /mcp:reconnect <server>"); return; }
      try {
        await bridge.reconnect(name);
        await emitSystem(ctx, `MCP reconnect requested for "${name}".`);
      } catch (err) {
        await emitSystem(ctx, `MCP reconnect "${name}" failed: ${(err as Error).message}`);
      }
    },
  ));

  unregs.push(slash.register(
    { name: "mcp:disable", description: "Disable a server until next /mcp:reload. Usage: /mcp:disable <server>", source: "plugin" },
    async (ctx) => {
      const name = ctx.args.trim();
      if (!name) { await emitSystem(ctx, "usage: /mcp:disable <server>"); return; }
      try {
        await bridge.shutdown(name);
        await emitSystem(ctx, `MCP server "${name}" shut down.`);
      } catch (err) {
        await emitSystem(ctx, `MCP disable "${name}" failed: ${(err as Error).message}`);
      }
    },
  ));

  return unregs;
}
```

- [ ] **Step 4: Run tests**

Run: `bun test plugins/llm-mcp-bridge/test/slash.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-mcp-bridge/slash.ts plugins/llm-mcp-bridge/test/slash.test.ts
git commit -m "feat(llm-mcp-bridge): namespaced slash commands /mcp:{list,reload,reconnect,disable}"
```

---

## Task 11: `index.ts` — plugin glue, setup hook, status-bar integration

**Files:**
- Modify: `plugins/llm-mcp-bridge/index.ts`

The plugin's `setup`:
1. `loadConfig(realDeps(log))` — get initial server map + warnings.
2. Resolve `tools:registry` via `ctx.useService("tools:registry")`. If absent, log error, register zero tools, but still register slash commands and provide a degraded `mcp:bridge` service.
3. Build the `BridgeDeps` (use real `client.ts` `createClient`, real timers, real `Date.now`).
4. `makeBridgeService(deps)` and `provideService("mcp:bridge", svc)`.
5. Resolve `slash:registry` via `ctx.useService("slash:registry")` (optional). If present, call `registerSlashCommands`. If absent, log info and skip.
6. Subscribe to `session:end`: `await svc.shutdownAll()`.
7. If status-items service is present, push `status:item-update` keyed `mcp` showing connected/total counts; recompute on each lifecycle status change via `onStatusChange`.

- [ ] **Step 1: Replace `index.ts` body**

```ts
import type { KaizenPlugin } from "kaizen/types";
import type { McpBridgeService, ServerInfo } from "./public.d.ts";
import type { ToolsRegistryService } from "llm-events/public";
import { loadConfig, realDeps, type ResolvedServerConfig } from "./config.ts";
import { createClient } from "./client.ts";
import { makeBridgeService } from "./service.ts";
import { registerSlashCommands, type SlashRegistryLike } from "./slash.ts";

const VERSION = "0.1.0";

const plugin: KaizenPlugin = {
  name: "llm-mcp-bridge",
  apiVersion: "3.0.0",
  permissions: { tier: "unscoped" },
  services: { provides: ["mcp:bridge"], consumes: ["tools:registry", "llm-events:vocabulary"] },

  async setup(ctx) {
    const log = (m: string) => ctx.log(m);
    const cfgDeps = realDeps(log);
    const initial = await loadConfig(cfgDeps);
    for (const w of initial.warnings) log(`llm-mcp-bridge: ${w}`);

    ctx.defineService("mcp:bridge", { description: "Owns MCP server lifecycles; surfaces their tools and resources." });

    const registry = ctx.useService<ToolsRegistryService>("tools:registry");
    if (!registry) {
      log("llm-mcp-bridge: tools:registry service unavailable; MCP tools will not be registered");
      // Provide a no-op mcp:bridge so /mcp:list still works (returns empty).
      ctx.provideService<McpBridgeService>("mcp:bridge", {
        list: () => [],
        get: () => undefined,
        reconnect: async () => { throw new Error("tools:registry unavailable"); },
        reload: async () => ({ added: [], removed: [], updated: [] }),
        shutdown: async () => {},
      });
      return;
    }

    const svc = makeBridgeService({
      registry: { register: (s, h) => registry.register(s as any, h as any) },
      log,
      createClient: (cfg) => createClient(cfg, { log, version: VERSION }),
      initialServers: initial.servers,
    });
    ctx.provideService<McpBridgeService>("mcp:bridge", svc);

    // Slash commands (soft dependency).
    const slash = ctx.useService<SlashRegistryLike>("slash:registry");
    if (slash) {
      registerSlashCommands(slash, svc, async () => (await loadConfig(realDeps(log))).servers, log);
    } else {
      log("llm-mcp-bridge: slash:registry not present; /mcp:* commands not registered");
    }

    // Status-bar integration (best-effort).
    const updateStatus = () => {
      const rows = svc.list();
      const total = rows.length;
      const connected = rows.filter((r) => r.status === "connected").length;
      const quarantined = rows.some((r) => r.status === "quarantined");
      const value = total === 0 ? "" : `mcp: ${connected}/${total}${quarantined ? " ⚠" : ""}`;
      void ctx.emit("status:item-update", { key: "mcp", value });
    };
    // Recompute on a 5s tick rather than wiring per-lifecycle callbacks (simpler; status bar already debounces).
    const statusTimer = setInterval(updateStatus, 5000);
    updateStatus();

    ctx.on("session:end", async () => {
      clearInterval(statusTimer);
      await ctx.emit("status:item-clear", { key: "mcp" });
      await svc.shutdownAll();
    });
  },
};

export default plugin;
```

> **Note:** `ctx.useService` returns `undefined` when the service is not provided. If your harness uses a different no-op signal (e.g. throws), adjust the guard. Refer to `plugins/openai-llm/index.ts` for the canonical pattern in this codebase.

- [ ] **Step 2: Update `public.d.ts` to also re-export `ResolvedServerConfig`** (some consumers may need it):

```ts
export type ServerStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "quarantined"
  | "disabled";

export interface ServerInfo {
  name: string;
  transport: "stdio" | "sse" | "http";
  status: ServerStatus;
  toolCount: number;
  resourceCount: number;
  promptCount: number;
  lastError?: string;
  connectedAt?: number;
  reconnectAttempts: number;
}

export interface McpBridgeService {
  list(): ServerInfo[];
  get(name: string): ServerInfo | undefined;
  reconnect(name: string): Promise<void>;
  reload(newConfig: Map<string, import("./config.ts").ResolvedServerConfig>): Promise<{ added: string[]; removed: string[]; updated: string[] }>;
  shutdown(name: string): Promise<void>;
}
```

- [ ] **Step 3: Run all unit tests**

Run: `bun test plugins/llm-mcp-bridge/test/ --bail`
Expected: PASS for every test file (skip integration; that's Task 13).

- [ ] **Step 4: Type-check**

Run: `bun --bun tsc --noEmit -p plugins/llm-mcp-bridge/tsconfig.json $(ls plugins/llm-mcp-bridge/*.ts)`
Expected: no diagnostics.

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-mcp-bridge/index.ts plugins/llm-mcp-bridge/public.d.ts
git commit -m "feat(llm-mcp-bridge): wire setup hook, slash commands, status-bar integration"
```

---

## Task 12: Live integration test against `@modelcontextprotocol/server-everything`

**Files:**
- Create: `plugins/llm-mcp-bridge/test/integration/server-everything.test.ts`

Gated on `KAIZEN_INTEGRATION=1`. Spins a real `npx -y @modelcontextprotocol/server-everything` over stdio, asserts:
1. The lifecycle reaches `connected`.
2. At least one tool is registered with `mcp:everything:*` prefix.
3. Calling one of those tools through the registry's `invoke` path (we mock the registry locally; the integration verifies the SDK boundary, not the harness wiring) returns a non-error result.
4. Killing the server externally triggers reconnect.

- [ ] **Step 1: Write the integration test**

```ts
import { describe, it, expect } from "bun:test";
import { ServerLifecycle } from "../../lifecycle.ts";
import { createClient } from "../../client.ts";
import type { ResolvedServerConfig } from "../../config.ts";

const RUN = process.env.KAIZEN_INTEGRATION === "1";
const maybe = RUN ? describe : describe.skip;

class FakeRegistry {
  registered = new Map<string, { schema: any; handler: any }>();
  register(s: any, h: any) { this.registered.set(s.name, { schema: s, handler: h }); return () => this.registered.delete(s.name); }
}

function tick(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

maybe("integration: @modelcontextprotocol/server-everything", () => {
  it("connects, lists tools, invokes one successfully", async () => {
    const reg = new FakeRegistry();
    const cfg: ResolvedServerConfig = {
      name: "everything",
      transport: "stdio",
      enabled: true,
      timeoutMs: 30000,
      healthCheckMs: 60000,
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-everything"],
    };
    const lc = new ServerLifecycle({
      cfg,
      registry: reg,
      log: (m) => console.error("[int]", m),
      createClient: (c) => createClient(c, { log: () => {}, version: "0.1.0-test" }),
      setTimeout: (cb, ms) => globalThis.setTimeout(cb, ms),
      clearTimeout: (h) => globalThis.clearTimeout(h as any),
      now: () => Date.now(),
    });
    lc.start();
    // Allow up to 15s for npx + handshake.
    for (let i = 0; i < 75; i++) {
      if (lc.info().status === "connected") break;
      await tick(200);
    }
    expect(lc.info().status).toBe("connected");
    const live = [...reg.registered.keys()].filter((n) => n.startsWith("mcp:everything:"));
    expect(live.length).toBeGreaterThan(0);
    // Invoke the first tool with a permissive empty-ish argument; some tools require args, so we just assert no protocol-level explosion.
    const first = reg.registered.get(live[0])!;
    const ac = new AbortController();
    let invokeErr: Error | undefined;
    try {
      await first.handler({}, { signal: ac.signal, callId: "int-1", log: () => {} });
    } catch (err) { invokeErr = err as Error; }
    // Either a clean result OR a structured tool error (e.g. invalid_arguments) is acceptable;
    // a transport-level explosion is not.
    if (invokeErr) {
      expect(invokeErr.message).not.toMatch(/EPIPE|ECONN|process exited|disconnected/i);
    }
    await lc.shutdown();
  });
});
```

- [ ] **Step 2: Document gating in README** (will land in Task 14).

- [ ] **Step 3: Local verification (operator runs once)**

```bash
KAIZEN_INTEGRATION=1 bun test plugins/llm-mcp-bridge/test/integration/server-everything.test.ts
```

Expected: PASS, 1 test. (Network access required for `npx` first run; subsequent runs use the npm cache.)

- [ ] **Step 4: Commit**

```bash
git add plugins/llm-mcp-bridge/test/integration/server-everything.test.ts
git commit -m "test(llm-mcp-bridge): gated live integration against server-everything"
```

---

## Task 13: README — trust model, config schema, v0 prompt-skip note

**Files:**
- Modify: `plugins/llm-mcp-bridge/README.md`

Replace the placeholder. Required sections per Spec 11 acceptance criteria:
- Dependency on `@modelcontextprotocol/sdk` (with the pinned version).
- **Trust** section — MCP servers run unsandboxed; vet `command`+`args`.
- Config schema with `~/.kaizen/mcp/servers.json` location.
- Resource-via-tool design (no per-resource enumeration; `read_mcp_resource` + `list_mcp_resources`).
- v0 prompt-skip behavior (capability ignored; v1 will register `/mcp:<server>:<prompt>`).
- Slash commands (`/mcp:list`, `/mcp:reload`, `/mcp:reconnect`, `/mcp:disable`).
- Integration test gating (`KAIZEN_INTEGRATION=1`).

- [ ] **Step 1: Write `README.md`**

```markdown
# llm-mcp-bridge

Bridge MCP (Model Context Protocol) servers into the kaizen openai-compatible
harness. v0 surfaces **tools and resources only** — prompts are deferred to v1.

## Dependencies

- Hard: `@modelcontextprotocol/sdk` (pinned in `package.json`), `llm-events`,
  `tools:registry` (provided by `llm-tools-registry`).
- Soft: `slash:registry` (provided by `llm-slash-commands`). If absent,
  `/mcp:*` commands are not registered; tool surfacing still works.

## Trust

MCP servers run with the **same privileges as the harness**. There is no
sandboxing. Before adding a server, audit:

- `command` and `args` (especially `npx ...` packages — pin a specific version
  via `@<version>` to prevent silent upgrades).
- The scope of the package; prefer `@modelcontextprotocol/*` and other vetted
  publishers.
- Any environment variables you grant via `env`.

## Configuration

The bridge reads, in this priority order (later sources override earlier):

1. `~/.kaizen/mcp/servers.json` (user-scoped)
2. `<project>/.kaizen/mcp/servers.json` (project-scoped, overrides user)
3. `${KAIZEN_MCP_CONFIG}` (full path; overrides both, intended for CI)

If no file exists, the plugin logs an info line and registers zero MCP tools.

### Schema

The format mirrors Claude Code's MCP config so entries copy across:

\`\`\`jsonc
{
  "servers": {
    "filesystem": {
      "transport": "stdio",                                       // optional; inferred
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem@1.0.0", "/Users/me/code"],
      "env": { "DEBUG": "1" },
      "cwd": "/Users/me",
      "enabled": true,
      "timeoutMs": 30000,
      "healthCheckMs": 60000
    },
    "github": {
      "transport": "sse",
      "url": "https://mcp.example.com/sse",
      "headers": { "Authorization": "Bearer ${env:GITHUB_MCP_TOKEN}" }
    },
    "internal-api": {
      "transport": "http",
      "url": "http://localhost:8080/mcp",
      "headers": { "X-API-Key": "${env:INTERNAL_KEY}" }
    }
  }
}
\`\`\`

- `transport` is inferred when omitted: `command` ⇒ `stdio`, `url` only ⇒ `http`.
  Use `"sse"` explicitly for Server-Sent-Events transports.
- `${env:VAR}` is interpolated at load time. If `VAR` is unset, the server is
  skipped with a warning and the rest continue.
- Server names must match `/^[a-z0-9][a-z0-9_-]*$/` because they participate in
  tool names (`mcp:<server>:<tool>`).

## What gets registered

- **Tools.** Each MCP tool the server reports is registered as
  `mcp:<server>:<toolname>` with tags `["mcp", "mcp:<server>"]`. The MCP
  `inputSchema` is used verbatim as the kaizen `parameters` JSONSchema.
- **Resources** — _not enumerated._ Two universal tools are registered once
  globally:
  - `read_mcp_resource({ server, uri })` proxies to `resources/read`.
  - `list_mcp_resources({ server? })` aggregates `resources/list` across all
    healthy servers (or one).
  This keeps the LLM's tool budget bounded regardless of how many resources a
  server exposes.
- **Prompts** — _not surfaced in v0._ If a server's `initialize` advertises
  `prompts: {}`, the capability is ignored (logged at debug). v1 will register
  prompts as `/mcp:<server>:<prompt>` slash commands; **not** as skills.

## Slash commands

If `slash:registry` is provided by `llm-slash-commands`, four namespaced
plugin commands are registered (Spec 8 mandates the namespace prefix):

- `/mcp:list` — status table of all configured servers.
- `/mcp:reload` — re-read config from disk and apply the diff (no file watch).
- `/mcp:reconnect <server>` — force reconnect; clears quarantine.
- `/mcp:disable <server>` — shut down and unregister tools until next reload.

## Lifecycle

Each server is owned end-to-end by the bridge:

1. **Connect** — spawn subprocess (stdio) / open EventSource (sse) / nothing
   persistent (http).
2. **Handshake** — `initialize`; capabilities recorded.
3. **Health** — `ping` every `healthCheckMs` (default 60s). Failures are
   treated as disconnects.
4. **Reconnect** — exponential backoff `1s, 2s, 4s, 8s, 16s` capped at 60s; 5
   attempts before quarantine.
5. **Shutdown** — on `session:end`, SIGTERM stdio (force-kill after 5s), close
   transports, unregister tools.

Tools registered by a quarantined server **remain in the registry** with their
handlers fast-failing (`mcp_server_unavailable: <name>`) — this avoids
tool-list churn for the LLM. `/mcp:reconnect <name>` revives the server.

## Status bar

If a status-items service is present, the bridge publishes
`status:item-update { key: "mcp", value: "mcp: 3/4" }` (warning marker
appended on quarantine).

## Testing

\`\`\`sh
bun test plugins/llm-mcp-bridge/
\`\`\`

The integration test against the SDK's reference server is gated:

\`\`\`sh
KAIZEN_INTEGRATION=1 bun test plugins/llm-mcp-bridge/test/integration/
\`\`\`

## v1 plan (deferred)

Prompts will register into `slash:registry` as `/mcp:<server>:<prompt>` with
`key=value` argument parsing, calling `prompts/get` and injecting the rendered
messages via the driver's `runConversation`. See Spec 11 for the design.
```

- [ ] **Step 2: Commit**

```bash
git add plugins/llm-mcp-bridge/README.md
git commit -m "docs(llm-mcp-bridge): trust model, config schema, v0 prompt-skip"
```

---

## Task 14: Marketplace catalog entry

**Files:**
- Modify: `.kaizen/marketplace.json`

Add a new entry for `llm-mcp-bridge` v0.1.0.

- [ ] **Step 1: Read current `.kaizen/marketplace.json`**

Use the Read tool. Locate the `entries` array.

- [ ] **Step 2: Append the new entry** (after `openai-llm`'s entry, before the harness entries):

```json
    {
      "kind": "plugin",
      "name": "llm-mcp-bridge",
      "description": "Bridge MCP servers (tools + resources) into the kaizen tools:registry. v0 — prompts deferred.",
      "categories": ["mcp", "tools"],
      "versions": [{ "version": "0.1.0", "source": { "type": "file", "path": "plugins/llm-mcp-bridge" } }]
    },
```

- [ ] **Step 3: Validate JSON**

Run: `bun -e 'console.log(Object.keys(JSON.parse(await Bun.file(".kaizen/marketplace.json").text())))'`
Expected: prints `["version","name","description","url","entries"]` (order may vary).

- [ ] **Step 4: Run the full plugin test suite once more**

Run: `bun test plugins/llm-mcp-bridge/`
Expected: PASS (integration tests skipped because `KAIZEN_INTEGRATION` is unset).

- [ ] **Step 5: Commit**

```bash
git add .kaizen/marketplace.json
git commit -m "chore(marketplace): publish llm-mcp-bridge@0.1.0"
```

---

## Self-Review Notes

Before marking the plan complete, the implementer should re-read Spec 11 sections **Server lifecycle**, **Configuration**, **Artifact translation**, **Service interface**, **Slash commands**, **Failure modes**, and **Acceptance criteria** and verify each line maps to a task above. Notable mappings:

- Lifecycle Phases 1–5 → Task 8 (`lifecycle.ts`) plus Task 11 (`session:end` hook for Phase 5 driver).
- Config locations + merge + env interpolation → Task 2.
- Tools translation + namespacing → Task 7 + Task 8 (`reconcileTools`).
- Resources via two tools → Task 7 + Task 9 (registered once globally).
- v0 prompts skipped → asserted by `lifecycle.test.ts` "ignores prompts capability" + Task 13 README.
- `mcp:bridge` service surface → Task 9.
- Slash commands namespaced + soft dependency → Task 10 + Task 11.
- Status bar → Task 11.
- Trust + permissions `unscoped` → Task 1 manifest + Task 13 README.
- Failure modes (malformed JSON, missing env, name validation, collisions) → Task 2 + Task 8 (`registry.register` throws on dup; we log and continue).
- Acceptance: live regression with `server-everything` → Task 12.

Open items the implementer may need to confirm against the live SDK at execution time:
- The exact import path for `StreamableHTTPClientTransport` in the pinned SDK version.
- Whether the SDK's `Client.connect(transport)` automatically issues `initialize`, or whether an explicit call is needed (current `client.ts` assumes auto).
- The `setNotificationHandler` API shape for `notifications/tools/list_changed`.

If any of these differ, adjust **only `client.ts`** — the rest of the plan should not need to move.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-30-llm-mcp-bridge.md`. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task with two-stage review.
2. **Inline Execution** — batch execution with checkpoints.

Which approach?
