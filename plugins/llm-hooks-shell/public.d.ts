export interface HookEntry {
  event: string;
  command: string;
  cwd?: string;
  block_on_nonzero?: boolean;
  timeout_ms?: number;
  env?: Record<string, string>;
}

export interface HooksConfig {
  hooks: HookEntry[];
  defaultTimeoutMs: number;
  depthCap: number;
}
