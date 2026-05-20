export interface GitSnapshot {
  isRepo: boolean;
  branch?: string;
}

export interface EnvironmentSnapshot {
  cwd: string;
  platform: string;
  git: GitSnapshot;
}
