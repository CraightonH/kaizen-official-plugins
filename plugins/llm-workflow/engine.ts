import type { WorkflowRegistryService, RunOptions, RunResult, WorkflowManifest } from "llm-contracts/public";
import type { RegistryHandle } from "./registry.ts";
import type { Runner } from "./runner.ts";
import { WorkflowNotFoundError, WorkflowRegistryLoadingError } from "./errors.ts";

export interface EngineDeps {
  registry: RegistryHandle;
  runner: Runner;
  isReady: () => boolean;
}

export function makeEngine(deps: EngineDeps): WorkflowRegistryService {
  return {
    list() { return deps.registry.service.list(); },
    get(name) { return deps.registry.service.get(name); },
    register(manifest: WorkflowManifest) { return deps.registry.service.register(manifest); },

    async runInline(script, opts: RunOptions = {}) {
      return deps.runner.runInline(script, { args: opts.args, signal: opts.signal });
    },

    async runByName(name, opts: RunOptions = {}) {
      if (!deps.isReady()) {
        const e = new WorkflowRegistryLoadingError("workflow registry still loading; retry");
        return { runId: "<unstarted>", ok: false, error: { name: e.name, message: e.message }, tokensSpent: 0, agentCount: 0, durationMs: 0 };
      }
      const manifest = deps.registry.service.get(name);
      if (!manifest) {
        const e = new WorkflowNotFoundError(`workflow '${name}' not found`);
        return { runId: "<unstarted>", ok: false, error: { name: e.name, message: e.message }, tokensSpent: 0, agentCount: 0, durationMs: 0 };
      }
      return deps.runner.runManifest(manifest, { args: opts.args, signal: opts.signal });
    },
  };
}
