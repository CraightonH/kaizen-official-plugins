export interface CodeModeConfig {
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxReturnBytes?: number;
  maxBlocksPerResponse?: number;
  sandbox?: "bun-worker";
}
