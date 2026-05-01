import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ResolvedServerConfig } from "./config.ts";

// Lazy import zod from the SDK's own dependency to register notification handlers.
// Wrapped in a function to avoid top-level errors if zod resolution fails at runtime.
async function getZodLiteral(value: string): Promise<unknown | null> {
  try {
    const { z } = await import("zod");
    return z.object({ method: z.literal(value) }).passthrough();
  } catch {
    return null;
  }
}

/**
 * The minimal client surface the bridge depends on.
 * Implemented by both the real SDK Client wrapper and our test mocks.
 */
export interface McpClientLike {
  connect(): Promise<void>;
  initialize?(): Promise<{ capabilities: object }>;
  getServerCapabilities(): { tools?: object; resources?: object; prompts?: object } | undefined;
  listTools(): Promise<{ tools: Array<{ name: string; description?: string; inputSchema?: object }> }>;
  listResources(): Promise<{ resources: Array<{ uri: string; name?: string; mimeType?: string }> }>;
  callTool(req: { name: string; arguments: unknown }): Promise<unknown>;
  readResource(req: { uri: string }): Promise<unknown>;
  ping(): Promise<void>;
  close(): Promise<void>;
  onclose?: (() => void) | undefined;
  // Subscribe to MCP `notifications/tools/list_changed`
  setNotificationHandler?(method: string, handler: (notif: unknown) => void): void;
}

export interface CreateClientResult {
  client: McpClientLike;
  /** Process pid for stdio transport, undefined otherwise. Used by health checks. */
  pid?: number;
}

export interface CreateClientDeps {
  log: (msg: string) => void;
  version: string;
}

export function createClient(cfg: ResolvedServerConfig, deps: CreateClientDeps): CreateClientResult {
  let transport: StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport;
  let pid: number | undefined;

  if (cfg.transport === "stdio") {
    if (!cfg.command) throw new Error(`server "${cfg.name}": stdio transport missing command`);
    transport = new StdioClientTransport({
      command: cfg.command,
      args: cfg.args ?? [],
      env: cfg.env,
      cwd: cfg.cwd,
      stderr: "pipe",
    });
  } else if (cfg.transport === "sse") {
    if (!cfg.url) throw new Error(`server "${cfg.name}": sse transport missing url`);
    transport = new SSEClientTransport(new URL(cfg.url), {
      eventSourceInit: { headers: cfg.headers ?? {} } as any,
      requestInit: { headers: cfg.headers ?? {} },
    });
  } else {
    if (!cfg.url) throw new Error(`server "${cfg.name}": http transport missing url`);
    transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
      requestInit: { headers: cfg.headers ?? {} },
    });
  }

  const sdkClient = new Client(
    { name: "kaizen-mcp-bridge", version: deps.version },
    { capabilities: {} },
  );

  // Wire onclose from transport to adapted surface
  let oncloseCb: (() => void) | undefined;

  const adapted: McpClientLike = {
    connect: async () => {
      await sdkClient.connect(transport);
      // After connect, wire up stderr for stdio transports
      if (cfg.transport === "stdio") {
        const stdioTransport = transport as StdioClientTransport;
        const stderrStream = stdioTransport.stderr;
        if (stderrStream) {
          stderrStream.on("data", (chunk: Buffer) =>
            deps.log(`[mcp:${cfg.name}] ${chunk.toString().trimEnd()}`)
          );
        }
        // Capture pid via private access (best-effort)
        pid = (stdioTransport as any)._process?.pid;
      }
    },
    getServerCapabilities: () => {
      const caps = sdkClient.getServerCapabilities();
      return caps ?? {};
    },
    listTools: () => sdkClient.listTools() as Promise<any>,
    listResources: () => sdkClient.listResources() as Promise<any>,
    callTool: (req) => sdkClient.callTool(req as any) as Promise<unknown>,
    readResource: (req) => sdkClient.readResource(req as any) as Promise<unknown>,
    ping: () => sdkClient.ping().then(() => undefined),
    close: () => sdkClient.close(),
    setNotificationHandler: (method, handler) => {
      // The SDK's setNotificationHandler takes a Zod schema. Resolve lazily.
      getZodLiteral(method).then((schema) => {
        if (schema) {
          try {
            sdkClient.setNotificationHandler(schema as any, handler as any);
          } catch {
            // API shape mismatch — skip silently.
            // Periodic health check will catch stale tool lists.
          }
        }
      }).catch(() => { /* ignore */ });
    },
    get onclose() { return oncloseCb; },
    set onclose(cb: (() => void) | undefined) {
      oncloseCb = cb;
      transport.onclose = cb;
    },
  };

  return { client: adapted, pid };
}
