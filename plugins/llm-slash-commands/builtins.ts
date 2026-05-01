import type {
  SlashCommandContext,
  SlashCommandManifest,
  SlashRegistryService,
} from "./registry.ts";

interface Group {
  label: string;
  match: (m: SlashCommandManifest) => boolean;
}

const DRIVER_BARE_NAMES = new Set(["clear", "model"]);

const GROUPS: Group[] = [
  // Built-ins shipped by this plugin (bare names not in the driver set).
  { label: "Built-in", match: (m) => m.source === "builtin" && !m.name.includes(":") && !DRIVER_BARE_NAMES.has(m.name) },
  { label: "Driver",   match: (m) => m.source === "builtin" && DRIVER_BARE_NAMES.has(m.name) },
  { label: "Skills",   match: (m) => m.name === "skills" || m.name.startsWith("skills:") || m.name.startsWith("skills-") },
  { label: "Agents",   match: (m) => m.name === "agents" || m.name.startsWith("agents:") },
  { label: "Memory",   match: (m) => m.name.startsWith("memory:") },
  { label: "MCP",      match: (m) => m.name.startsWith("mcp:") },
  { label: "User",     match: (m) => m.source === "file" },
];

function formatLine(m: SlashCommandManifest): string {
  const head = m.usage ? `/${m.name} ${m.usage}` : `/${m.name}`;
  return `  ${head} — ${m.description}`;
}

function formatEntry(m: SlashCommandManifest): string {
  const head = m.usage ? `/${m.name} ${m.usage}` : `/${m.name}`;
  const tail = m.filePath ? `\n  source: ${m.filePath}` : "";
  return `${head} — ${m.description}${tail}`;
}

function helpAll(registry: SlashRegistryService): string {
  const all = registry.list();
  const lines: string[] = [];
  const consumed = new Set<string>();

  for (const g of GROUPS) {
    const items = all.filter((m) => !consumed.has(m.name) && g.match(m));
    if (items.length === 0) continue;
    items.forEach((m) => consumed.add(m.name));
    lines.push(g.label);
    for (const m of items) lines.push(formatLine(m));
    lines.push("");
  }

  const rest = all.filter((m) => !consumed.has(m.name));
  if (rest.length) {
    lines.push("Other");
    for (const m of rest) lines.push(formatLine(m));
    lines.push("");
  }

  return lines.join("\n").replace(/\n+$/, "");
}

export function registerBuiltins(registry: SlashRegistryService): void {
  registry.register(
    { name: "help", description: "List available slash commands", source: "builtin", usage: "[command]" },
    async (ctx: SlashCommandContext) => {
      const arg = ctx.args.trim();
      if (!arg) {
        await ctx.print(helpAll(registry));
        return;
      }
      const entry = registry.get(arg);
      if (!entry) {
        await ctx.print(`Unknown command: /${arg}.`);
        return;
      }
      await ctx.print(formatEntry(entry.manifest));
    },
  );

  registry.register(
    { name: "exit", description: "End the session", source: "builtin" },
    async (ctx: SlashCommandContext) => {
      await ctx.emit("session:end", {});
    },
  );
}
