import type { SlashCommandHandler } from "llm-contracts/public";
import type { InternalAgentManifest } from "./frontmatter.ts";

export interface SlashHandlerDeps {
  registry: {
    service: { list(): Array<Pick<InternalAgentManifest, "name" | "description" | "systemPrompt" | "toolFilter">> };
    getInternal(name: string): InternalAgentManifest | undefined;
  };
}

function scopeTag(m: InternalAgentManifest): "user" | "project" | "runtime" {
  if (m.sourcePath === "<runtime>") return "runtime";
  return m.scope;
}

export function makeSlashHandlers(deps: SlashHandlerDeps): {
  listHandler: SlashCommandHandler;
  showHandler: SlashCommandHandler;
} {
  const listHandler: SlashCommandHandler = async (cmdCtx) => {
    try {
      const items = deps.registry.service.list();
      if (items.length === 0) {
        await cmdCtx.print("No agents registered.");
        return;
      }
      const lines: string[] = [];
      for (const pub of [...items].sort((a, b) => a.name.localeCompare(b.name))) {
        const internal = deps.registry.getInternal(pub.name);
        if (!internal) continue;
        lines.push(`- **\`${pub.name}\`** [${scopeTag(internal)}] — ${pub.description}`);
      }
      await cmdCtx.print(lines.join("\n"));
    } catch (err) {
      await cmdCtx.print(`Error: ${(err as Error).message}`);
    }
  };

  const showHandler: SlashCommandHandler = async (cmdCtx) => {
    // Implemented in Task 2.
    await cmdCtx.print("Usage: /agents:show <name>");
  };

  return { listHandler, showHandler };
}
