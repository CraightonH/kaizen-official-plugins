import type { FieldSchema } from "llm-contracts/public";
import type { McpBridgeConfig } from "./public.d.ts";

// Defaults + schema for the `llm-mcp-bridge` section of the harness config
// file. Pure module: no I/O, no ctx.
//
// The `servers` map is the only knob. Each entry mirrors Claude Code's MCP
// config shape (`transport`, `command`, `args`, `env`, `cwd`, `url`,
// `headers`, …) so users can copy entries between tools verbatim. The schema
// declares the typed fields the store will validate; `additionalProperties:
// true` keeps unknown keys (e.g. transport-specific extras) flowing through
// to `resolveServers` without complaint.

export const DEFAULT_CONFIG: McpBridgeConfig = Object.freeze({
  servers: {},
}) as McpBridgeConfig;

// Plain Record over the McpBridgeConfig keys — compiles whether or not
// ConfigSchema<T> is generic in the contracts module. Matches the llm-axioms
// canonical reference.
export const CONFIG_SCHEMA: Record<keyof McpBridgeConfig, FieldSchema> = {
  servers: {
    type: "object",
    properties: {},
    additionalProperties: {
      type: "object",
      properties: {
        transport: { type: "enum", values: ["stdio", "sse", "http"] },
        enabled: { type: "boolean" },
        timeoutMs: { type: "number", min: 1 },
        healthCheckMs: { type: "number", min: 1 },
      },
      additionalProperties: true,
    },
  },
};
