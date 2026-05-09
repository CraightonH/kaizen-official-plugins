import type { CommandsApi } from "./commands.ts";
import type { ToolSchema } from "llm-events/public";

export interface ToolHandlerLike {
  (args: any, ctx: { signal: AbortSignal; callId: string; log: (m: string) => void }): Promise<unknown>;
}
export interface ToolsRegistryLike {
  register(schema: ToolSchema, handler: ToolHandlerLike): () => void;
}

export function registerToolCommands(tools: ToolsRegistryLike, cmds: CommandsApi): Array<() => void> {
  const offs: Array<() => void> = [];

  offs.push(tools.register(
    {
      name: "session:new",
      description:
        "Archive the current session and start a fresh one. Optionally seed the new session with a starter prompt — useful when context has grown bloated and you want to continue work in a clean session. With autostart=true (default), the new session immediately runs inference on the seeded prompt; with autostart=false, the prompt lands in the user input as a draft for the human to review. Returns ids of previous (from) and new (to) sessions and a seeded flag.",
      parameters: {
        type: "object",
        properties: {
          prompt:    { type: "string",  description: "Starter prompt for the new session. The new LLM sees this as its first user turn." },
          autostart: { type: "boolean", description: "If true (default), inference begins immediately in the new session. If false, the prompt is queued as a draft for the human to review." },
        },
        additionalProperties: false,
      } as any,
    },
    async (args: any) => {
      const opts: { prompt?: string; autostart?: boolean } = {};
      if (typeof args?.prompt === "string") opts.prompt = args.prompt;
      if (typeof args?.autostart === "boolean") opts.autostart = args.autostart;
      return cmds.clearSession(opts);
    },
  ));

  offs.push(tools.register(
    {
      name: "session:list",
      description: "List sessions for the current harness.",
      parameters: {
        type: "object",
        properties: { includeChildren: { type: "boolean", description: "Include child sessions (e.g. agent sessions). Defaults to false." } },
        additionalProperties: false,
      } as any,
    },
    async (args: any) => cmds.listSessions({ includeChildren: !!args?.includeChildren }),
  ));

  offs.push(tools.register(
    {
      name: "session:resume",
      description: "Switch the active session to one resolved by id or alias.",
      parameters: {
        type: "object",
        properties: { id_or_alias: { type: "string", description: "Session id (full path) or alias." } },
        required: ["id_or_alias"],
        additionalProperties: false,
      } as any,
    },
    async (args: any) => cmds.resumeSession({ id_or_alias: String(args?.id_or_alias ?? "") }),
  ));

  offs.push(tools.register(
    {
      name: "session:rename",
      description: "Rename the active session (alias only; id is unchanged).",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "New alias for the active session." } },
        required: ["name"],
        additionalProperties: false,
      } as any,
    },
    async (args: any) => cmds.renameActiveSession({ name: String(args?.name ?? "") }),
  ));

  offs.push(tools.register(
    {
      name: "session:delete",
      description: "Delete a session by id. If deleting the active session, a replacement is created and made active.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Session id to delete." },
          cascade: { type: "boolean", description: "Also delete child sessions. Required when deleting a session that has children. Defaults to false." },
        },
        required: ["id"],
        additionalProperties: false,
      } as any,
    },
    async (args: any) => cmds.deleteSession({ id: String(args?.id ?? ""), cascade: !!args?.cascade }),
  ));

  return offs;
}
