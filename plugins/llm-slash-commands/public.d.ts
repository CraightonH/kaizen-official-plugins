export type {
  SlashCommandContext,
  SlashCommandHandler,
  SlashCommandManifest,
  SlashRegistryService,
  RegistryEntry,
} from "./registry";
export {
  BareNamePluginError,
  ReentrantSlashEmitError,
  DuplicateRegistrationError,
  InvalidNameError,
} from "./errors";
export type { CompletionItem, CompletionSource } from "./completion";
