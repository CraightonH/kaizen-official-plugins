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
