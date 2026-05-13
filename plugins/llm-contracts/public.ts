// Public type surface for llm-contracts.
// Each Phase 2 task adds one export line corresponding to its migrated contract.
export type { Vocab, EventName } from "./contracts/events";
export type {
  ChatMessage,
  ToolCall,
  ToolSchema,
  ModelInfo,
  LLMRequest,
  LLMResponse,
  LLMStreamEvent,
  LLMCompleteService,
} from "./contracts/llm-complete";
export type { SessionsStoreService, SessionRecord, TurnHandle, EventLogEntry } from "./contracts/sessions-store";
export type { ToolsRegistryService, ToolHandler, ToolExecutionContext } from "./contracts/tools-registry";
export { CANCEL_TOOL } from "./contracts/tools-registry";
export type { SystemPromptService, SystemPromptSection, RegisteredSection } from "./contracts/prompt-registry";
export type {
  SlashRegistryService,
  SlashCommandContext,
  SlashCommandHandler,
  SlashCommandManifest,
  SlashRegistryEntry,
  RegistryEntry,
} from "./contracts/slash-registry";
export type { SkillsRegistryService, SkillManifest, SkillRescanResult } from "./contracts/skills-registry";
export type { MemoryStoreService, MemoryEntry, MemoryType, MemoryScope } from "./contracts/memory-store";
export type { AgentsRegistryService, AgentManifest } from "./contracts/agents-registry";
export type { McpBridgeService, ServerInfo, ServerStatus } from "./contracts/mcp-bridge";
export type { ToolDispatchStrategy, ToolDispatchRegistry } from "./contracts/dispatch";
