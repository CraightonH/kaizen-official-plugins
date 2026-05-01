import type { JSONSchema7 } from "json-schema";
import type { McpClientLike } from "./client.ts";
import { kaizenToolName, kaizenToolTags } from "./names.ts";

export interface KaizenToolReg {
  schema: { name: string; description: string; parameters: JSONSchema7; tags?: string[] };
  handler: (args: unknown, ctx: { signal: AbortSignal; callId: string; log: (msg: string) => void }) => Promise<unknown>;
}

interface McpToolMeta {
  name: string;
  description?: string;
  inputSchema?: object;
}

function asJsonSchema(s: object | undefined): JSONSchema7 {
  if (!s || typeof s !== "object") return { type: "object", properties: {} };
  return s as JSONSchema7;
}

function flattenContent(result: unknown): unknown {
  if (typeof result !== "object" || result === null) return result;
  const r = result as { content?: unknown };
  if (!Array.isArray(r.content)) return result;
  const blocks = r.content as Array<Record<string, unknown>>;
  const allText = blocks.length > 0 && blocks.every((b) => b?.type === "text" && typeof b.text === "string");
  if (allText) return (blocks as Array<{ text: string }>).map((b) => b.text).join("\n");
  // Non-text content: return the structured array verbatim for the LLM/dispatcher to handle.
  return blocks;
}

export function toToolRegistration(
  server: string,
  mcpTool: McpToolMeta,
  getClient: () => McpClientLike | undefined,
  timeoutMs: number,
): KaizenToolReg {
  const fqName = kaizenToolName(server, mcpTool.name);
  const schema = {
    name: fqName,
    description: mcpTool.description ?? "",
    parameters: asJsonSchema(mcpTool.inputSchema),
    tags: kaizenToolTags(server),
  };

  const handler: KaizenToolReg["handler"] = async (args, ctx) => {
    const client = getClient();
    if (!client) {
      const err = new Error(`mcp_server_unavailable: ${server}`);
      throw err;
    }
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    if (ctx.signal.aborted) ac.abort();
    else ctx.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => ac.abort(new Error(`mcp:${server}:${mcpTool.name} timed out after ${timeoutMs}ms`)), timeoutMs);
    try {
      const racePromise = client.callTool({ name: mcpTool.name, arguments: args });
      const abortPromise = new Promise<never>((_, reject) => {
        ac.signal.addEventListener("abort", () => {
          const reason = (ac.signal as any).reason;
          if (reason instanceof Error) reject(reason);
          else if (ctx.signal.aborted) reject(new Error(`mcp:${server}:${mcpTool.name} aborted`));
          else reject(new Error(`mcp:${server}:${mcpTool.name} aborted`));
        }, { once: true });
      });
      const result = await Promise.race([racePromise, abortPromise]);
      return flattenContent(result);
    } catch (err: any) {
      // Re-throw timeout/abort verbatim
      if (typeof err?.message === "string" && (err.message.includes("timed out") || err.message.includes("aborted") || err.message.startsWith("mcp_server_unavailable"))) {
        throw err;
      }
      throw new Error(`mcp:${server}:${mcpTool.name} failed: ${err?.message ?? String(err)}`);
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
    }
  };

  return { schema, handler };
}

export function makeReadMcpResourceTool(getClient: (server: string) => McpClientLike | undefined): KaizenToolReg {
  return {
    schema: {
      name: "read_mcp_resource",
      description: "Read an MCP resource by URI. Use list_mcp_resources to discover URIs.",
      parameters: {
        type: "object",
        properties: {
          server: { type: "string", description: "The configured MCP server name." },
          uri: { type: "string", description: "The MCP resource URI to read." },
        },
        required: ["server", "uri"],
      },
    },
    handler: async (args, _ctx) => {
      const a = (args ?? {}) as { server?: unknown; uri?: unknown };
      if (typeof a.server !== "string") throw new Error("read_mcp_resource: 'server' (string) is required");
      if (typeof a.uri !== "string") throw new Error("read_mcp_resource: 'uri' (string) is required");
      const c = getClient(a.server);
      if (!c) throw new Error(`unknown MCP server: ${a.server}`);
      return await c.readResource({ uri: a.uri });
    },
  };
}

export interface NamedClient { name: string; client: McpClientLike }

export function makeListMcpResourcesTool(getHealthy: () => NamedClient[]): KaizenToolReg {
  return {
    schema: {
      name: "list_mcp_resources",
      description: "List MCP resources across configured servers (or one if `server` is given).",
      parameters: {
        type: "object",
        properties: {
          server: { type: "string", description: "Optional server name to restrict the listing to." },
        },
      },
    },
    handler: async (args, _ctx) => {
      const a = (args ?? {}) as { server?: unknown };
      const servers = getHealthy();
      const targets = typeof a.server === "string"
        ? servers.filter((s) => s.name === a.server)
        : servers;
      const out: Array<Record<string, unknown>> = [];
      for (const { name, client } of targets) {
        try {
          const r = await client.listResources();
          for (const res of r.resources ?? []) out.push({ ...res, server: name });
        } catch (err) {
          // skip failing server, continue aggregation
        }
      }
      return out;
    },
  };
}
