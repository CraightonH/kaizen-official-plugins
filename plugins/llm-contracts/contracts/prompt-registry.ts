export interface SystemPromptSection {
  id: string;
  priority: number;
  render(): string | Promise<string>;
  title?: string;
}

export interface RegisteredSection {
  unregister(): void;
  bumpGeneration(): void;
}

export interface SystemPromptService {
  register(section: SystemPromptSection): RegisteredSection;
  assemble(): Promise<string>;
  list(): ReadonlyArray<{ id: string; priority: number; title?: string }>;
  generation(): number;
}

export const CONTRACT_ID = "prompt:registry" as const;
export const DESCRIPTION = "System prompt section registry — plugins register prompt contributors; consumers assemble the final prompt.";
