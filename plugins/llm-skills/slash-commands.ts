import type {
  SkillManifest,
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
    await ctx.print(formatList(deps.registry.list()), { markdown: true });
  };
  offs.push(slash.register(listManifest, listHandler));

  const getManifest: SlashCommandManifest = {
    name: "skills:get",
    description: "Show a skill's source path, token count, and body",
    source: "plugin",
    usage: "<name>",
  };
  const getHandler: SlashCommandHandler = async (ctx) => {
    await handleGet(ctx, deps);
  };
  offs.push(slash.register(getManifest, getHandler));

  return () => {
    for (const off of offs) {
      try { off(); } catch { /* idempotent */ }
    }
  };
}

async function handleGet(
  ctx: import("llm-contracts/public").SlashCommandContext,
  deps: RegisterSlashCommandsDeps,
): Promise<void> {
  const name = ctx.args.trim();
  if (!name) {
    await ctx.print("Usage: /skills:get <name>\nRun /skills:list to see what's available.");
    return;
  }
  // Remaining branches added in subsequent tasks.
  await ctx.print(`(stub: would look up ${name})`);
}

function formatList(entries: SkillManifest[]): string {
  if (entries.length === 0) return "No skills registered.";
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  return sorted.map((e) => `\`${e.name}\` — ${e.description}`).join("\n");
}
