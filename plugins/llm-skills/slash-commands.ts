import type {
  SkillsRegistryService,
  SlashCommandHandler,
  SlashCommandManifest,
  SlashRegistryService,
} from "llm-contracts/public";

export interface RegisterSlashCommandsDeps {
  registry: SkillsRegistryService;
  slash: SlashRegistryService;
  projectRoot: string;
  userRoot: string;
}

export function registerSlashCommands(deps: RegisterSlashCommandsDeps): () => void {
  const { slash } = deps;
  const offs: Array<() => void> = [];

  const listManifest: SlashCommandManifest = {
    name: "skills:list",
    description: "List all registered skills",
    source: "plugin",
  };
  const listHandler: SlashCommandHandler = async (ctx) => {
    await ctx.print("(not implemented)");
  };
  offs.push(slash.register(listManifest, listHandler));

  const getManifest: SlashCommandManifest = {
    name: "skills:get",
    description: "Show a skill's source path, token count, and body",
    source: "plugin",
    usage: "<name>",
  };
  const getHandler: SlashCommandHandler = async (ctx) => {
    await ctx.print("(not implemented)");
  };
  offs.push(slash.register(getManifest, getHandler));

  return () => {
    for (const off of offs) {
      try { off(); } catch { /* idempotent */ }
    }
  };
}
