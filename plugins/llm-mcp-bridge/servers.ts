// Pure server-config resolution: takes the `servers` map from config:store and
// applies plugin-specific transforms — `${env:VAR}` interpolation, server-name
// validation, and transport inference. Returns resolved configs ready for the
// lifecycle layer.

export type Transport = "stdio" | "sse" | "http";

export interface ServerConfig {
  transport?: Transport;
  enabled?: boolean;
  timeoutMs?: number;
  healthCheckMs?: number;
  // stdio
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  // sse / http
  url?: string;
  headers?: Record<string, string>;
  // additional fields allowed (additionalProperties: true in schema)
  [k: string]: unknown;
}

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

export interface ResolveResult {
  servers: Map<string, ResolvedServerConfig>;
  warnings: string[];
}

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
const ENV_INTERP_RE = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
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

/**
 * Resolve a `servers` map (as loaded from config:store) into runtime configs.
 *
 * Applies (in order):
 *   - server-name validation (must match /^[a-z0-9][a-z0-9_-]*$/)
 *   - deep `${env:VAR}` interpolation across all string fields; one missing var
 *     skips that one server with a warning
 *   - transport inference (explicit `transport`, else `command` → stdio, else `url` → http)
 *   - defaults: enabled=true, timeoutMs=30000, healthCheckMs=60000
 */
export function resolveServers(
  servers: Record<string, unknown> | undefined | null,
  env: Record<string, string | undefined>,
): ResolveResult {
  const warnings: string[] = [];
  const out = new Map<string, ResolvedServerConfig>();
  if (!isPlainObject(servers)) return { servers: out, warnings };
  for (const [name, raw] of Object.entries(servers)) {
    if (!NAME_RE.test(name)) {
      warnings.push(`server name "${name}" invalid (must match ${NAME_RE}); skipping`);
      continue;
    }
    if (!isPlainObject(raw)) {
      warnings.push(`server "${name}": entry must be an object; skipping`);
      continue;
    }
    const resolved = resolveOne(name, raw, env, warnings);
    if (!resolved) continue;
    out.set(name, resolved);
  }
  return { servers: out, warnings };
}
