export interface SkillManifest {
  name: string;
  description: string;
  /** Cached estimate, in tokens, used by budgeting code. */
  tokens?: number;
  /** Absolute filesystem path to the skill's root directory, when the skill has one.
   *  When set, llm-skills' load_skill handler prepends "Base directory for this skill: <baseDir>\n\n"
   *  to the returned body so the LLM can resolve relative references inside the skill body. */
  baseDir?: string;
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
