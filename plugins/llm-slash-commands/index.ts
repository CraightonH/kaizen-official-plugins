import type { KaizenPlugin } from "kaizen/types";
import { readdir, readFile } from "node:fs/promises";
import { createRegistry, type SlashRegistryService } from "./registry.ts";
import { registerBuiltins } from "./builtins.ts";
import { loadFileCommands, type DriverLike } from "./file-loader.ts";
import { makeOnInputSubmit } from "./dispatcher.ts";
import { buildCompletionSource } from "./completion.ts";

interface TuiCompletionService {
  register(source: { trigger: string; list(input: string, cursor: number): Promise<unknown[]> }): () => void;
}

const plugin: KaizenPlugin = {
  name: "llm-slash-commands",
  apiVersion: "3.0.0",
  permissions: { tier: "trusted" },
  services: { provides: ["slash:registry"] },

  async setup(ctx) {
    const registry: SlashRegistryService = createRegistry();

    // Built-ins.
    registerBuiltins(registry);

    // File commands.
    const home = process.env.HOME ?? "/";
    const cwd = process.cwd();
    const warnings = await loadFileCommands({
      home,
      cwd,
      registry,
      readDir: (p) => readdir(p),
      readFile: (p) => readFile(p, "utf8"),
      getDriver: () => ctx.useService?.<DriverLike>("driver:run-conversation") ?? undefined,
    });
    if (warnings.length) {
      const text = "llm-slash-commands: file loader warnings\n" + warnings.map((w) => `  - ${w}`).join("\n");
      await ctx.emit("conversation:system-message", {
        message: { role: "system", content: text },
      });
    }

    // Service.
    ctx.defineService("slash:registry", { description: "Slash command registry." });
    ctx.provideService<SlashRegistryService>("slash:registry", registry);

    // Event subscription. Build a per-handler bus that exposes the cancellation
    // signal and the harness emit. The signal is the session-level signal if
    // available; otherwise an unaborted dummy.
    const sessionSignal: AbortSignal = (ctx as any).signal ?? new AbortController().signal;
    const onSubmit = makeOnInputSubmit({
      registry,
      bus: { emit: (e, p) => ctx.emit(e, p), signal: sessionSignal },
    });
    ctx.on?.("input:submit", onSubmit, { priority: 100 });

    // Optional tui:completion.
    const completion = ctx.useService?.<TuiCompletionService>("tui:completion");
    if (completion) {
      completion.register(buildCompletionSource(registry) as any);
    }
  },
};

export default plugin;
