import type { ConfigFile } from "./config.ts";

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

export interface ApprovalState { paused: boolean; }

export interface SlashDeps {
  state: ApprovalState;
  setStatus: (value: "request" | "paused") => void;
  rulesBySource: () => { defaults: ConfigFile; global: ConfigFile; project: ConfigFile };
  writeTarget: () => string;
}

export function registerSlashCommands(slash: SlashRegistryLike, deps: SlashDeps): Array<() => void> {
  const offs: Array<() => void> = [];

  offs.push(slash.register(
    { name: "approval:pause", description: "Pause the tool-call approval gate for this session.", source: "plugin" },
    async (ctx) => {
      deps.state.paused = true;
      deps.setStatus("paused");
      await ctx.print("Approval gate paused for this session.");
    },
  ));

  offs.push(slash.register(
    { name: "approval:resume", description: "Resume the tool-call approval gate.", source: "plugin" },
    async (ctx) => {
      deps.state.paused = false;
      deps.setStatus("request");
      await ctx.print("Approval gate active.");
    },
  ));

  offs.push(slash.register(
    { name: "approval:status", description: "Show approval-gate pause state, per-source rule counts, effective rules, and the next write target.", source: "plugin" },
    async (ctx) => {
      const src = deps.rulesBySource();
      const counts = (cfg: ConfigFile) => `${cfg.allow.length} allow, ${cfg.deny.length} deny`;
      const allow = dedupe([...src.defaults.allow, ...src.global.allow, ...src.project.allow]);
      const deny = dedupe([...src.defaults.deny, ...src.global.deny, ...src.project.deny]);
      const lines = [
        `paused: ${deps.state.paused}`,
        `sources:`,
        `  defaults: ${counts(src.defaults)}`,
        `  global: ${counts(src.global)}`,
        `  project: ${counts(src.project)}`,
        `effective allow: ${allow.join(", ") || "(none)"}`,
        `effective deny: ${deny.join(", ") || "(none)"}`,
        `next write target: ${deps.writeTarget()}`,
      ];
      await ctx.print(lines.join("\n"));
    },
  ));

  return offs;
}

function dedupe(arr: string[]): string[] {
  return [...new Set(arr)].sort();
}
