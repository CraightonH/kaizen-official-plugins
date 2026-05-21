import type { CompletionItem } from "./ui-completion";

export interface ArgSlot {
  name: string;
  description?: string;
  complete?: (prev: string[], query: string) =>
    Promise<CompletionItem[]> | CompletionItem[];
}

export interface SlashCommandFlag {
  name: string;            // e.g. "--project"
  description?: string;
}

export interface SlashPrintOptions {
  /**
   * When true, the print body is forwarded through the
   * conversation:system-message event with a markdown:true marker.
   * Subscribers that bridge into the UI (e.g., llm-driver → llm-tui)
   * use this to enable markdown rendering on the resulting notice.
   */
  markdown?: boolean;
}

export interface SlashCommandContext {
  args: string;
  raw: string;
  signal: AbortSignal;
  emit: (event: string, payload: unknown) => Promise<void>;
  print: (text: string, opts?: SlashPrintOptions) => Promise<void>;
}

export type SlashCommandHandler = (ctx: SlashCommandContext) => Promise<void>;

export interface SlashCommandManifest {
  name: string;
  description: string;
  usage?: string;
  source: "builtin" | "plugin" | "file";
  filePath?: string;
  arguments?: ArgSlot[];
  flags?: SlashCommandFlag[];
}

export interface SlashRegistryEntry {
  manifest: SlashCommandManifest;
  handler: SlashCommandHandler;
}

export type RegistryEntry = SlashRegistryEntry;

export interface SlashRegistryService {
  register(manifest: SlashCommandManifest, handler: SlashCommandHandler): () => void;
  get(name: string): SlashRegistryEntry | undefined;
  list(): SlashCommandManifest[];
}

export const CONTRACT_ID = "slash:registry" as const;
export const DESCRIPTION = "Slash-command registry — register, list, and dispatch user-typed slash commands.";
