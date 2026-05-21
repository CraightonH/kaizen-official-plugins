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
export type { ToolsRegistryService, ToolHandler, ToolExecutionContext, ToolBeforeExecutePayload } from "./contracts/tools-registry";
export { CANCEL_TOOL } from "./contracts/tools-registry";
export type { SystemPromptService, SystemPromptSection, RegisteredSection } from "./contracts/prompt-registry";
export type {
  SlashRegistryService,
  SlashCommandContext,
  SlashCommandHandler,
  SlashPrintOptions,
  SlashCommandManifest,
  SlashRegistryEntry,
  RegistryEntry,
} from "./contracts/slash-registry";
export type { SkillsRegistryService, SkillManifest, SkillRescanResult } from "./contracts/skills-registry";
export type { MemoryStoreService, MemoryEntry, MemoryType, MemoryScope } from "./contracts/memory-store";
export type { AgentsRegistryService, AgentManifest } from "./contracts/agents-registry";
export type { McpBridgeService, ServerInfo, ServerStatus } from "./contracts/mcp-bridge";
export type { AxiomsRegistryService, AxiomEntry } from "./contracts/axioms-registry";
export type { ToolDispatchStrategy, ToolDispatchRegistry } from "./contracts/dispatch";
export type { UiChannelService, WriteOptions } from "./contracts/ui-channel";
export type { UiTheme, UiThemeService } from "./contracts/ui-theme";
export type { UiStatusService } from "./contracts/ui-status";
export type { UiCompletionService, CompletionItem, CompletionSource } from "./contracts/ui-completion";
export type { UiToolRenderer, UiToolRendererService, ToolCallStatus } from "./contracts/ui-tool-renderer";
export type {
  UiPromptService,
  UiPromptOption,
  UiPromptOptionsRequest,
  UiPromptTextRequest,
} from "./contracts/ui-prompt";
export type { DriverService, RunConversationInput, RunConversationOutput } from "./contracts/driver";
export type {
  ConfigStoreService,
  ConfigSpec,
  ConfigSchema,
  ConfigScope,
  ConfigStatus,
  ConfigResolutionSource,
  FieldSchema,
} from "./contracts/config-store";
