export interface SkillManifest {
  name: string;
  description: string;
  /** Cached estimate, in tokens, used by budgeting code. */
  tokens?: number;
}

export interface SkillRescanResult {
  changed: boolean;
  count: number;
}

export interface SkillsRegistryService {
  list(): SkillManifest[];
  /** Returns the body to inject into the system prompt. */
  load(name: string): Promise<string>;
  register(manifest: SkillManifest, loader: () => Promise<string>): () => void;
  /** Re-discover file-backed skills; used by `/skills reload`. */
  rescan(): Promise<SkillRescanResult>;
}

export const CONTRACT_ID = "skills:registry" as const;
export const DESCRIPTION = "Skills registry — skill discovery, on-demand loading, manifest listing.";
