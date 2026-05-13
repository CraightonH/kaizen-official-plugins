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
  },
};

export default plugin;
