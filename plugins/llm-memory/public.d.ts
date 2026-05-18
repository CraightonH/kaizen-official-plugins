export type { MemoryType, MemoryScope, MemoryEntry, MemoryStoreService } from "llm-contracts/public";

import type { MemoryType } from "llm-contracts/public";

// Plugin-internal config contract — consumed via `config:store`.
// Not exported through llm-contracts; other plugins should not import this.
export interface MemoryConfig {
  globalDir: string | null;          // null = default (<home>/.kaizen/memory)
  projectDir: string | null;         // null disables project layer
  injectionByteCap: number;
  autoExtract: boolean;
  extractTriggers: string[];
  denyTypes: MemoryType[];
  staleTempMs: number;               // sweeper threshold
}
