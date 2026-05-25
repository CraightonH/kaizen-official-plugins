// plugins/llm-local-tools/public.d.ts
export type { ToolSchema, ToolCall } from "llm-contracts/public";

export const TOOL_NAMES: readonly [
  "read", "write", "create", "edit", "glob", "grep", "bash", "web_fetch"
];

/**
 * Plugin-private config surface registered with `config:store`.
 * All values are bounded positive integers; see config.ts for schema bounds.
 */
export interface LlmLocalToolsConfig {
  // read
  readMaxBytes: number;       // hard refusal threshold for `read`
  readCapBytes: number;       // truncation cap on returned `read` body
  readCapLines: number;       // line cap + default `limit` for `read`
  // bash
  bashOutputCap: number;      // bash output middle-truncation threshold
  bashDefaultTimeoutMs: number; // default `timeout` when caller omits it
  // grep
  grepDefaultMax: number;     // default `max_results` when caller omits it
  // glob
  globCap: number;            // hard cap on glob result count
  // web_fetch
  webFetchCapBytes: number;            // default in-context body cap
  webFetchDownloadCapBytes: number;    // hard cap on `save_to` file size
  webFetchDefaultTimeoutMs: number;    // default `timeout_ms` when caller omits it
}
