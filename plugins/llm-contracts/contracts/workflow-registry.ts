export interface WorkflowPhase {
  title: string;
  detail?: string;
  model?: string;
}

export interface WorkflowMeta {
  name: string;
  description: string;
  whenToUse?: string;
  phases?: WorkflowPhase[];
  model?: string;
}

export interface WorkflowManifest {
  meta: WorkflowMeta;
  source: string;
  sourcePath?: string;
  scope?: "user" | "project" | "runtime";
}

export interface RunOptions {
  args?: unknown;
  parentTurnId?: string;
  signal?: AbortSignal;
}

export interface RunResult {
  runId: string;
  ok: boolean;
  value?: unknown;
  error?: { name: string; message: string };
  tokensSpent: number;
  agentCount: number;
  durationMs: number;
}

export interface WorkflowRegistryService {
  list(): WorkflowManifest[];
  get(name: string): WorkflowManifest | undefined;
  register(manifest: WorkflowManifest): () => void;
  runInline(script: string, opts?: RunOptions): Promise<RunResult>;
  runByName(name: string, opts?: RunOptions): Promise<RunResult>;
}

export const CONTRACT_ID = "workflow:registry" as const;
export const DESCRIPTION = "Workflow registry — runs sandboxed multi-agent orchestration scripts (inline or named-on-disk).";
