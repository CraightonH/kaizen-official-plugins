// plugins/kaizen-config/slash.ts
import type { ConfigStoreService, SecretsRegistryService, SlashCommandManifest, SlashCommandHandler, ConfigSchema, FieldSchema } from "llm-contracts/public";
import { redactSnapshot, redactValue } from "./secrets/redact.ts";
import { pluginCompletions, keyEqualsValueCompletions, keyOnlyCompletions } from "./slash-completions.ts";

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
  registry: SecretsRegistryService;
  defaultSecretBackend: () => string | undefined;
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

  offs.push(reg.register(
    {
      name: "config:get",
      description: "Print the merged config for a plugin. Usage: /config:get <plugin> [key.path] [--reveal]",
      source: "plugin",
      arguments: [
        { name: "plugin", complete: () => pluginCompletions(deps.store) },
        { name: "key", complete: (prev) => keyOnlyCompletions(deps.store, prev) },
      ],
      flags: [{ name: "--reveal", description: "Reveal secret values" }],
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

  offs.push(reg.register(
    {
      name: "config:set",
      description: "Set a config value. Usage: /config:set <plugin> <key>=<value> [--project]",
      source: "plugin",
      arguments: [
        { name: "plugin", complete: () => pluginCompletions(deps.store) },
        { name: "key=value", complete: (prev, query) => keyEqualsValueCompletions(deps.store, prev, query), selfFilters: true },
      ],
      flags: [{ name: "--project", description: "Write to project scope" }],
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
      name: "config:unset",
      description: "Remove a config key. Usage: /config:unset <plugin> <key> [--project]",
      source: "plugin",
      arguments: [
        { name: "plugin", complete: () => pluginCompletions(deps.store) },
        { name: "key", complete: (prev) => keyOnlyCompletions(deps.store, prev) },
      ],
      flags: [{ name: "--project", description: "Write to project scope" }],
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
