export type { SystemPromptService, SystemPromptSection, RegisteredSection } from "llm-contracts/public";

// Plugin-internal config shape. Consumed only by config:store.register and
// the plugin's own setup; never crosses other plugin boundaries.
export interface LlmSystemPromptConfig {
  /**
   * Identity section enabled. `false` reproduces the legacy
   * KAIZEN_SYSTEM_PROMPT_DISABLE=1 behavior — identity renders as "" and
   * the assembler drops the section.
   */
  enabled: boolean;

  /**
   * Path to the global identity markdown file. Tilde (`~`) is expanded
   * to the user's home directory. Defaults to `~/.kaizen/system-prompt.md`.
   */
  globalPath: string;

  /**
   * Path to the project identity markdown file. Tilde and relative paths
   * are resolved against the harness cwd. Defaults to
   * `./.kaizen/system-prompt.md` (project root convention).
   */
  projectPath: string;

  /**
   * Heading inserted between the global and project bodies when both
   * files exist. Cosmetic; rarely changed. Empty string drops the heading.
   */
  projectHeader: string;

  /**
   * Prefix sentence used in the built-in fallback prompt when neither
   * identity file exists. The runtime appends ` Today is <YYYY-MM-DD>.`
   * plus the rest of the fallback template.
   */
  fallbackPrefix: string;
}
