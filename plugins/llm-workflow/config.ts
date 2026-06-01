import type { JSONSchema7 } from "json-schema";
import type { WorkflowConfigFile } from "./public.d.ts";

export const DEFAULT_CONFIG: Readonly<WorkflowConfigFile> = Object.freeze({
  userDir: "~/.kaizen/workflows",
  projectDir: ".kaizen/workflows",
  maxConcurrency: null,
  maxLifetimeAgents: 1000,
  timeoutMs: 600000,
  workerGracefulShutdownMs: 1000,
  metaParse: Object.freeze({ maxFileBytes: 65536 }),
}) as Readonly<WorkflowConfigFile>;

export const CONFIG_SCHEMA: JSONSchema7 = {
  type: "object",
  additionalProperties: false,
  properties: {
    userDir: { type: "string" },
    projectDir: { type: "string" },
    maxConcurrency: { type: ["integer", "null"], minimum: 1 },
    maxLifetimeAgents: { type: "integer", minimum: 1 },
    timeoutMs: { type: "integer", minimum: 1000 },
    workerGracefulShutdownMs: { type: "integer", minimum: 0 },
    metaParse: {
      type: "object",
      additionalProperties: false,
      properties: {
        maxFileBytes: { type: "integer", minimum: 1024 },
      },
    },
  },
};
