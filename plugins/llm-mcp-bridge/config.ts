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
    // No MCP config files is the common default — stay silent.
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
