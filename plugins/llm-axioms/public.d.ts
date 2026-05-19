// Re-export the cross-plugin contract types from llm-contracts.
export type { AxiomEntry, AxiomsRegistryService } from "llm-contracts/public";

// Plugin-internal config shape. Consumed only by config:store.register and
// the plugin's own setup; never crosses other plugin boundaries.
export interface AxiomsConfig {
  axiomsDir: string;
  injectionByteCap: number;
  methodologyEnabled: boolean;
  workspaceEnabled: boolean;
  staleTempMs: number;
}
