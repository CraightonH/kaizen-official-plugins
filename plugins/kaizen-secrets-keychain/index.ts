import type { KaizenPlugin } from "kaizen/types";
import type { ConfigStoreService, SecretsRegistryService } from "llm-contracts/public";
import { spawn } from "node:child_process";
import { createKeychainResolver, type SpawnFn } from "./resolver.ts";
import { DEFAULT_CONFIG, CONFIG_SCHEMA } from "./config.ts";
import type { KaizenSecretsKeychainConfig } from "./public.d.ts";

const offs: Array<() => void> = [];

const realSpawn: SpawnFn = (cmd, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 0 }));
  });

const plugin: KaizenPlugin = {
  name: "kaizen-secrets-keychain",
  apiVersion: "3.0.0",
  permissions: { tier: "unscoped" },
  services: {
    provides: [],
    consumes: ["secrets:registry", "config:store"],
  },

  async setup(ctx) {
    if (process.platform !== "darwin") {
      ctx.log(`kaizen-secrets-keychain: platform '${process.platform}' is not supported (darwin only); resolver not registered`);
      return;
    }

    // Load config (topo-hint optional). Read once at setup; restart kaizen
    // to pick up changes — the resolver factory closes over the service
    // name at registration time, so live-updating it mid-session would
    // silently orphan in-flight reads.
    let config: KaizenSecretsKeychainConfig = { ...DEFAULT_CONFIG };
    const cfgSvc = ctx.useService<ConfigStoreService>("config:store");
    if (cfgSvc) {
      try {
        cfgSvc.register<KaizenSecretsKeychainConfig>({
          plugin: "kaizen-secrets-keychain",
          defaults: { ...DEFAULT_CONFIG },
          schema: CONFIG_SCHEMA,
        });
        config = cfgSvc.get<KaizenSecretsKeychainConfig>("kaizen-secrets-keychain");
      } catch (e) {
        ctx.log(`kaizen-secrets-keychain: config:store register failed (${(e as Error).message}); using defaults`);
      }
    } else {
      ctx.log("kaizen-secrets-keychain: config:store unavailable; using DEFAULT_CONFIG");
    }

    try {
      const registry = ctx.useService<SecretsRegistryService>("secrets:registry");
      const resolver = createKeychainResolver(realSpawn, config.keychainService);
      offs.push(registry.register(resolver));
    } catch (err) {
      ctx.log(`kaizen-secrets-keychain: secrets:registry unavailable (${(err as Error).message}); resolver not registered`);
    }
  },

  async stop() {
    while (offs.length) {
      const off = offs.pop();
      try { off?.(); } catch { /* ignore */ }
    }
  },
};

export default plugin;
