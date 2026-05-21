// plugins/llm-contracts/contracts/config-store.ts

export type ConfigScope = "home" | "project";

export type FieldSchema =
  | { type: "string"; min?: number; max?: number; pattern?: string; enum?: string[]; secret?: boolean }
  | { type: "number"; min?: number; max?: number; integer?: boolean }
  | { type: "boolean" }
  | { type: "array"; items: FieldSchema; min?: number; max?: number }
  | {
      type: "object";
      properties: Record<string, FieldSchema>;
      additionalProperties?: boolean | FieldSchema;
    }
  | { type: "enum"; values: readonly string[] };

export type ConfigSchema<T> = { [K in keyof T]?: FieldSchema };

export interface ConfigSpec<T> {
  plugin: string;
  defaults: T;
  schema?: ConfigSchema<T>;
  envVars?: Partial<Record<keyof T & string, string>>;
}

export type ConfigResolutionSource =
  | "default"
  | "home"
  | "project"
  | "env"
  | `secret:${string}`;

export interface ConfigStatus {
  plugin: string;
  homePath: string;
  projectPath: string;
  homeExists: boolean;
  projectExists: boolean;
  resolution: Record<string, ConfigResolutionSource>;
}

export interface ConfigStoreService {
  register<T>(spec: ConfigSpec<T>): void;
  get<T>(plugin: string): T;
  set<T>(plugin: string, value: Partial<T>, scope?: ConfigScope): Promise<void>;
  watch<T>(plugin: string, cb: (next: T) => void): () => void;
  list(): ConfigStatus[];
  ready(): Promise<void>;
}

export const CONTRACT_ID = "config:store" as const;
export const DESCRIPTION =
  "Harness-scoped plugin configuration store. Plugins register schema/defaults; service resolves defaults → home → project → env and exposes get/set/watch.";
