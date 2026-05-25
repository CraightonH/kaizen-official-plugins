export type { SessionsStoreService, SessionRecord, TurnHandle, EventLogEntry } from "llm-contracts/public";
export { harnessKey } from "./harness-key";

// Plugin-private config type — co-located here to mirror the canonical
// llm-axioms layout. Not re-exported via the package `./public` entry except
// as part of this module's ambient declarations.
export interface SessionManagerConfig {
  sessionsBase: string;
}
