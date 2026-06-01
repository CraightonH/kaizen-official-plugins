// Implementation-internal public surface for llm-workflow.
// Cross-plugin contract types live in llm-contracts/public.

export interface WorkflowConfigFile {
  userDir: string;
  projectDir: string;
  maxConcurrency: number | null;
  maxLifetimeAgents: number;
  timeoutMs: number;
  workerGracefulShutdownMs: number;
  metaParse: {
    maxFileBytes: number;
  };
}

// Filled in by Task 4
// export {
//   MetaParseError,
//   WorkerSpawnError,
//   ScriptError,
//   WorkflowTimeoutError,
//   WorkflowAbortedError,
//   WorkflowNestingError,
//   AgentLifetimeCapError,
//   BudgetExceededError,
//   WorkflowRegistryLoadingError,
//   WorkflowNotFoundError,
// } from "./errors.ts";
