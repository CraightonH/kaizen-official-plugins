import { describe, it, expect, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import plugin, { VOCAB } from "./index.ts";
import { CANCEL_TOOL } from "./index.ts";

function makeCtx() {
  const definedEvents: string[] = [];
  const definedServices: string[] = [];
  const provided: Record<string, unknown> = {};
  return {
    definedEvents,
    definedServices,
    provided,
    log: mock(() => {}),
    config: {},
    defineEvent: mock((name: string) => { definedEvents.push(name); }),
    on: mock(() => {}),
    emit: mock(async () => []),
    defineService: mock((name: string) => { definedServices.push(name); }),
    provideService: mock((name: string, impl: unknown) => { provided[name] = impl; }),
    consumeService: mock(() => {}),
    useService: mock(() => undefined),
    secrets: { get: mock(async () => undefined), refresh: mock(async () => undefined) },
  } as any;
}

describe("llm-events", () => {
  it("metadata", () => {
    expect(plugin.name).toBe("llm-events");
    expect(plugin.apiVersion).toBe("3.0.0");
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
    expect(harness.plugins).toContain(`official/llm-events@${pkg.version}`);
    const entry = marketplace.entries.find((e: any) => e.kind === "plugin" && e.name === "llm-events");
    expect(entry?.versions?.[0]?.version).toBe(pkg.version);
  });

  it("VOCAB is frozen", () => {
    expect(Object.isFrozen(VOCAB)).toBe(true);
  });

  it("VOCAB exposes the Spec 0 event names", () => {
    expect(VOCAB.HARNESS_START).toBe("harness:start");
    expect(VOCAB.SESSION_CREATED).toBe("session:created");
    expect(VOCAB.LLM_BEFORE_CALL).toBe("llm:before-call");
    expect(VOCAB.LLM_TOKEN).toBe("llm:token");
    expect(VOCAB.LLM_DONE).toBe("llm:done");
    expect(VOCAB.LLM_ERROR).toBe("llm:error");
    expect(VOCAB.TOOL_BEFORE_EXECUTE).toBe("tool:before-execute");
    expect(VOCAB.TOOL_PROGRESS).toBe("tool:progress");
    expect(VOCAB.TURN_START).toBe("turn:start");
  });

  it("CANCEL_TOOL is the well-known symbol", () => {
    expect(CANCEL_TOOL as symbol).toBe(Symbol.for("kaizen.cancel"));
  });

  it("VOCAB contains every Spec 0 event name", () => {
    const expected = new Set([
      "harness:start",
      "harness:end",
      "harness:error",
      "harness:exit-requested",
      "session:created",
      "session:resumed",
      "session:deleted",
      "session:active-changed",
      "session:renamed",
      "session:handoff",
      "input:submit",
      "input:handled",
      "conversation:user-message",
      "conversation:assistant-message",
      "conversation:system-message",
      "conversation:cleared",
      "turn:start",
      "turn:end",
      "turn:cancel",
      "turn:error",
      "llm:before-call",
      "llm:request",
      "llm:token",
      "llm:reasoning",
      "llm:tool-call",
      "llm:done",
      "llm:error",
      "tool:before-execute",
      "tool:execute",
      "tool:result",
      "tool:error",
      "tool:progress",
      "codemode:code-emitted",
      "codemode:before-execute",
      "codemode:result",
      "codemode:error",
      "skill:loaded",
      "skill:available-changed",
      "status:item-update",
      "status:item-clear",
      "prompt:rebuilt",
      "prompt:reload",
      "tools:registered",
      "tools:unregistered",
      "mcp:registration-conflict",
    ]);
    const actual = new Set(Object.values(VOCAB));
    for (const name of expected) expect(actual.has(name)).toBe(true);
    for (const name of actual) expect(expected.has(name as string)).toBe(true);
    expect(actual.size).toBe(expected.size);
  });

  it("ChatMessage supports optional meta", () => {
    const m: import("./public").ChatMessage = {
      role: "user",
      content: "hi",
      meta: { handoff: { from: "abc" } },
    };
    expect(m.meta?.handoff).toBeDefined();
  });

  it("public surface excludes owner-specific service contracts", () => {
    const dts = readFileSync(join(import.meta.dir, "public.d.ts"), "utf8");
    const movedNames = [
      "ToolHandler",
      "ToolSource",
      "ToolRegistration",
      "ToolExecutionContext",
      "ToolsRegistryService",
      "ToolDispatchStrategy",
      "SkillManifest",
      "SkillRescanResult",
      "SkillsRegistryService",
      "AgentManifest",
      "AgentsRegistryService",
      "SlashCommandManifest",
      "SlashCommandContext",
      "SlashCommandHandler",
      "SlashRegistryEntry",
      "SlashRegistryService",
      "CompletionItem",
      "CompletionSource",
      "TuiCompletionService",
    ];

    expect(dts).toContain("LLMCompleteService");
    for (const name of movedNames) {
      expect(dts).not.toMatch(new RegExp(`export\\s+(?:interface|type)\\s+${name}\\b`));
    }
  });

  it("CODEMODE_CANCEL_SENTINEL is the well-known string", async () => {
    const mod = await import("./index.ts");
    expect(mod.CODEMODE_CANCEL_SENTINEL).toBe("__kaizen_cancel__");
  });

  it("VOCAB includes prompt:rebuilt and prompt:reload", () => {
    expect(VOCAB.PROMPT_REBUILT).toBe("prompt:rebuilt");
    expect(VOCAB.PROMPT_RELOAD).toBe("prompt:reload");
  });

  it("VOCAB includes tools:registered and tools:unregistered", () => {
    expect(VOCAB.TOOLS_REGISTERED).toBe("tools:registered");
    expect(VOCAB.TOOLS_UNREGISTERED).toBe("tools:unregistered");
  });

  it("VOCAB includes mcp:registration-conflict", () => {
    expect(VOCAB.MCP_REGISTRATION_CONFLICT).toBe("mcp:registration-conflict");
  });

  it("VOCAB.SESSION_HANDOFF is exposed", () => {
    expect(VOCAB.SESSION_HANDOFF).toBe("session:handoff");
  });

  it("provides events:vocabulary and defines foundation services/events", async () => {
    const ctx = makeCtx();
    await plugin.setup(ctx);
    expect(ctx.definedServices).toEqual([]);
    expect(ctx.provided["events:vocabulary"]).toBe(VOCAB);
    expect(ctx.provided["llm:complete"]).toBeUndefined();
    for (const name of Object.values(VOCAB)) {
      expect(ctx.definedEvents).toContain(name);
    }
  });
});
