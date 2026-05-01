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
  bridge: McpBridgeService & { reload(cfg: Map<string, ResolvedServerConfig>): Promise<{ added: string[]; removed: string[]; updated: string[] }> },
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
