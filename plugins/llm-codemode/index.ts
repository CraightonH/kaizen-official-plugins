import type { KaizenPlugin } from "kaizen/types";
import type { ToolSchema } from "llm-contracts/public";
import type { ToolExecutionContext, ToolHandler, ToolsRegistryService } from "llm-tools-registry/public";
import { loadConfig, realDeps } from "./config.ts";
import { renderSurface, surfaceHash } from "./assembler.ts";
import { runInSandbox, type SandboxRunResult } from "./sandbox-host.ts";
import { formatToolResult } from "./serialize.ts";

const TOOL_NAME = "execute_typescript";

const PARAMETERS = {
  type: "object" as const,
  properties: {
    code: {
      type: "string" as const,
      description: "TypeScript source. Top-level await is allowed. Trailing expressions are returned. Use the kaizen.* APIs documented in this tool's description to call tools, MCP servers, agents, skills, and memory.",
    },
  },
  required: ["code"],
  additionalProperties: false,
};

const PREAMBLE = `Executes TypeScript in a sandboxed Bun Worker. Top-level await is allowed; the trailing expression's value is returned. Console output is captured as stdout. The sandbox exposes a typed \`kaizen\` global with the runtime's tools, MCP servers, agents, skills, and memory grouped by source. Prefer composing many operations in one code block over many sequential tool calls.

Available API surface (regenerated from the live registry on every LLM call so late MCP/agent registrations are always visible):`;

const plugin: KaizenPlugin = {
  name: "llm-codemode",
  apiVersion: "3.0.0",
  permissions: { tier: "unscoped" },
  services: {
    consumes: ["tools:registry"],
  },

  async setup(ctx) {
    ctx.consumeService("tools:registry");

    const config = await loadConfig(realDeps((m) => ctx.log(m)));

    const toolsRegistry = ctx.useService<ToolsRegistryService>("tools:registry");
    if (!toolsRegistry || typeof toolsRegistry.listRegistrations !== "function") {
      ctx.log("llm-codemode: tools:registry (with listRegistrations) not available; nothing to register");
      return;
    }

    // Cached surface. We re-render on llm:before-call to pick up late
    // registrations (MCP servers loading async, dynamic agents). surfaceHash()
    // short-circuits when nothing changed.
    let cachedHash = "";
    let cachedDescription = `${PREAMBLE}\n(loading…)`;

    async function buildDescription(): Promise<string> {
      // Exclude ourselves from the rendered surface — execute_typescript
      // documenting itself would be recursive and useless.
      const regs = toolsRegistry!.listRegistrations().filter((r) => r.schema.name !== TOOL_NAME);
      const hash = surfaceHash(regs);
      if (hash === cachedHash) return cachedDescription;
      cachedHash = hash;
      cachedDescription = `${PREAMBLE}\n${await renderSurface(regs)}`;
      return cachedDescription;
    }

    const initialDescription = await buildDescription();

    const schema: ToolSchema = {
      name: TOOL_NAME,
      description: initialDescription,
      parameters: PARAMETERS,
    };

    const handler: ToolHandler = async (args, exec: ToolExecutionContext) => {
      const code = (args as any)?.code;
      if (typeof code !== "string") {
        throw new Error(`execute_typescript: 'code' must be a string`);
      }
      const result: SandboxRunResult = await runInSandbox(
        code,
        toolsRegistry as any,
        exec.signal,
        config,
        async (name, payload) => { await ctx.emit(name, payload); },
        exec.turnId,
        exec.sessionId,
        exec.callId,
      );
      return formatToolResult(result, {
        maxStdoutBytes: config.maxStdoutBytes,
        maxReturnBytes: config.maxReturnBytes,
      });
    };

    toolsRegistry.register(schema, handler);

    // Register TUI renderer if the service is available (lazy import to avoid
    // pulling React/Ink in non-TUI environments). Optional dependency: no
    // hard consume edge — the plugin degrades to no inline renderer.
    const tuiRenderers = ctx.useService?.("llm-tui:tool-renderer") as
      | { register: (r: any) => () => void }
      | undefined;
    if (tuiRenderers) {
      const { codemodeRenderer } = await import("./tui-renderer.tsx");
      tuiRenderers.register(codemodeRenderer);
    }

    // Refresh the description on every LLM call. The driver supports request
    // mutation in this hook (see plugins/llm-driver/CLAUDE.md "llm:before-call
    // is mutable + cancellable"). We mutate the tools[] entry in place rather
    // than re-registering, which would create tools:registered/unregistered
    // churn and a feedback loop.
    ctx.on("llm:before-call", async (payload: any) => {
      const req = payload?.request;
      if (!req || !Array.isArray(req.tools)) return;
      const idx = req.tools.findIndex((t: any) => t?.name === TOOL_NAME);
      if (idx < 0) return;
      const desc = await buildDescription();
      req.tools[idx] = { ...req.tools[idx], description: desc };
    });
  },
};

export default plugin;
