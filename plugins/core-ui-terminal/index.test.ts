import { describe, it, expect, mock } from "bun:test";
import plugin from "./index.js";

function makeCtx() {
  return {
    log: mock(() => {}),
    config: {},
    registerTool: mock(() => {}),
    registerService: mock(() => {}),
    registerExecutor: mock(() => {}),
    registerUi: mock(() => {}),
    getService: mock(() => ({})),
    defineCapability: mock(() => {}),
    defineEvent: mock(() => {}),
    on: mock(() => {}),
    emit: mock(async () => []),
    secrets: {
      get: mock(async () => undefined),
      refresh: mock(async () => undefined),
    },
    fs: {}, net: {}, exec: { run: mock(async () => ({ exitCode: 0, stdout: "", stderr: "" })) },
    pluginManager: {
      load: mock(async () => {}), unload: mock(async () => {}), reload: mock(async () => {}),
      queueLoad: mock(() => {}), queueUnload: mock(() => {}), queueReload: mock(() => {}),
      list: mock(() => []),
    },
    runtime: {} as any,
  } as any;
}

describe("core-ui-terminal", () => {
  it("has metadata", () => {
    expect(plugin.name).toBe("core-ui-terminal");
    expect(plugin.apiVersion).toMatch(/^\d+\.\d+\.\d+/);
  });
});
