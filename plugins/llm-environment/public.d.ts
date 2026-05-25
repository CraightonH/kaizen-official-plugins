export interface GitSnapshot {
  isRepo: boolean;
  branch?: string;
}

export interface EnvironmentSnapshot {
  cwd: string;
  platform: string;
  git: GitSnapshot;
}

// Plugin-internal config shape. Consumed only by config:store.register and
// the plugin's own setup; never crosses other plugin boundaries.
export interface LlmEnvironmentConfig {
  enabled: boolean;
}
