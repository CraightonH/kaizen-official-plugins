import type { ToolSchema } from "llm-contracts/public";
import type { ToolHandler } from "llm-contracts/public";
import type { SystemPromptServiceImpl } from "./registry.ts";

export interface PromptToolOptions {
  registry: SystemPromptServiceImpl;
  reloadIdentity: () => Promise<void>;
}

export interface PromptToolEntry {
  schema: ToolSchema;
  handler: ToolHandler;
}

export function makePromptToolHandlers(opts: PromptToolOptions): {
  show: PromptToolEntry;
  reload: PromptToolEntry;
  disable: PromptToolEntry;
  enable: PromptToolEntry;
} {
  const { registry, reloadIdentity } = opts;

  const showSchema: ToolSchema = {
    name: "prompt_show",
    description:
      "Show the current assembled system prompt. Diagnostic — call only when explicitly asked to inspect the prompt.",
    parameters: {
      type: "object",
      properties: {
        stats: {
          type: "boolean",
          description: "Include per-section character counts and the generation counter.",
        },
      },
      additionalProperties: false,
    },
    tags: ["prompt", "diagnostic", "synthetic"],
  };

  const reloadSchema: ToolSchema = {
    name: "prompt_reload",
    description:
      "Re-read identity files from disk and bump the prompt generation. Has filesystem side effects — do not call speculatively.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    tags: ["prompt", "diagnostic", "synthetic"],
  };

  const disableSchema: ToolSchema = {
    name: "prompt_disable",
    description:
      "Disable a system-prompt section by id. Diagnostic — disabling sections (e.g. 'identity', 'llm-skills:available') changes the agent's own context. Use only when explicitly asked.",
    parameters: {
      type: "object",
      properties: {
        sectionId: {
          type: "string",
          description: "ID of the section to disable.",
        },
      },
      required: ["sectionId"],
      additionalProperties: false,
    },
    tags: ["prompt", "diagnostic", "synthetic"],
  };

  const enableSchema: ToolSchema = {
    name: "prompt_enable",
    description:
      "Re-enable a previously-disabled system-prompt section by id.",
    parameters: {
      type: "object",
      properties: {
        sectionId: {
          type: "string",
          description: "ID of the section to enable.",
        },
      },
      required: ["sectionId"],
      additionalProperties: false,
    },
    tags: ["prompt", "diagnostic", "synthetic"],
  };

  async function show(args: unknown): Promise<unknown> {
    if (typeof args !== "object" || args === null) {
      throw new Error("prompt_show: args must be an object");
    }
    const stats = (args as { stats?: unknown }).stats === true;
    const sections = registry.list().slice().sort((a, b) => a.priority - b.priority);

    const result: Array<{
      id: string;
      priority: number;
      title?: string;
      body: string | null;
      chars?: number;
    }> = [];

    for (const s of sections) {
      const body = await registry.renderSection(s.id);
      const entry: {
        id: string;
        priority: number;
        title?: string;
        body: string | null;
        chars?: number;
      } = { id: s.id, priority: s.priority, body: body ?? null };
      if (s.title !== undefined) {
        entry.title = s.title;
      }
      if (stats && body !== null) {
        entry.chars = body.length;
      }
      result.push(entry);
    }

    return {
      generation: registry.generation(),
      sections: result,
    };
  }

  async function reload(_args: unknown): Promise<unknown> {
    await reloadIdentity();
    return { ok: true, message: "identity reloaded" };
  }

  async function disable(args: unknown): Promise<unknown> {
    if (typeof args !== "object" || args === null) {
      throw new Error("prompt_disable: args must be an object with a 'sectionId' string");
    }
    const sectionId = (args as { sectionId?: unknown }).sectionId;
    if (typeof sectionId !== "string" || sectionId.length === 0) {
      throw new Error("prompt_disable: 'sectionId' is required and must be a non-empty string");
    }
    if (!registry.has(sectionId)) {
      throw new Error(`no section with id "${sectionId}"`);
    }
    registry.disable(sectionId);
    return { ok: true, sectionId, action: "disabled" };
  }

  async function enable(args: unknown): Promise<unknown> {
    if (typeof args !== "object" || args === null) {
      throw new Error("prompt_enable: args must be an object with a 'sectionId' string");
    }
    const sectionId = (args as { sectionId?: unknown }).sectionId;
    if (typeof sectionId !== "string" || sectionId.length === 0) {
      throw new Error("prompt_enable: 'sectionId' is required and must be a non-empty string");
    }
    if (!registry.has(sectionId)) {
      throw new Error(`no section with id "${sectionId}"`);
    }
    registry.enable(sectionId);
    return { ok: true, sectionId, action: "enabled" };
  }

  return {
    show: { schema: showSchema, handler: show },
    reload: { schema: reloadSchema, handler: reload },
    disable: { schema: disableSchema, handler: disable },
    enable: { schema: enableSchema, handler: enable },
  };
}
