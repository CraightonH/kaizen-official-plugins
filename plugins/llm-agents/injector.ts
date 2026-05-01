import type { LLMRequest } from "llm-events/public";
import type { RegistryHandle } from "./registry.ts";
import type { TurnTracker } from "./turn-tracker.ts";

export interface InjectorDeps {
  ctx: {
    on: (event: string, fn: (p: any) => any) => void;
    log?: (msg: string) => void;
  };
  registry: RegistryHandle;
  tracker: TurnTracker;
}

const SECTION_HEADING = "## Available agents (use dispatch_agent to invoke)";

function formatSection(agents: { name: string; description: string }[]): string {
  if (agents.length === 0) return "";
  const lines = agents.map((a) => {
    const oneLine = a.description.replace(/\s+/g, " ").trim();
    const trimmed = oneLine.length > 200 ? oneLine.slice(0, 197) + "..." : oneLine;
    return `- ${a.name}: ${trimmed}`;
  });
  return `\n\n${SECTION_HEADING}\n\n${lines.join("\n")}\n`;
}

export function makeInjector(deps: InjectorDeps): void {
  const injected = new Set<string>();
  const log = deps.ctx.log ?? (() => {});

  deps.ctx.on("turn:start", (p: { turnId: string; trigger: "user" | "agent"; parentTurnId?: string }) => {
    deps.tracker.onTurnStart(p);
  });
  deps.ctx.on("turn:end", (p: { turnId: string }) => {
    injected.delete(p.turnId);
    deps.tracker.onTurnEnd(p);
  });
  deps.ctx.on("llm:before-call", (p: { request: LLMRequest; turnId?: string }) => {
    const turnId = p.turnId;
    if (!turnId) { log("llm-agents: llm:before-call without turnId; skipping injection"); return; }
    if (!deps.tracker.isTopLevel(turnId)) return;
    if (injected.has(turnId)) return;
    const agents = deps.registry.service.list();
    if (agents.length === 0) return;
    const section = formatSection(agents);
    p.request.systemPrompt = (p.request.systemPrompt ?? "") + section;
    injected.add(turnId);
  });
}
