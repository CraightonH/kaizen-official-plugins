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
