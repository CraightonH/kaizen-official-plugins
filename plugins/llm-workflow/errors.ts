function makeError(name: string) {
  return class extends Error {
    constructor(message: string) { super(message); this.name = name; }
  };
}
export const MetaParseError = makeError("MetaParseError");
export const WorkerSpawnError = makeError("WorkerSpawnError");
export const ScriptError = makeError("ScriptError");
export const WorkflowTimeoutError = makeError("WorkflowTimeoutError");
export const WorkflowAbortedError = makeError("WorkflowAbortedError");
export const WorkflowNestingError = makeError("WorkflowNestingError");
export const AgentLifetimeCapError = makeError("AgentLifetimeCapError");
export const BudgetExceededError = makeError("BudgetExceededError");
export const WorkflowRegistryLoadingError = makeError("WorkflowRegistryLoadingError");
export const WorkflowNotFoundError = makeError("WorkflowNotFoundError");
