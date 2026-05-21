import type { SecretsResolver } from "llm-contracts/public";

export function createEnvResolver(env: Record<string, string | undefined>): SecretsResolver {
  return {
    scheme: "env",
    readOnly: true,
    async get(key: string): Promise<string> {
      const v = env[key];
      if (v === undefined || v === "") {
        throw new Error(`env:${key} is not set`);
      }
      return v;
    },
    async set(_key: string, _value: string): Promise<void> {
      throw new Error("env: scheme is read-only; export the variable in your shell instead");
    },
    async delete(_key: string): Promise<void> {
      throw new Error("env: scheme is read-only; unset the variable in your shell instead");
    },
  };
}
