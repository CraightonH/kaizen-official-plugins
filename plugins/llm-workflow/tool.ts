import type { ToolSchema, ToolHandler, ToolExecutionContext } from "llm-contracts/public";
import type { WorkflowRegistryService } from "llm-contracts/public";

const DESCRIPTION = `Run a multi-agent workflow script.

Provide exactly one of:
- \`script\`: inline TypeScript source running in a sandboxed Bun Worker.
- \`name\`: a named workflow registered from ~/.kaizen/workflows or .kaizen/workflows.

Primitives available inside a workflow script (implicit globals):
  agent(prompt, opts?), parallel(thunks), pipeline(items, ...stages),
  phase(title), log(message), workflow(name, args), args, budget.

The script body is evaluated at the top level after \`export const meta = {...}\` is
extracted statically. \`meta\` must be a pure literal (no identifiers, function calls,
spreads, or template interpolation). Determinism guards: Date.now()/Math.random()/
argless new Date() throw inside the sandbox.

Result is a JSON-serialized RunResult ({runId, ok, value?, error?, tokensSpent, agentCount, durationMs}).`;

export interface WorkflowToolDeps {
  engine: Pick<WorkflowRegistryService, "runInline" | "runByName">;
}

export function makeWorkflowTool(deps: WorkflowToolDeps): { schema: ToolSchema; handler: ToolHandler } {
  const schema: ToolSchema = {
    name: "Workflow",
    description: DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        script: { type: "string", description: "Inline workflow source (TS)." },
        name: { type: "string", description: "Run a named workflow from the registry." },
        scriptPath: { type: "string", description: "Reserved for v1.1." },
        args: { description: "Args forwarded to the workflow as the `args` global." },
        title: { type: "string", description: "Ignored (CC parity)." },
        description: { type: "string", description: "Ignored (CC parity)." },
      },
    },
  } as ToolSchema;

  const handler: ToolHandler = async (rawArgs: unknown, _ctx: ToolExecutionContext) => {
    const args = (rawArgs ?? {}) as { script?: string; name?: string; scriptPath?: string; args?: unknown };
    if (args.scriptPath) {
      throw new Error("Workflow tool: `scriptPath` is reserved for v1.1; pass `name` or `script` instead.");
    }
    const provided = ["script", "name"].filter((k) => (args as any)[k] != null);
    if (provided.length !== 1) {
      throw new Error("Workflow tool: provide exactly one of {script, name}.");
    }
    const opts = { args: args.args };
    let result;
    if (args.script != null) result = await deps.engine.runInline(args.script, opts);
    else result = await deps.engine.runByName(args.name!, opts);
    return JSON.stringify(result);
  };

  return { schema, handler };
}
