import type { SecretsResolver } from "llm-contracts/public";
import { KeychainLockedError, KeychainNotFoundError } from "./errors.ts";

export const KEYCHAIN_SERVICE = "kaizen-secrets";

export interface SpawnResult { stdout: string; stderr: string; exitCode: number }
export type SpawnFn = (cmd: string, args: string[]) => Promise<SpawnResult>;

export function createKeychainResolver(spawn: SpawnFn): SecretsResolver {
  const run = async (args: string[]): Promise<SpawnResult> => spawn("security", args);

  return {
    scheme: "keychain",
    readOnly: false,
    async get(key) {
      const r = await run(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", key, "-w"]);
      if (r.exitCode === 44) throw new KeychainNotFoundError(key);
      if (r.exitCode === 51) throw new KeychainLockedError();
      if (r.exitCode !== 0) throw new Error(`security find-generic-password failed (exit ${r.exitCode}): ${r.stderr.trim()}`);
      return r.stdout.replace(/\n$/, "");
    },
    async set(key, value) {
      const r = await run(["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", key, "-w", value]);
      if (r.exitCode === 51) throw new KeychainLockedError();
      if (r.exitCode !== 0) throw new Error(`security add-generic-password failed (exit ${r.exitCode}): ${r.stderr.trim()}`);
    },
    async delete(key) {
      const r = await run(["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", key]);
      if (r.exitCode === 44) return;
      if (r.exitCode === 51) throw new KeychainLockedError();
      if (r.exitCode !== 0) throw new Error(`security delete-generic-password failed (exit ${r.exitCode}): ${r.stderr.trim()}`);
    },
  };
}
