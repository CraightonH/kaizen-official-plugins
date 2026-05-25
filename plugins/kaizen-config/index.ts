// plugins/kaizen-config/index.ts
import type { KaizenPlugin } from "kaizen/types";
import type { ConfigStoreService, SecretsRegistryService, SlashRegistryService } from "llm-contracts/public";
import { homedir } from "node:os";
import { readFileSync, watch } from "node:fs";
import { spawn } from "node:child_process";
import { harnessKey, homeConfigPath, projectConfigPath, type HarnessIdentity } from "./paths.ts";
import { atomicWriteJson } from "./atomic-write.ts";
import { createStore, type StoreDeps } from "./store.ts";
import { createRegistry } from "./secrets/registry.ts";
import { createEnvResolver } from "./secrets/env-resolver.ts";
import { registerSlashCommands } from "./slash.ts";
import { DEFAULT_CONFIG, CONFIG_SCHEMA } from "./config.ts";
import type { KaizenConfigConfig } from "./public.d.ts";

const teardowns: Array<() => void> = [];

const plugin: KaizenPlugin = {
  name: "kaizen-config",
  apiVersion: "3.0.0",
  permissions: {
    tier: "scoped",
    fs: {
      read: ["~/.kaizen/harnesses/**", "./.kaizen/harnesses/**"],
      write: ["~/.kaizen/harnesses/**", "./.kaizen/harnesses/**"],
    },
    events: { subscribe: ["harness:start"] },
  },
  services: {
    provides: ["config:store", "secrets:registry"],
    // slash:registry is consumed as a deferred-optional via the harness:start
    // event below — not declared here. Declaring it would create a cycle:
    // kaizen-config → slash:registry → llm-slash-commands → config:store →
    // kaizen-config (llm-slash-commands now consumes config:store).
    consumes: [],
  },

  async setup(ctx) {
    const home = homedir();
    const cwd = process.cwd();
    const identity = ((ctx as { harness?: HarnessIdentity }).harness) ?? {};
    const key = harnessKey(identity);
    const homePath = homeConfigPath(home, key);
    const projectPath = projectConfigPath(cwd, key);

    const registry = createRegistry();
    registry.register(createEnvResolver(process.env as Record<string, string | undefined>));
    ctx.provideService<SecretsRegistryService>("secrets:registry", registry);

    const deps: StoreDeps = {
      homePath,
      projectPath,
      readFile: (p) => readFileSync(p, "utf8"),
      writeFile: (p, v) => atomicWriteJson(p, v),
      watchFile: (p, cb) => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const fire = () => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(cb, 150);
        };
        try {
          const w = watch(p, { persistent: false }, fire);
          // also watch the directory so newly-created files fire
          const dirWatcher = watch(p.replace(/\/[^/]+$/, ""), { persistent: false }, fire);
          return () => { w.close(); dirWatcher.close(); if (timer) clearTimeout(timer); };
        } catch {
          // Path or dir may not exist yet; degrade silently. fs.watch will be
          // retried only after a successful read introduces the path. For v0
          // we accept that newly-created config files require a restart.
          return () => {};
        }
      },
      env: process.env as Record<string, string | undefined>,
      log: ctx.log.bind(ctx),
      registry,
    };

    const store = createStore(deps);
    ctx.provideService<ConfigStoreService>("config:store", store);

    store.register<KaizenConfigConfig>({
      plugin: "kaizen-config",
      defaults: { ...DEFAULT_CONFIG },
      schema: CONFIG_SCHEMA,
    });

    // Register /config slash commands on harness:start so the slash:registry
    // provider (which now consumes config:store) is guaranteed to have booted.
    // See services.consumes comment above for the cycle this avoids.
    ctx.on("harness:start", async () => {
      try {
        const slash = ctx.useService<SlashRegistryService>("slash:registry");
        teardowns.push(...registerSlashCommands(slash, {
          store,
          homePath,
          projectPath,
          harnessKey: key,
          editor: () =>
            store.get<KaizenConfigConfig>("kaizen-config").editor
              ?? process.env.EDITOR
              ?? "vi",
          log: ctx.log.bind(ctx),
          spawnEditor: (editor, path) => new Promise<number>((resolve, reject) => {
            const child = spawn(editor, [path], { stdio: "inherit" });
            child.on("exit", (code) => resolve(code ?? 0));
            child.on("error", reject);
          }),
          registry,
          defaultSecretBackend: () => store.get<KaizenConfigConfig>("kaizen-config").defaultSecretBackend,
        }));
      } catch (err) {
        ctx.log(`kaizen-config: slash:registry unavailable (${(err as Error).message}); /config commands disabled`);
      }
    });
  },

  async stop() {
    while (teardowns.length) {
      const off = teardowns.pop();
      if (!off) continue;
      try { off(); } catch { /* ignore */ }
    }
  },
};

export default plugin;
