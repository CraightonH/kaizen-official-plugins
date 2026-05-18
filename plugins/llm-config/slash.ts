// plugins/llm-config/slash.ts
// Task 8 stub — Task 9 will replace this with the full /config commands.
import type { ConfigStoreService, SlashRegistryService } from "llm-contracts/public";

export interface SlashDeps {
  store: ConfigStoreService;
  homePath: string;
  projectPath: string;
  harnessKey: string;
  editor: string;
  log: (msg: string) => void;
}

export function registerSlashCommands(
  _registry: SlashRegistryService,
  _deps: SlashDeps,
): Array<() => void> {
  return [];
}
