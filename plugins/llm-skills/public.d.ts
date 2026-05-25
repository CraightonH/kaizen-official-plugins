// llm-skills public surface.
// Contract types are now owned by llm-contracts; re-exported here for
// backwards-compatibility with consumers that import from llm-skills/public.
export type { SkillManifest, SkillRescanResult, SkillsRegistryService } from "llm-contracts/public";

/** Plugin-private configuration shape. Routed through `config:store`. */
export interface LlmSkillsConfig {
  /** User-scope skills root. Leading `~/` is expanded to $HOME. Default: `~/.kaizen/skills`. */
  userRoot: string;
  /** Min ms between `turn:start`-driven rescans. Default: 30000. Values ≤ 0 fall back to the default at runtime. */
  rescanIntervalMs: number;
}
