import type { CommandsApi } from "./commands.ts";
import type { SessionRecord } from "llm-contracts/public";

export interface SlashCommandManifestLike {
  name: string;
  description: string;
  source: "builtin" | "plugin";
  usage?: string;
}
export interface SlashCommandContextLike {
  args: string;
  print: (text: string) => Promise<void>;
}
export interface SlashRegistryLike {
  register(manifest: SlashCommandManifestLike, handler: (ctx: SlashCommandContextLike) => Promise<void>): () => void;
}

function sessionLine(record: SessionRecord): string {
  const label = record.alias ? ` (${record.alias})` : "";
  const agent = record.agentName ? ` agent=${record.agentName}` : "";
  const marker = record.parentSessionId ? "  " : "";
  return `${marker}${record.id}${label}${agent}`;
}

export function registerSlashCommands(slash: SlashRegistryLike, cmds: CommandsApi): Array<() => void> {
  const offs: Array<() => void> = [];

  const newSessionHandler = async (ctx: SlashCommandContextLike) => {
    const raw = ctx.args.trim();
    const opts: { prompt?: string; autostart?: boolean } = {};
    if (raw) {
      let text = raw;
      if (text.startsWith("--draft")) {
        opts.autostart = false;
        text = text.slice("--draft".length).trim();
      } else {
        opts.autostart = true;
      }
      if (!text) {
        await ctx.print("Usage: /session:new [--draft] <prompt-text>");
        return;
      }
      opts.prompt = text;
    }
    const r = await cmds.clearSession(opts);
    if (r.seeded) {
      await ctx.print(`Active session: ${r.to} (seeded${opts.autostart === false ? "; draft" : ""})`);
    } else {
      await ctx.print(`Active session: ${r.to}`);
    }
  };

  offs.push(slash.register(
    { name: "clear", description: "Archive current session and start a fresh one", source: "builtin", usage: "[--draft] [prompt]" },
    newSessionHandler,
  ));
  offs.push(slash.register(
    { name: "session:new", description: "Create and switch to a new top-level session, optionally seeded with a starter prompt", source: "plugin", usage: "[--draft] [prompt]" },
    newSessionHandler,
  ));

  offs.push(slash.register(
    { name: "session:list", description: "List sessions", source: "plugin", usage: "[--all]" },
    async (ctx) => {
      const includeChildren = ctx.args.split(/\s+/).filter(Boolean).includes("--all");
      const rows = await cmds.listSessions({ includeChildren });
      await ctx.print(rows.length ? rows.map(sessionLine).join("\n") : "No sessions.");
    },
  ));

  offs.push(slash.register(
    { name: "session:resume", description: "Resume a session by id or alias", source: "plugin", usage: "<id|alias>" },
    async (ctx) => {
      const r = await cmds.resumeSession({ id_or_alias: ctx.args.trim() });
      await ctx.print(`Active session: ${r.id}`);
    },
  ));

  offs.push(slash.register(
    { name: "session:rename", description: "Rename the active session (alias only; id is unchanged)", source: "plugin", usage: "<new-name>" },
    async (ctx) => {
      const name = ctx.args.trim();
      if (!name) {
        await ctx.print("Usage: /session:rename <new-name>");
        return;
      }
      try {
        const r = await cmds.renameActiveSession({ name });
        await ctx.print(`Renamed session ${r.id} → ${r.alias}`);
      } catch (e: any) {
        await ctx.print(`Rename failed: ${e?.message ?? String(e)}`);
      }
    },
  ));

  offs.push(slash.register(
    { name: "session:delete", description: "Delete a session", source: "plugin", usage: "<id> [--cascade]" },
    async (ctx) => {
      const parts = ctx.args.split(/\s+/).filter(Boolean);
      const cascade = parts.includes("--cascade");
      const id = parts.find((p) => p !== "--cascade");
      if (!id) throw new Error("missing session id");
      const r = await cmds.deleteSession({ id, cascade });
      if (r.replacement) {
        await ctx.print(`Active session: ${r.replacement}`);
      } else {
        await ctx.print(`Deleted session: ${r.deleted}`);
      }
    },
  ));

  return offs;
}
