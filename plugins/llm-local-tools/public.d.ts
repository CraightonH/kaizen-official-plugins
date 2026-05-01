// plugins/llm-local-tools/public.d.ts
export type { ToolSchema, ToolCall } from "llm-events/public";

export const TOOL_NAMES: readonly [
  "read", "write", "create", "edit", "glob", "grep", "bash"
];
