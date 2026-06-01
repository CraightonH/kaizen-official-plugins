import type { SlashCommandHandler, WorkflowRegistryService, WorkflowManifest } from "llm-contracts/public";

export interface SlashDeps {
  engine: WorkflowRegistryService;
}

export function makeSlashHandlers(deps: SlashDeps): {
  listHandler: SlashCommandHandler;
  getHandler: SlashCommandHandler;
  runHandler: SlashCommandHandler;
} {
  const listHandler: SlashCommandHandler = async (cmdCtx) => {
    const items = deps.engine.list();
    if (items.length === 0) {
      await cmdCtx.print("No workflows registered.");
      return;
    }
    const lines = [...items].sort((a, b) => a.meta.name.localeCompare(b.meta.name))
      .map((m) => `- **\`${m.meta.name}\`** [${m.scope ?? "user"}] — ${m.meta.description}`);
    await cmdCtx.print(lines.join("\n"));
  };

  const getHandler: SlashCommandHandler = async (cmdCtx) => {
    const name = cmdCtx.args.trim();
    if (!name) { await cmdCtx.print("Usage: /workflows:get <name>"); return; }
    const m = deps.engine.get(name);
    if (!m) { await cmdCtx.print(`Unknown workflow: ${name}. Run /workflows:list to see registered workflows.`); return; }
    await cmdCtx.print(renderManifest(m));
  };

  const runHandler: SlashCommandHandler = async (cmdCtx) => {
    const raw = cmdCtx.args.trim();
    if (!raw) { await cmdCtx.print("Usage: /workflows:run <name> [json-args]"); return; }
    const sp = raw.indexOf(" ");
    const name = sp === -1 ? raw : raw.substring(0, sp);
    const jsonPart = sp === -1 ? "" : raw.substring(sp + 1).trim();
    let parsedArgs: unknown = undefined;
    if (jsonPart) {
      try { parsedArgs = JSON.parse(jsonPart); }
      catch (e) { await cmdCtx.print(`invalid JSON args: ${(e as Error).message}`); return; }
    }
    const result = await deps.engine.runByName(name, { args: parsedArgs });
    if (!result.ok) {
      await cmdCtx.print(`workflow:run ${name} failed — ${result.error?.message ?? "unknown error"}`);
      return;
    }
    const valueStr = result.value != null ? String(result.value) : "(no output)";
    await cmdCtx.print(`workflow:run ${name} → ${valueStr}`);
  };

  return { listHandler, getHandler, runHandler };
}

function renderManifest(m: WorkflowManifest): string {
  return [
    `**Workflow**: ${m.meta.name}`,
    `**Scope**: ${m.scope ?? "user"}`,
    `**Source**: ${m.sourcePath ?? "<inline>"}`,
    "",
    `**Description**: ${m.meta.description}`,
    "",
    "**Source:**",
    "```typescript",
    m.source,
    "```",
  ].join("\n");
}
