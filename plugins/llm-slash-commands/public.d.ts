export type {
  SlashCommandContext,
  SlashCommandHandler,
  SlashCommandManifest,
  SlashRegistryService,
  SlashRegistryEntry,
  RegistryEntry,
} from "llm-contracts/public";
export {
  BareNamePluginError,
  ReentrantSlashEmitError,
  DuplicateRegistrationError,
  InvalidNameError,
} from "./errors";

// Plugin-private config shape used with config:store. Not consumed by other
// plugins; exported here so it can be imported across this plugin's modules.
export interface SlashCommandsConfig {
  userDir: string;
  projectDir: string;
}
