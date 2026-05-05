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

export function buildAgentsBlock(agents: { name: string; description: string }[]): string {
  if (agents.length === 0) return "";
  const lines = agents.map((a) => {
    const oneLine = a.description.replace(/\s+/g, " ").trim();
    const trimmed = oneLine.length > 200 ? oneLine.slice(0, 197) + "..." : oneLine;
    return `- ${a.name}: ${trimmed}`;
  });
  return lines.join("\n");
}

export function makeInjector(deps: InjectorDeps): void {
  deps.ctx.on("turn:start", (p: { turnId: string; trigger: "user" | "agent"; parentTurnId?: string }) => {
    deps.tracker.onTurnStart(p);
  });
  deps.ctx.on("turn:end", (p: { turnId: string }) => {
    deps.tracker.onTurnEnd(p);
  });
}
