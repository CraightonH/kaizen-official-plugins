// plugins/llm-config/index.ts
import type { KaizenPlugin } from "kaizen/types";
import type { ConfigStoreService, SlashRegistryService } from "llm-contracts/public";
import { homedir } from "node:os";
import { readFileSync, watch } from "node:fs";
import { harnessKey, homeConfigPath, projectConfigPath, type HarnessIdentity } from "./paths.ts";
import { atomicWriteJson } from "./atomic-write.ts";
import { createStore, type StoreDeps } from "./store.ts";
import { registerSlashCommands } from "./slash.ts";

const teardowns: Array<() => void> = [];

const plugin: KaizenPlugin = {
  name: "llm-config",
  apiVersion: "3.0.0",
  permissions: {
    tier: "scoped",
    fs: {
      read: ["~/.kaizen/harnesses/**", "./.kaizen/harnesses/**"],
      write: ["~/.kaizen/harnesses/**", "./.kaizen/harnesses/**"],
    },
  },
  services: {
    provides: ["config:store"],
    consumes: ["slash:registry"],
  },

  async setup(ctx) {
    const home = homedir();
    const cwd = process.cwd();
    const identity = ((ctx as { harness?: HarnessIdentity }).harness) ?? {};
    const key = harnessKey(identity);
    const homePath = homeConfigPath(home, key);
    const projectPath = projectConfigPath(cwd, key);

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
    };

    const store = createStore(deps);
    ctx.provideService<ConfigStoreService>("config:store", store);

    try {
      const slash = ctx.useService<SlashRegistryService>("slash:registry");
      teardowns.push(...registerSlashCommands(slash, {
        store,
        homePath,
        projectPath,
        harnessKey: key,
        editor: process.env.EDITOR ?? "vi",
        log: ctx.log.bind(ctx),
      }));
    } catch (err) {
      ctx.log(`llm-config: slash:registry unavailable (${(err as Error).message}); /config commands disabled`);
    }
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
