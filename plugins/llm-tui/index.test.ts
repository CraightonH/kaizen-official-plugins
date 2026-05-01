import { describe, it, expect, mock } from "bun:test";
import plugin from "./index.tsx";

function makeCtx() {
  const provided: Record<string, unknown> = {};
  const subs: Record<string, Function[]> = {};
  return {
    provided,
    subs,
    log: mock(() => {}),
    config: {},
    defineEvent: mock(() => {}),
    on: mock((event: string, h: Function) => { (subs[event] ??= []).push(h); }),
    emit: mock(async () => []),
    defineService: mock(() => {}),
    provideService: mock((name: string, impl: unknown) => { provided[name] = impl; }),
    consumeService: mock(() => {}),
    useService: mock(() => undefined),
    secrets: { get: mock(async () => undefined), refresh: mock(async () => undefined) },
  } as any;
}

describe("llm-tui plugin metadata", () => {
  it("has correct metadata", () => {
    expect(plugin.name).toBe("llm-tui");
    expect(plugin.apiVersion).toBe("3.0.0");
    expect(plugin.permissions?.tier).toBe("trusted");
  });
});
