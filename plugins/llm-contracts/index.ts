import type { KaizenPlugin } from "kaizen/types";
import * as eventsContract from "./contracts/events";
import * as llmCompleteContract from "./contracts/llm-complete";
import * as sessionsStoreContract from "./contracts/sessions-store";
import * as toolsRegistryContract from "./contracts/tools-registry";
import * as promptRegistryContract from "./contracts/prompt-registry";
import * as slashRegistryContract from "./contracts/slash-registry";
import * as skillsRegistryContract from "./contracts/skills-registry";
import * as memoryStoreContract from "./contracts/memory-store";
import * as agentsRegistryContract from "./contracts/agents-registry";
import * as mcpBridgeContract from "./contracts/mcp-bridge";
import * as dispatchContract from "./contracts/dispatch";
import * as uiChannelContract from "./contracts/ui-channel";
import * as uiThemeContract from "./contracts/ui-theme";
import * as uiStatusContract from "./contracts/ui-status";
import * as uiCompletionContract from "./contracts/ui-completion";
import * as uiToolRendererContract from "./contracts/ui-tool-renderer";
import * as driverContract from "./contracts/driver";

const plugin: KaizenPlugin = {
  name: "llm-contracts",
  apiVersion: "3.0.0",
  permissions: { tier: "unscoped" },
  services: { provides: [], consumes: [] },

  async setup(ctx) {
    ctx.defineService(eventsContract.CONTRACT_ID, { description: eventsContract.DESCRIPTION });
    ctx.defineService(llmCompleteContract.CONTRACT_ID, { description: llmCompleteContract.DESCRIPTION });
    ctx.defineService(sessionsStoreContract.CONTRACT_ID, { description: sessionsStoreContract.DESCRIPTION });
    ctx.defineService(toolsRegistryContract.CONTRACT_ID, { description: toolsRegistryContract.DESCRIPTION });
    ctx.defineService(promptRegistryContract.CONTRACT_ID, { description: promptRegistryContract.DESCRIPTION });
    ctx.defineService(slashRegistryContract.CONTRACT_ID, { description: slashRegistryContract.DESCRIPTION });
    ctx.defineService(skillsRegistryContract.CONTRACT_ID, { description: skillsRegistryContract.DESCRIPTION });
    ctx.defineService(memoryStoreContract.CONTRACT_ID, { description: memoryStoreContract.DESCRIPTION });
    ctx.defineService(agentsRegistryContract.CONTRACT_ID, { description: agentsRegistryContract.DESCRIPTION });
    ctx.defineService(mcpBridgeContract.CONTRACT_ID, { description: mcpBridgeContract.DESCRIPTION });
    ctx.defineService(dispatchContract.CONTRACT_ID, { description: dispatchContract.DESCRIPTION });
    ctx.defineService(uiChannelContract.CONTRACT_ID, { description: uiChannelContract.DESCRIPTION });
    ctx.defineService(uiThemeContract.CONTRACT_ID, { description: uiThemeContract.DESCRIPTION });
    ctx.defineService(uiStatusContract.CONTRACT_ID, { description: uiStatusContract.DESCRIPTION });
    ctx.defineService(uiCompletionContract.CONTRACT_ID, { description: uiCompletionContract.DESCRIPTION });
    ctx.defineService(uiToolRendererContract.CONTRACT_ID, { description: uiToolRendererContract.DESCRIPTION });
    ctx.defineService(driverContract.CONTRACT_ID, { description: driverContract.DESCRIPTION });
  },
};

export default plugin;
