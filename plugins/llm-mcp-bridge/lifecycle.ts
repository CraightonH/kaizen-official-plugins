import type { ResolvedServerConfig } from "./config.ts";
import type { McpClientLike, CreateClientResult } from "./client.ts";
import { computeBackoffMs as defaultBackoff, RETRY_BUDGET as DEFAULT_BUDGET } from "./backoff.ts";
import { toToolRegistration } from "./registration.ts";
import type { ServerInfo, ServerStatus } from "./public.d.ts";

export interface RegistryLike {
  register(schema: { name: string; description: string; parameters: object; tags?: string[] }, handler: (args: unknown, ctx: any) => Promise<unknown>): () => void;
}

export interface LifecycleDeps {
  cfg: ResolvedServerConfig;
  registry: RegistryLike;
  log: (msg: string) => void;
  createClient: (cfg: ResolvedServerConfig) => CreateClientResult;
  setTimeout: (cb: () => void, ms: number) => unknown;
  clearTimeout: (h: unknown) => void;
  now: () => number;
  retryBudget?: number;
  computeBackoffMs?: (attempt: number) => number;
  onStatusChange?: (info: ServerInfo) => void;
}

interface RegisteredTool {
  mcpName: string;
  schema: { name: string; description: string; parameters: object; tags?: string[] };
  unregister: () => void;
}

export class ServerLifecycle {
  private status: ServerStatus;
  private client: McpClientLike | undefined;
  private healthTimer: unknown;
  private reconnectTimer: unknown;
  private attempts = 0;
  private connectedAt: number | undefined;
  private lastError: string | undefined;
  private registered = new Map<string, RegisteredTool>(); // key: mcpName
  private resourceCount = -1;
  private shutdownCalled = false;

  constructor(private deps: LifecycleDeps) {
    this.status = deps.cfg.enabled ? "connecting" : "disabled";
  }

  config(): ResolvedServerConfig { return this.deps.cfg; }

  info(): ServerInfo {
    return {
      name: this.deps.cfg.name,
      transport: this.deps.cfg.transport,
      status: this.status,
      toolCount: this.registered.size,
      resourceCount: this.resourceCount,
      promptCount: 0,
      lastError: this.lastError,
      connectedAt: this.connectedAt,
      reconnectAttempts: this.attempts,
    };
  }

  getClient(): McpClientLike | undefined {
    return this.status === "connected" ? this.client : undefined;
  }

  start(): void {
    if (!this.deps.cfg.enabled) {
      this.setStatus("disabled");
      return;
    }
    this.setStatus("connecting");
    void this.tryConnect();
  }

  disable(): void {
    void this.shutdown().then(() => this.setStatus("disabled"));
  }

  async forceReconnect(): Promise<void> {
    this.cancelTimers();
    if (this.client) {
      try { await this.client.close(); } catch { /* ignore */ }
    }
    this.attempts = 0;
    this.lastError = undefined;
    this.shutdownCalled = false;
    this.setStatus("connecting");
    await this.tryConnect();
  }

  async shutdown(): Promise<void> {
    if (this.shutdownCalled) return;
    this.shutdownCalled = true;
    this.cancelTimers();
    const c = this.client;
    this.client = undefined;
    if (c) {
      try {
        await Promise.race([
          c.close(),
          new Promise<void>((resolve) => this.deps.setTimeout(() => resolve(), 5000)),
        ]);
      } catch (err) {
        this.deps.log(`mcp:${this.deps.cfg.name}: close errored: ${(err as Error).message}`);
      }
    }
    // Unregister all tools.
    for (const r of this.registered.values()) {
      try { r.unregister(); } catch { /* ignore */ }
    }
    this.registered.clear();
  }

  private cancelTimers(): void {
    if (this.healthTimer !== undefined) { this.deps.clearTimeout(this.healthTimer); this.healthTimer = undefined; }
    if (this.reconnectTimer !== undefined) { this.deps.clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined; }
  }

  private setStatus(s: ServerStatus): void {
    this.status = s;
    this.deps.onStatusChange?.(this.info());
  }

  private async tryConnect(): Promise<void> {
    if (this.shutdownCalled) return;
    let result: CreateClientResult;
    try {
      result = this.deps.createClient(this.deps.cfg);
    } catch (err) {
      this.lastError = (err as Error).message;
      this.deps.log(`mcp:${this.deps.cfg.name}: createClient failed: ${this.lastError}`);
      this.scheduleRetry();
      return;
    }
    const client = result.client;
    client.onclose = () => this.handleDisconnect("transport closed");
    try {
      await client.connect();
    } catch (err) {
      this.lastError = (err as Error).message;
      this.deps.log(`mcp:${this.deps.cfg.name}: connect failed: ${this.lastError}`);
      this.scheduleRetry();
      return;
    }
    if (this.shutdownCalled) {
      try { await client.close(); } catch { /* ignore */ }
      return;
    }
    this.client = client;
    this.connectedAt = this.deps.now();
    this.attempts = 0;
    this.lastError = undefined;
    this.setStatus("connected");

    const caps = (client.getServerCapabilities() ?? {}) as { tools?: object; resources?: object; prompts?: object };
    if (caps.tools) {
      try { await this.reconcileTools(); }
      catch (err) { this.deps.log(`mcp:${this.deps.cfg.name}: tools/list failed: ${(err as Error).message}`); }
    }
    if (caps.resources) {
      try { const r = await client.listResources(); this.resourceCount = r.resources?.length ?? 0; }
      catch { this.resourceCount = -1; }
    }
    if (caps.prompts) {
      this.deps.log(`mcp:${this.deps.cfg.name}: prompts capability advertised; ignored in v0`);
    }

    // Subscribe to tools/list_changed
    client.setNotificationHandler?.("notifications/tools/list_changed", () => {
      this.reconcileTools().catch((err) => this.deps.log(`mcp:${this.deps.cfg.name}: reconcile failed: ${(err as Error).message}`));
    });

    // Schedule periodic ping
    this.scheduleHealthCheck();
  }

  private scheduleHealthCheck(): void {
    if (this.shutdownCalled) return;
    this.healthTimer = this.deps.setTimeout(() => {
      void this.runHealthCheck();
    }, this.deps.cfg.healthCheckMs);
  }

  private async runHealthCheck(): Promise<void> {
    if (this.status !== "connected" || !this.client) return;
    try {
      await this.client.ping();
      this.scheduleHealthCheck();
    } catch (err) {
      this.deps.log(`mcp:${this.deps.cfg.name}: health check failed: ${(err as Error).message}`);
      this.handleDisconnect((err as Error).message);
    }
  }

  private handleDisconnect(why: string): void {
    if (this.shutdownCalled) return;
    if (this.status === "reconnecting" || this.status === "quarantined" || this.status === "disabled") return;
    this.lastError = why;
    this.client = undefined;
    if (this.healthTimer !== undefined) { this.deps.clearTimeout(this.healthTimer); this.healthTimer = undefined; }
    this.setStatus("reconnecting");
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.shutdownCalled) return;
    const budget = this.deps.retryBudget ?? DEFAULT_BUDGET;
    this.attempts++;
    if (this.attempts >= budget) {
      this.setStatus("quarantined");
      return;
    }
    const delay = (this.deps.computeBackoffMs ?? defaultBackoff)(this.attempts);
    this.setStatus("reconnecting");
    this.reconnectTimer = this.deps.setTimeout(() => {
      this.reconnectTimer = undefined;
      this.setStatus("connecting");
      void this.tryConnect();
    }, delay);
  }

  private async reconcileTools(): Promise<void> {
    if (!this.client) return;
    const list = await this.client.listTools();
    const seen = new Set<string>();
    for (const t of list.tools ?? []) {
      seen.add(t.name);
      const existing = this.registered.get(t.name);
      const newReg = toToolRegistration(this.deps.cfg.name, t, () => this.getClient(), this.deps.cfg.timeoutMs);
      if (existing) {
        const same = existing.schema.description === newReg.schema.description &&
                     JSON.stringify(existing.schema.parameters) === JSON.stringify(newReg.schema.parameters);
        if (same) continue;
        try { existing.unregister(); } catch { /* ignore */ }
        this.registered.delete(t.name);
      }
      try {
        const unregister = this.deps.registry.register(newReg.schema, newReg.handler);
        this.registered.set(t.name, { mcpName: t.name, schema: newReg.schema, unregister });
      } catch (err) {
        this.deps.log(`mcp:${this.deps.cfg.name}: register ${newReg.schema.name} failed: ${(err as Error).message}`);
      }
    }
    // Unregister tools no longer present
    for (const [name, r] of this.registered) {
      if (!seen.has(name)) {
        try { r.unregister(); } catch { /* ignore */ }
        this.registered.delete(name);
      }
    }
  }
}
