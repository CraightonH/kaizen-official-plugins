import { describe, it, expect, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import plugin from "./index.ts";

function makeCtx() {
  const provided: Record<string, unknown> = {};
  return {
    provided,
    log: mock(() => {}),
    config: {},
    defineEvent: mock(() => {}),
    on: mock(() => {}),
    emit: mock(async () => []),
    defineService: mock(() => {}),
    provideService: mock((name: string, impl: unknown) => { provided[name] = impl; }),
    consumeService: mock(() => {}),
    useService: mock(() => undefined),
    secrets: { get: mock(async () => undefined), refresh: mock(async () => undefined) },
    harness: { name: "test-harness", version: "0.0.0" },
  } as any;
}

describe("llm-config", () => {
  it("metadata", () => {
    expect(plugin.name).toBe("llm-config");
    expect(plugin.apiVersion).toBe("3.0.0");
  });

  it("declares config:store as provided service", () => {
    expect(plugin.services?.provides).toContain("config:store");
  });

  it("declares slash:registry as a consumed service", () => {
    expect(plugin.services?.consumes).toContain("slash:registry");
  });

  it("uses scoped permission tier with fs grants", () => {
    expect(plugin.permissions?.tier).toBe("scoped");
    const fs = (plugin.permissions as any)?.fs;
    expect(Array.isArray(fs?.read)).toBe(true);
    expect(Array.isArray(fs?.write)).toBe(true);
  });

  it("package version matches openai-compatible harness and marketplace pins", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "package.json"), "utf8"));
    const harness = JSON.parse(readFileSync(
      join(import.meta.dir, "..", "..", "harnesses", "openai-compatible.json"),
      "utf8",
    ));
    const marketplace = JSON.parse(readFileSync(
      join(import.meta.dir, "..", "..", ".kaizen", "marketplace.json"),
      "utf8",
    ));
    expect(harness.plugins).toContain(`official/llm-config@${pkg.version}`);
    const entry = marketplace.entries.find((e: any) => e.kind === "plugin" && e.name === "llm-config");
    expect(entry?.versions?.some((v: any) => v.version === pkg.version)).toBe(true);
  });

  it("setup provides config:store", async () => {
    const ctx = makeCtx();
    await plugin.setup!(ctx);
    expect(ctx.provided["config:store"]).toBeDefined();
    const store: any = ctx.provided["config:store"];
    expect(typeof store.get).toBe("function");
    expect(typeof store.set).toBe("function");
    expect(typeof store.register).toBe("function");
    await plugin.stop?.(ctx);
  });
});
