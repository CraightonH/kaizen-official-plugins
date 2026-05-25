import type { SecretsResolver } from "llm-contracts/public";
import { KeychainLockedError, KeychainNotFoundError } from "./errors.ts";

export interface SpawnResult { stdout: string; stderr: string; exitCode: number }
export type SpawnFn = (cmd: string, args: string[]) => Promise<SpawnResult>;

export function createKeychainResolver(spawn: SpawnFn, keychainService: string): SecretsResolver {
  const run = async (args: string[]): Promise<SpawnResult> => spawn("security", args);

  return {
    scheme: "keychain",
    readOnly: false,
    async get(key) {
      const r = await run(["find-generic-password", "-s", keychainService, "-a", key, "-w"]);
      if (r.exitCode === 44) throw new KeychainNotFoundError(key);
      if (r.exitCode === 51) throw new KeychainLockedError();
      if (r.exitCode !== 0) throw new Error(`security find-generic-password failed (exit ${r.exitCode}): ${r.stderr.trim()}`);
      return r.stdout.replace(/\n$/, "");
    },
    async set(key, value) {
      const r = await run(["add-generic-password", "-U", "-s", keychainService, "-a", key, "-w", value]);
      if (r.exitCode === 51) throw new KeychainLockedError();
      if (r.exitCode !== 0) throw new Error(`security add-generic-password failed (exit ${r.exitCode}): ${r.stderr.trim()}`);
    },
    async delete(key) {
      const r = await run(["delete-generic-password", "-s", keychainService, "-a", key]);
      if (r.exitCode === 44) return;
      if (r.exitCode === 51) throw new KeychainLockedError();
      if (r.exitCode !== 0) throw new Error(`security delete-generic-password failed (exit ${r.exitCode}): ${r.stderr.trim()}`);
    },
  };
}
