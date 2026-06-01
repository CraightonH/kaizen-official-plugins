import type {
  DriverService, AgentsRegistryService, ChatMessage,
} from "llm-contracts/public";
import type { AgentCallPayload } from "../rpc-types.ts";
import type { Semaphore } from "../semaphore.ts";
import type { Budget } from "../budget.ts";

export interface AgentCallbackDeps {
  runId: string;
  driver: DriverService;
  agentsRegistry: AgentsRegistryService | undefined;
  semaphore: Semaphore;
  budget: Budget;
  emit: (event: string, payload: unknown) => void;
  sessionIdProvider: () => string;
  agentIdCounter: { next: () => number };
  parentTurnId?: string;
  signal?: AbortSignal;
}

export function makeAgentCallback(deps: AgentCallbackDeps): (p: AgentCallPayload) => Promise<string | null> {
  return async (p: AgentCallPayload): Promise<string | null> => {
    deps.budget.assertNotExceeded();
    await deps.semaphore.acquire();
    const agentId = `a${deps.agentIdCounter.next()}`;
    const userMessage: ChatMessage = { role: "user", content: p.prompt };
    let systemPrompt = "";
    let toolFilter: { names?: string[]; tags?: string[] } | undefined = undefined;
    if (p.agentType) {
      const reg = deps.agentsRegistry;
      const manifest = reg?.list().find((m) => m.name === p.agentType);
      if (!manifest) {
        deps.semaphore.release();
        throw new Error(`unknown agentType '${p.agentType}'`);
      }
      systemPrompt = manifest.systemPrompt;
      toolFilter = manifest.toolFilter;
    }

    deps.emit("workflow:agent-start", {
      runId: deps.runId, agentId, label: p.label ?? p.agentType ?? "agent",
      phase: p.phase, model: p.model, prompt: p.prompt,
    });

    try {
      const out = await deps.driver.runConversation({
        systemPrompt,
        sessionId: deps.sessionIdProvider(),
        userMessage,
        toolFilter,
        model: p.model,
        parentTurnId: deps.parentTurnId,
        signal: deps.signal,
        trigger: "agent",
      });
      const tokens = out.usage?.completionTokens ?? 0;
      deps.budget.add(tokens);
      const finalText = typeof out.finalMessage.content === "string" ? out.finalMessage.content : "";
      deps.emit("workflow:agent-end", { runId: deps.runId, agentId, ok: true, tokensSpent: tokens });
      return finalText;
    } catch (err) {
      const e = err as Error;
      deps.emit("workflow:agent-end", {
        runId: deps.runId, agentId, ok: false, tokensSpent: 0,
        error: { name: e.name ?? "Error", message: e.message ?? String(err) },
      });
      throw err;
    } finally {
      deps.semaphore.release();
    }
  };
}
