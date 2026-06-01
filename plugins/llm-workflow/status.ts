import type { WorkflowManifest } from "llm-contracts/public";

export interface StatusDeps {
  on: (name: string, fn: (p: unknown) => void) => void;
  emit: (name: string, payload: unknown) => void;
}

interface State {
  name: string | null;
  phase: string | null;
  agentDone: number;
  agentTotal: number;
}

export function wireStatusItem(deps: StatusDeps): void {
  const state: State = { name: null, phase: null, agentDone: 0, agentTotal: 0 };

  function flush() {
    if (!state.name) return;
    const phaseStr = state.phase ? `${state.phase}: ${state.agentDone}/${state.agentTotal}` : `${state.agentDone}/${state.agentTotal}`;
    deps.emit("status:item-update", { key: "workflow.active", value: `${state.name} [${phaseStr}]` });
  }

  deps.on("workflow:start", (p) => {
    const { name } = p as { name: string };
    state.name = name; state.phase = null; state.agentDone = 0; state.agentTotal = 0;
    flush();
  });
  deps.on("workflow:phase", (p) => {
    const { phase } = p as { phase: string };
    state.phase = phase;
    flush();
  });
  deps.on("workflow:agent-start", () => {
    state.agentTotal++;
    flush();
  });
  deps.on("workflow:agent-end", () => {
    state.agentDone++;
    flush();
  });
  deps.on("workflow:end", () => {
    state.name = null;
    deps.emit("status:item-clear", { key: "workflow.active" });
  });
}

export function buildWorkflowsBlock(manifests: WorkflowManifest[]): string {
  const visible = manifests.filter((m) => !m.meta.name.startsWith("runtime:"));
  if (visible.length === 0) return "";
  const lines = visible
    .sort((a, b) => a.meta.name.localeCompare(b.meta.name))
    .map((m) => {
      const desc = m.meta.description.length > 200 ? m.meta.description.slice(0, 197) + "..." : m.meta.description;
      return `- \`${m.meta.name}\` — ${desc}`;
    });
  return lines.join("\n");
}
