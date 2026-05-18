// Public types for the llm-codemode plugin.
//
// These are plugin-internal contract types — not exported into
// `llm-contracts`. Other plugins should not import from here.

export interface CodeModeConfig {
  timeoutMs: number;
  maxStdoutBytes: number;
  maxReturnBytes: number;
  sandbox: "bun-worker";
}
