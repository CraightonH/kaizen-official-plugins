import type { ToolsRegistryService } from "./registry.ts";
import type { ToolSource, ToolRegistration } from "./public.d.ts";

export interface SlashCommandManifestLike {
  name: string;
  description: string;
  source: "plugin";
  usage?: string;
}
export interface SlashCommandContextLike {
  args: string;
  print: (text: string) => Promise<void>;
}
export interface SlashCommandHandlerLike {
  (ctx: SlashCommandContextLike): Promise<void>;
}
export interface SlashRegistryLike {
  register(manifest: SlashCommandManifestLike, handler: SlashCommandHandlerLike): () => void;
}

function sourceKey(source: ToolSource): string {
  switch (source.kind) {
    case "mcp": return `mcp:${source.server}`;
    default: return source.kind;
  }
}

function groupOrder(a: string, b: string): number {
  // local first, then alpha (mcp:* groups together via prefix sort)
  if (a === "local" && b !== "local") return -1;
  if (b === "local" && a !== "local") return 1;
  return a.localeCompare(b);
}

function renderList(regs: ToolRegistration[]): string {
  if (regs.length === 0) return "(no tools registered)";

  const groups = new Map<string, ToolRegistration[]>();
  for (const r of regs) {
    const key = sourceKey(r.source);
    const arr = groups.get(key) ?? [];
    arr.push(r);
    groups.set(key, arr);
  }

  const lines: string[] = [`Tools (${regs.length} total)`, ""];
  const keys = [...groups.keys()].sort(groupOrder);
  for (const key of keys) {
    const items = groups.get(key)!.slice().sort((a, b) => a.schema.name.localeCompare(b.schema.name));
    lines.push(`${key} (${items.length})`);
    for (const r of items) {
      lines.push(`  ${r.schema.name} — ${r.schema.description}`);
    }
    lines.push("");
  }
  return lines.join("\n").replace(/\n+$/, "");
}

function renderShow(reg: ToolRegistration): string {
  const lines: string[] = [];
  lines.push(`name:        ${reg.schema.name}`);
  lines.push(`source:      ${sourceKey(reg.source)}`);
  lines.push(`description: ${reg.schema.description}`);
  if (reg.schema.tags?.length) lines.push(`tags:        ${reg.schema.tags.join(", ")}`);
  lines.push("parameters:");
  lines.push(JSON.stringify(reg.schema.parameters, null, 2));
  return lines.join("\n");
}

export function registerSlashCommands(
  slash: SlashRegistryLike,
  registry: ToolsRegistryService,
): Array<() => void> {
  const unregs: Array<() => void> = [];

  unregs.push(slash.register(
    {
      name: "tools:list",
      description: "List registered tools, grouped by source.",
      source: "plugin",
    },
    async (ctx) => {
      const regs = registry.listRegistrations();
      await ctx.print(renderList(regs));
    },
  ));

  unregs.push(slash.register(
    {
      name: "tools:show",
      description: "Show the full schema for one tool.",
      usage: "<name>",
      source: "plugin",
    },
    async (ctx) => {
      const name = ctx.args.trim();
      if (!name) {
        await ctx.print("usage: /tools:show <name>");
        return;
      }
      const matches = registry.listRegistrations({ names: [name] });
      if (matches.length === 0) {
        await ctx.print(`unknown tool: ${name}`);
        return;
      }
      await ctx.print(renderShow(matches[0]));
    },
  ));

  return unregs;
}
