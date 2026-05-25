import type { KaizenPlugin } from "kaizen/types";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { createRegistry } from "./registry.ts";
import type { ConfigStoreService, SlashRegistryService } from "llm-contracts/public";
import { registerBuiltins } from "./builtins.ts";
import { loadFileCommands, type DriverLike } from "./file-loader.ts";
import { makeOnInputSubmit } from "./dispatcher.ts";
import { buildCompletionSource } from "./completion.ts";
import { buildArgCompletionSource } from "./arg-completion.ts";
import type { UiCompletionService } from "llm-contracts/public";
import type { SlashCommandsConfig } from "./public.d.ts";
import { DEFAULT_CONFIG, CONFIG_SCHEMA } from "./config.ts";

// Tilde expansion helper. `~` and `~/...` expand against the current user's
// home directory. `HOME` is honored when set (Unix convention, also keeps
// integration tests that override `process.env.HOME` working); otherwise we
// fall back to `os.homedir()`. Anything else passes through verbatim.
function userHome(): string {
  return process.env.HOME && process.env.HOME.length > 0 ? process.env.HOME : homedir();
}

function expandHome(p: string): string {
  if (p === "~") return userHome();
  if (p.startsWith("~/")) return `${userHome()}/${p.slice(2)}`;
  return p;
}

function resolveDir(p: string, cwd: string): string {
  const expanded = expandHome(p);
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

// Module-scope handles so stop() can clean up idempotently on reload.
let completionOff: (() => void) | undefined;
let argCompletionOff: (() => void) | undefined;

const plugin: KaizenPlugin = {
  name: "llm-slash-commands",
  apiVersion: "3.0.0",
  permissions: { tier: "unscoped" },
  services: {
    provides: ["slash:registry"],
    consumes: ["config:store"],
  },

  async setup(ctx) {
    const log = (m: string) => ctx.log?.(m);

    // Load config (topo-hint optional).
    let config: SlashCommandsConfig = { ...DEFAULT_CONFIG };
    const cfgSvc = ctx.useService<ConfigStoreService>("config:store");
    if (cfgSvc) {
      try {
        cfgSvc.register<SlashCommandsConfig>({
          plugin: "llm-slash-commands",
          defaults: { ...DEFAULT_CONFIG },
          schema: CONFIG_SCHEMA,
        });
        config = cfgSvc.get<SlashCommandsConfig>("llm-slash-commands");
      } catch (e) {
        log(`llm-slash-commands: config:store register failed (${(e as Error).message}); using defaults`);
      }
    } else {
      log("llm-slash-commands: config:store unavailable; using DEFAULT_CONFIG");
    }
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
    ctx.provideService<SlashRegistryService>("slash:registry", registry);

    // File commands. Resolve both directories now from config; the file loader
    // takes fully-resolved absolute paths and does not know about `~` or cwd.
    const cwd = (ctx as { cwd?: string }).cwd ?? process.cwd();
    const userDir = resolveDir(config.userDir, cwd);
    const projectDir = resolveDir(config.projectDir, cwd);
    const warnings = await loadFileCommands({
      userDir,
      projectDir,
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

    // Optional ui:completion-source. Defer to harness:start so the lookup runs
    // after llm-tui has provided the service (load order is no longer pinned
    // by a hard consumes declaration).
    on("harness:start", async () => {
      try {
        const completion = ctx.useService<UiCompletionService>("ui:completion-source");
        if (completion) {
          completionOff = completion.register(buildCompletionSource(registry));
          argCompletionOff = completion.register(buildArgCompletionSource(registry));
        }
      } catch { /* ui:completion-source absent — skip */ }
    });
  },

  async stop() {
    try { completionOff?.(); } catch { /* idempotent */ }
    try { argCompletionOff?.(); } catch { /* idempotent */ }
    completionOff = undefined;
    argCompletionOff = undefined;
  },
};

export default plugin;
