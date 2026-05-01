import type {
  ToolSchema,
  ToolHandler,
  ToolExecutionContext,
  RunConversationInput,
  RunConversationOutput,
  DriverService,
} from "llm-events/public";
import type { RegistryHandle } from "./registry.ts";
import type { TurnTracker } from "./turn-tracker.ts";
import { computeDepth } from "./depth.ts";

export interface DispatchDeps {
  registry: RegistryHandle;
  tracker: TurnTracker;
  driver: Pick<DriverService, "runConversation">;
  maxDepth: number;
  hasSkills: () => boolean;
}

export const DISPATCH_SCHEMA: ToolSchema = {
  name: "dispatch_agent",
  description:
    "Delegate a sub-task to a named specialist agent. Returns the agent's final response as a string. " +
    "Use when a sub-task benefits from a focused persona or restricted tool set.",
  parameters: {
    type: "object",
    required: ["agent_name", "prompt"],
    properties: {
      agent_name: { type: "string", description: "One of the names listed under 'Available agents' in the system prompt." },
      prompt: { type: "string", description: "The instruction to send to the agent as its only user message." },
    },
    additionalProperties: false,
  } as any,
  tags: ["agents", "core"],
};

export function makeDispatchTool(deps: DispatchDeps): { schema: ToolSchema; handler: ToolHandler } {
  const handler: ToolHandler = async (rawArgs: unknown, ctx: ToolExecutionContext) => {
    const args = rawArgs as { agent_name?: unknown; prompt?: unknown };
    if (typeof args?.agent_name !== "string" || typeof args?.prompt !== "string") {
      throw new Error("dispatch_agent: 'agent_name' and 'prompt' must be strings");
    }
    const name = args.agent_name;
    const internal = deps.registry.getInternal(name);
    if (!internal) {
      const known = deps.registry.service.list().map((a) => a.name).join(", ");
      throw new Error(`Unknown agent '${name}'. Known: ${known}`);
    }

    const turnId = ctx.turnId;
    if (!turnId) {
      throw new Error("dispatch_agent: ToolExecutionContext.turnId missing; required for depth tracking");
    }
    const depth = computeDepth(deps.tracker.records, turnId);
    if (depth >= deps.maxDepth) {
      throw new Error(`Agent dispatch depth limit reached (max=${deps.maxDepth})`);
    }

    // Build merged tool filter: manifest names + always-on (dispatch_agent, optionally load_skill); manifest tags pass through.
    const manifestNames = internal.toolFilter?.names ?? [];
    const manifestTags = internal.toolFilter?.tags ?? [];
    const alwaysOn: string[] = ["dispatch_agent"];
    if (deps.hasSkills()) alwaysOn.push("load_skill");
    const mergedNames = Array.from(new Set([...manifestNames, ...alwaysOn]));
    const toolFilter = { names: mergedNames, tags: manifestTags };

    const input: RunConversationInput = {
      systemPrompt: internal.systemPrompt,
      messages: [{ role: "user", content: args.prompt }],
      toolFilter,
      ...(internal.modelOverride ? { model: internal.modelOverride } : {}),
      parentTurnId: turnId,
      signal: ctx.signal,
    };

    // Status telemetry: track active agent dispatches.
    const emit = (ctx as any).emit as ((e: string, p: unknown) => Promise<void>) | undefined;
    try {
      await emit?.("status:item-update", { key: "agents.active", value: name });
      let output: RunConversationOutput;
      try {
        output = await deps.driver.runConversation(input);
      } catch (err: any) {
        if (err?.name === "AbortError" || ctx.signal.aborted) {
          throw new Error(`Agent '${name}' cancelled`);
        }
        const inner = err?.message ?? String(err);
        throw new Error(`Agent '${name}' failed: ${inner}`);
      }
      return String(output.finalMessage.content ?? "");
    } finally {
      await emit?.("status:item-clear", { key: "agents.active" });
    }
  };

  return { schema: DISPATCH_SCHEMA, handler };
}
