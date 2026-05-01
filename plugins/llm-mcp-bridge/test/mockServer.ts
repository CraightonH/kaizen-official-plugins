import type { McpClientLike } from "../client.ts";

export interface MockTool {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties?: Record<string, unknown>; required?: string[] };
}

export interface MockResource { uri: string; name?: string; mimeType?: string }

export interface MockBehavior {
  capabilities?: { tools?: object; resources?: object; prompts?: object };
  tools?: MockTool[];
  resources?: MockResource[];
  // mcpToolName -> result (object) or thrown Error
  toolHandler?: (name: string, args: unknown) => Promise<unknown>;
  resourceHandler?: (uri: string) => Promise<unknown>;
  pingFails?: boolean;
  connectFails?: Error | null;
  // when initialize() is called, returns this; defaults to "ok"
  initializeError?: Error | null;
}

export interface MockClient extends McpClientLike {
  // test handles
  closeCount: number;
  callsCallTool: Array<{ name: string; args: unknown }>;
  setBehavior(b: Partial<MockBehavior>): void;
  simulateClose(): void;
  getOnClose(): (() => void) | undefined;
}

export function makeMockClient(initial: MockBehavior = {}): MockClient {
  let behavior: MockBehavior = { ...initial };
  let onclose: (() => void) | undefined;
  const calls: Array<{ name: string; args: unknown }> = [];

  const client: MockClient = {
    closeCount: 0,
    callsCallTool: calls,
    setBehavior(b) { behavior = { ...behavior, ...b }; },
    simulateClose() { onclose?.(); },
    getOnClose() { return onclose; },

    async connect() {
      if (behavior.connectFails) throw behavior.connectFails;
    },
    async initialize() {
      if (behavior.initializeError) throw behavior.initializeError;
      return { capabilities: behavior.capabilities ?? {} };
    },
    getServerCapabilities() {
      return behavior.capabilities ?? {};
    },
    async listTools() {
      return { tools: behavior.tools ?? [] };
    },
    async listResources() {
      return { resources: behavior.resources ?? [] };
    },
    async callTool(req) {
      calls.push({ name: req.name, args: req.arguments });
      const h = behavior.toolHandler;
      if (!h) return { content: [{ type: "text", text: "ok" }] };
      const out = await h(req.name, req.arguments);
      // wrap non-content shapes
      if (typeof out === "object" && out !== null && "content" in (out as object)) return out;
      return { content: [{ type: "text", text: JSON.stringify(out) }] };
    },
    async readResource(req) {
      const h = behavior.resourceHandler;
      if (!h) return { contents: [{ uri: req.uri, mimeType: "text/plain", text: "stub" }] };
      const out = await h(req.uri);
      return out as any;
    },
    async ping() {
      if (behavior.pingFails) throw new Error("ping failed");
    },
    async close() { client.closeCount++; },
    set onclose(cb: (() => void) | undefined) { onclose = cb; },
    get onclose(): (() => void) | undefined { return onclose; },
  };
  return client;
}
