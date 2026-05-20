// plugins/kaizen-config/envvars.ts
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
