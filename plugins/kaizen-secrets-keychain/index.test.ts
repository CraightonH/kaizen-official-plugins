import { describe, it, expect } from "bun:test";

interface Ctx {
  log: (m: string) => void;
  defineService: () => void;
  provideService: () => void;
  useService: <T>(id: string) => T;
}

function makeCtx(over: Partial<Ctx> = {}, useReturn?: unknown): { ctx: Ctx; logs: string[] } {
  const logs: string[] = [];
  const ctx: Ctx = {
    log: (m) => { logs.push(m); },
    defineService: () => {},
    provideService: () => {},
    useService: <T>(_id: string) => useReturn as T,
    ...over,
  };
  return { ctx, logs };
}

describe("plugin setup", () => {
  it("on non-darwin, logs and does not register", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try {
      const calls: any[] = [];
      const { ctx, logs } = makeCtx({}, { register: (r: unknown) => { calls.push(r); return () => {}; } });
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
      const { ctx } = makeCtx({}, { register: (r: any) => { calls.push(r); return () => {}; } });
      const { default: plugin } = await import("./index.ts");
      await plugin.setup(ctx as any);
      expect(calls).toHaveLength(1);
      expect(calls[0].scheme).toBe("keychain");
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });
});
