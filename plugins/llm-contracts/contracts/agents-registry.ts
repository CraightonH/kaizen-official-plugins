export interface AgentManifest {
  name: string;
  description: string;
  systemPrompt: string;
  /** Restricts the tool view available to this agent's nested driver runs. */
  toolFilter?: {
    tags?: string[];
    names?: string[];
    excludeTags?: string[];
    excludeNames?: string[];
  };
}

export interface AgentsRegistryService {
  list(): AgentManifest[];
  register(manifest: AgentManifest): () => void;
}

export const CONTRACT_ID = "agents:registry" as const;
export const DESCRIPTION = "Agent manifest registry — subagent definitions discoverable by drivers.";
