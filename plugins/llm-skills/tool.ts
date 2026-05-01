import type { ToolSchema } from "llm-events/public";
import type { SkillsRegistryService } from "llm-events/public";
import { estimateTokens } from "./tokens.ts";

export const LOAD_SKILL_SCHEMA: ToolSchema = {
  name: "load_skill",
  description: "Load the full body of a named skill into context. Use this only when the skill is clearly relevant — it consumes context tokens.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Skill name as listed in the Available skills section." },
    },
    required: ["name"],
    additionalProperties: false,
  },
  tags: ["skills", "synthetic"],
};

export type ToolHandlerFn = (args: unknown, ctx: { signal: AbortSignal; callId: string; turnId?: string; log: (m: string) => void }) => Promise<unknown>;

export function makeLoadSkillHandler(
  registry: SkillsRegistryService,
  emit: (event: string, payload: unknown) => Promise<void>,
): ToolHandlerFn {
  return async (args) => {
    if (typeof args !== "object" || args === null) {
      throw new Error("load_skill: args must be an object with a 'name' string");
    }
    const name = (args as { name?: unknown }).name;
    if (typeof name !== "string" || name.length === 0) {
      throw new Error("load_skill: 'name' is required and must be a non-empty string");
    }
    const body = await registry.load(name);
    const fromList = registry.list().find(m => m.name === name);
    const tokens = typeof fromList?.tokens === "number" ? fromList.tokens : estimateTokens(body);
    await emit("skill:loaded", { name, tokens });
    return { name, tokens, body };
  };
}
