// llm-agents public surface.
// Types are defined in llm-contracts and re-exported here for consumers
// that import from llm-agents/public.
export type { AgentManifest, AgentsRegistryService } from "llm-contracts/public";

// Plugin-internal config contract — consumed via `config:store`.
// Not exported through llm-contracts; other plugins should not import this.
export interface AgentsConfigFile {
  maxDepth?: number;
  userDir?: string;
  projectDir?: string;
}
