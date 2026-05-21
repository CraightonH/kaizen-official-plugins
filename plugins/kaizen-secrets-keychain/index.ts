import type { KaizenPlugin } from "kaizen/types";
import type { SecretsRegistryService } from "llm-contracts/public";
import { spawn } from "node:child_process";
import { createKeychainResolver, type SpawnFn } from "./resolver.ts";

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
    consumes: ["secrets:registry"],
  },

  async setup(ctx) {
    if (process.platform !== "darwin") {
      ctx.log(`kaizen-secrets-keychain: platform '${process.platform}' is not supported (darwin only); resolver not registered`);
      return;
    }
    try {
      const registry = ctx.useService<SecretsRegistryService>("secrets:registry");
      const resolver = createKeychainResolver(realSpawn);
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
