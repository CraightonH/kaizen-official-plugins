import { describe, it, expect } from "bun:test";

interface Ctx {
  log: (m: string) => void;
  defineService: () => void;
  provideService: () => void;
  useService: <T>(id: string) => T;
}

interface MakeCtxOpts {
  registryReturn?: unknown;
  configReturn?: unknown;
}

function makeCtx(opts: MakeCtxOpts = {}): { ctx: Ctx; logs: string[] } {
  const logs: string[] = [];
  const ctx: Ctx = {
    log: (m) => { logs.push(m); },
    defineService: () => {},
    provideService: () => {},
    useService: <T>(id: string) => {
      if (id === "secrets:registry") return opts.registryReturn as T;
      if (id === "config:store") return opts.configReturn as T;
      return undefined as T;
    },
  };
  return { ctx, logs };
}

describe("plugin setup", () => {
  it("on non-darwin, logs and does not register", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try {
      const calls: any[] = [];
      const { ctx, logs } = makeCtx({
        registryReturn: { register: (r: unknown) => { calls.push(r); return () => {}; } },
      });
      const { default: plugin } = await import("./index.ts");
      await plugin.setup(ctx as any);
      expect(calls).toHaveLength(0);
      expect(logs.join("\n")).toMatch(/non-darwin|not supported/);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });

  it("on darwin, registers a 'keychain' resolver with the registry", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    try {
      const calls: any[] = [];
      const { ctx } = makeCtx({
        registryReturn: { register: (r: any) => { calls.push(r); return () => {}; } },
      });
      const { default: plugin } = await import("./index.ts");
      await plugin.setup(ctx as any);
      expect(calls).toHaveLength(1);
      expect(calls[0].scheme).toBe("keychain");
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });

  it("on darwin without config:store, falls back to DEFAULT_CONFIG and still registers", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    try {
      const calls: any[] = [];
      const { ctx, logs } = makeCtx({
        registryReturn: { register: (r: any) => { calls.push(r); return () => {}; } },
        configReturn: undefined,
      });
      const { default: plugin } = await import("./index.ts");
      await plugin.setup(ctx as any);
      expect(calls).toHaveLength(1);
      expect(logs.join("\n")).toMatch(/config:store unavailable/);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });

  it("on darwin with config:store, registers config spec and uses configured keychainService", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    try {
      const registerCalls: any[] = [];
      const configRegisterCalls: any[] = [];
      const { ctx } = makeCtx({
        registryReturn: { register: (r: any) => { registerCalls.push(r); return () => {}; } },
        configReturn: {
          register: (spec: any) => { configRegisterCalls.push(spec); },
          get: (_plugin: string) => ({ keychainService: "custom-service" }),
        },
      });
      const { default: plugin } = await import("./index.ts");
      await plugin.setup(ctx as any);
      expect(configRegisterCalls).toHaveLength(1);
      expect(configRegisterCalls[0].plugin).toBe("kaizen-secrets-keychain");
      expect(configRegisterCalls[0].defaults.keychainService).toBe("kaizen-secrets");
      expect(registerCalls).toHaveLength(1);
      expect(registerCalls[0].scheme).toBe("keychain");
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });
});
