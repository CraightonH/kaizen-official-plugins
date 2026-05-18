import type { ConfigStoreService } from "llm-contracts/public";

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

export interface ToolApprovalRuleSet {
  allow: string[];
  deny: string[];
}

export interface SlashDeps {
  state: ApprovalState;
  setStatus: (value: "request" | "paused") => void;
  cfgSvc: Pick<ConfigStoreService, "get" | "list">;
}

const PLUGIN = "llm-tool-approval";

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
    { name: "approval:status", description: "Show approval-gate pause state, effective rules, resolution per field, and the write target.", source: "plugin" },
    async (ctx) => {
      const effective = deps.cfgSvc.get<ToolApprovalRuleSet>(PLUGIN);
      const allow = Array.isArray(effective?.allow) ? effective.allow : [];
      const deny = Array.isArray(effective?.deny) ? effective.deny : [];

      const status = deps.cfgSvc.list().find((s) => s.plugin === PLUGIN);
      const allowSrc = status?.resolution?.allow ?? "default";
      const denySrc = status?.resolution?.deny ?? "default";
      const writeTarget = status?.projectPath ?? "(project config path unknown)";

      const lines = [
        `paused: ${deps.state.paused}`,
        `sources:`,
        `  home: ${status?.homeExists ? status.homePath : "(none)"}`,
        `  project: ${status?.projectExists ? status.projectPath : "(none)"}`,
        `resolution:`,
        `  allow: ${allowSrc}`,
        `  deny: ${denySrc}`,
        `effective allow (${allow.length}): ${allow.join(", ") || "(none)"}`,
        `effective deny (${deny.length}): ${deny.join(", ") || "(none)"}`,
        `next write target: ${writeTarget}`,
      ];
      await ctx.print(lines.join("\n"));
    },
  ));

  return offs;
}
