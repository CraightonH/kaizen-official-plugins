import type { CodeModeConfig } from "./public.d.ts";

export const DEFAULT_CONFIG: CodeModeConfig = Object.freeze({
  timeoutMs: 30000,
  maxStdoutBytes: 16384,
  maxReturnBytes: 4096,
  sandbox: "bun-worker" as const,
});
