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

function renderToolFilter(m: InternalAgentManifest): string {
  const tf = m.toolFilter;
  if (!tf || ((!tf.tags || tf.tags.length === 0) && (!tf.names || tf.names.length === 0))) {
    return "Tool filter: none (agent inherits parent's tool view, plus always-on dispatch_agent / load_skill).";
  }
  const parts = ["**Tool filter**:"];
  if (tf.tags && tf.tags.length > 0) parts.push(`- Tags: ${tf.tags.join(", ")}`);
  if (tf.names && tf.names.length > 0) parts.push(`- Names: ${tf.names.join(", ")}`);
  return parts.join("\n");
}

function renderShow(m: InternalAgentManifest): string {
  return [
    `**Agent**: ${m.name}`,
    `**Scope**: ${scopeTag(m)}`,
    `**Source**: ${m.sourcePath}`,
    "",
    `**Description**: ${m.description}`,
    "",
    renderToolFilter(m),
    "",
    "**System prompt**:",
    "```",
    m.systemPrompt,
    "```",
  ].join("\n");
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
    try {
      const name = cmdCtx.args.trim();
      if (name === "") {
        await cmdCtx.print("Usage: /agents:show <name>");
        return;
      }
      const internal = deps.registry.getInternal(name);
      if (!internal) {
        await cmdCtx.print(`Unknown agent: ${name}. Run /agents:list to see registered agents.`);
        return;
      }
      await cmdCtx.print(renderShow(internal));
    } catch (err) {
      await cmdCtx.print(`Error: ${(err as Error).message}`);
    }
  };

  return { listHandler, showHandler };
}
