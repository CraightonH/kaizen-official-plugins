import type { ToolSchema } from "llm-contracts/public";
import type { StatusSnapshot } from "./snapshot.ts";

export interface ToolHandlerLike {
  (args: any, ctx: { signal: AbortSignal; callId: string; log: (m: string) => void }): Promise<unknown>;
}
export interface ToolsRegistryLike {
  register(schema: ToolSchema, handler: ToolHandlerLike): () => void;
}

export function registerStatusTool(
  tools: ToolsRegistryLike,
  getSnapshot: () => StatusSnapshot,
): Array<() => void> {
  const off = tools.register(
    {
      name: "status:show",
      description:
        "Return current status-bar values: model, context-window usage (lastPromptTokens / contextLength / pctUsed), cumulative session token totals, last-turn tokens/sec, and cost estimate. All numbers are reported by the provider — no estimation. Useful for deciding whether to clear context.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      } as any,
    },
    async () => getSnapshot(),
  );
  return [off];
}
