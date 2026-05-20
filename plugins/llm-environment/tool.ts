import type { ToolSchema, ToolHandler } from "llm-contracts/public";

export interface EnvToolOptions {
  refresh: () => Promise<void>;
}

export interface EnvToolEntry {
  schema: ToolSchema;
  handler: ToolHandler;
}

export const ENVIRONMENT_REFRESH_SCHEMA = {
  name: "environment_refresh",
  description:
    "Re-capture the working-directory / platform / git snapshot used in the system prompt. Has filesystem side effects — call only when explicitly asked, or after the user has cd'd or switched branches.",
  parameters: {
    type: "object" as const,
    properties: {},
    additionalProperties: false,
  },
  tags: ["environment", "diagnostic", "synthetic"],
} satisfies ToolSchema;

export function makeEnvToolHandlers(opts: EnvToolOptions): { refresh: EnvToolEntry } {
  return {
    refresh: {
      schema: ENVIRONMENT_REFRESH_SCHEMA,
      handler: async () => {
        await opts.refresh();
        return { ok: true, message: "environment refreshed" };
      },
    },
  };
}
