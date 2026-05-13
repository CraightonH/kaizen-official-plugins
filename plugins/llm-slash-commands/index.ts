import type { KaizenPlugin } from "kaizen/types";
import { readdir, readFile } from "node:fs/promises";
import { createRegistry, type SlashRegistryService } from "./registry.ts";
import { registerBuiltins } from "./builtins.ts";
import { loadFileCommands, type DriverLike } from "./file-loader.ts";
import { makeOnInputSubmit } from "./dispatcher.ts";
import { buildCompletionSource } from "./completion.ts";
import type { TuiCompletionService } from "llm-tui/public";

// Module-scope handles so stop() can clean up idempotently on reload.
let completionOff: (() => void) | undefined;

const plugin: KaizenPlugin = {
  name: "llm-slash-commands",
  apiVersion: "3.0.0",
  permissions: { tier: "unscoped" },
  services: { provides: ["slash:registry"] },

  async setup(ctx) {
    // The kaizen runtime accepts an optional 3rd `{ priority }` argument on
    // ctx.on, but the public PluginContext type currently exposes only the
    // 2-arg form. Cast once here so the rest of the setup body reads cleanly.
    const on = ctx.on as unknown as (
      event: string,
      handler: (payload?: unknown) => Promise<unknown | void>,
      opts?: { priority?: number },
    ) => void;

    const registry: SlashRegistryService = createRegistry();
    let activeSessionId: string | null = null;
    on("session:active-changed", async (payload) => {
      const to = (payload as { to?: unknown } | null | undefined)?.to;
      if (typeof to === "string") activeSessionId = to;
    });

    // Built-ins.
    registerBuiltins(registry);

    // Service defined+provided before file commands run so any file-loader
    // diagnostics or consumer lookups in the same tick see a live registry.
    ctx.defineService("slash:registry", { description: "Slash command registry." });
    ctx.provideService<SlashRegistryService>("slash:registry", registry);

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
      getActiveSessionId: () => activeSessionId,
    });
    if (warnings.length) {
      const text = "llm-slash-commands: file loader warnings\n" + warnings.map((w) => `  - ${w}`).join("\n");
      await ctx.emit("conversation:system-message", {
        message: { role: "system", content: text },
      });
    }

    // Event subscription. Build a per-handler bus that exposes the cancellation
    // signal and the harness emit. The signal is the session-level signal if
    // available; otherwise an unaborted dummy.
    const sessionSignal: AbortSignal = (ctx as { signal?: AbortSignal }).signal ?? new AbortController().signal;
    const onSubmit = makeOnInputSubmit({
      registry,
      bus: {
        emit: async (e, p) => { await ctx.emit(e, p); },
        signal: sessionSignal,
      },
    });
    on("input:submit", onSubmit as (payload?: unknown) => Promise<unknown | void>, { priority: 100 });

    // Optional llm-tui:completion. Defer to harness:start so the lookup runs
    // after llm-tui has provided the service (load order is no longer pinned
    // by a hard consumes declaration).
    on("harness:start", async () => {
      try {
        const completion = ctx.useService<TuiCompletionService>("llm-tui:completion");
        if (completion) completionOff = completion.register(buildCompletionSource(registry));
      } catch { /* llm-tui:completion absent — skip */ }
    });
  },

  async stop() {
    try { completionOff?.(); } catch { /* idempotent */ }
    completionOff = undefined;
  },
};

export default plugin;
