import type { WorkflowCallPayload } from "../rpc-types.ts";
import { WorkflowNestingError } from "../errors.ts";

export interface WorkflowCallDeps {
  depth: number;
  runChildWorkflow: (nameOrRef: string | { scriptPath: string }, args: unknown) => Promise<unknown>;
}

export function makeWorkflowCallback(deps: WorkflowCallDeps): (p: WorkflowCallPayload) => Promise<unknown> {
  return async (p) => {
    if (deps.depth >= 1) {
      throw new WorkflowNestingError("nested workflow() depth > 1 is not allowed in v1");
    }
    return deps.runChildWorkflow(p.nameOrRef, p.args);
  };
}
