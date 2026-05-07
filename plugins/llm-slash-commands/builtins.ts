import type {
  SlashCommandContext,
  SlashCommandManifest,
  SlashRegistryService,
} from "./registry.ts";
import type { SessionsStoreService, SessionRecord } from "llm-session-manager/public";

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
  { label: "Sessions", match: (m) => m.name.startsWith("session:") },
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

export interface BuiltinDeps {
  sessions?: SessionsStoreService;
  getActiveSessionId?: () => string | null;
  log?: (msg: string) => void;
}

function sessionLine(record: SessionRecord): string {
  const label = record.alias ? ` (${record.alias})` : "";
  const agent = record.agentName ? ` agent=${record.agentName}` : "";
  const marker = record.parentSessionId ? "  " : "";
  return `${marker}${record.id}${label}${agent}`;
}

async function resolveSession(sessions: SessionsStoreService, token: string): Promise<SessionRecord> {
  if (!token) throw new Error("missing session id");
  if (await sessions.exists(token)) return sessions.load(token);
  const all = await sessions.list({ includeChildren: true });
  const match = all.find((record) => record.alias === token);
  if (!match) throw new Error(`session not found: ${token}`);
  return match;
}

export function registerBuiltins(registry: SlashRegistryService, deps: BuiltinDeps = {}): void {
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
      await ctx.emit("harness:exit-requested", {});
    },
  );

  registry.register(
    { name: "history", description: "Open the session audit view (j/k focus, Enter expand, q quit)", source: "builtin" },
    async (ctx: SlashCommandContext) => {
      await ctx.emit("tui:enter-history", {});
    },
  );

  if (!deps.sessions) return;
  const sessions = deps.sessions;

  registry.register(
    { name: "clear", description: "Archive current session and start a fresh one", source: "builtin" },
    async (ctx) => {
      const from = deps.getActiveSessionId?.() ?? null;
      const next = await sessions.create({});
      await ctx.emit("session:active-changed", { from, to: next.id, alias: next.alias ?? null });
      await ctx.emit("conversation:cleared", { from, to: next.id });
      await ctx.print(`Active session: ${next.id}`);
    },
  );

  registry.register(
    { name: "session:new", description: "Create and switch to a new top-level session", source: "builtin" },
    async (ctx) => {
      const from = deps.getActiveSessionId?.() ?? null;
      const next = await sessions.create({});
      await ctx.emit("session:active-changed", { from, to: next.id, alias: next.alias ?? null });
      await ctx.print(`Active session: ${next.id}`);
    },
  );

  registry.register(
    { name: "session:list", description: "List sessions", source: "builtin", usage: "[--all]" },
    async (ctx) => {
      const includeChildren = ctx.args.split(/\s+/).filter(Boolean).includes("--all");
      const rows = await sessions.list({ includeChildren });
      await ctx.print(rows.length ? rows.map(sessionLine).join("\n") : "No sessions.");
    },
  );

  registry.register(
    { name: "session:resume", description: "Resume a session by id or alias", source: "builtin", usage: "<id|alias>" },
    async (ctx) => {
      const token = ctx.args.trim();
      const record = await resolveSession(sessions, token);
      const from = deps.getActiveSessionId?.() ?? null;
      await ctx.emit("session:active-changed", { from, to: record.id, alias: record.alias ?? null });
      await ctx.emit("session:resumed", { id: record.id });
      await ctx.print(`Active session: ${record.id}`);
    },
  );

  registry.register(
    {
      name: "session:rename",
      description: "Rename the active session (alias only; id is unchanged)",
      source: "builtin",
      usage: "<new-name>",
    },
    async (ctx) => {
      const newName = ctx.args.trim();
      if (!newName) throw new Error("missing new session name");
      const active = deps.getActiveSessionId?.() ?? null;
      if (!active) throw new Error("no active session to rename");
      const record = await sessions.rename(active, newName);
      await ctx.print(`Renamed session ${record.id} → ${record.alias}`);
    },
  );

  registry.register(
    { name: "session:delete", description: "Delete a session", source: "builtin", usage: "<id> [--cascade]" },
    async (ctx) => {
      const parts = ctx.args.split(/\s+/).filter(Boolean);
      const cascade = parts.includes("--cascade");
      const id = parts.find((part) => part !== "--cascade");
      if (!id) throw new Error("missing session id");
      const active = deps.getActiveSessionId?.() ?? null;

      if (id !== active) {
        await sessions.delete(id, { cascade });
        await ctx.print(`Deleted session: ${id}`);
        return;
      }

      const all = await sessions.list({ includeChildren: true });
      const hasChildren = all.some((record) => record.id.startsWith(id + "/"));
      if (hasChildren && !cascade) {
        throw new Error(`delete: session '${id}' has children; pass --cascade`);
      }

      const replacement = await sessions.create({});
      try {
        await sessions.delete(id, { cascade });
      } catch (err) {
        try {
          await sessions.delete(replacement.id, { cascade: true });
        } catch (cleanupErr) {
          deps.log?.(`llm-slash-commands: failed to delete unused replacement session ${replacement.id}: ${String((cleanupErr as any)?.message ?? cleanupErr)}`);
        }
        throw err;
      }
      await ctx.emit("session:active-changed", { from: id, to: replacement.id, alias: replacement.alias ?? null });
      await ctx.print(`Active session: ${replacement.id}`);
    },
  );
}
