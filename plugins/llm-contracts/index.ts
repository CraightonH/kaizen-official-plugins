import type { KaizenPlugin } from "kaizen/types";
import * as eventsContract from "./contracts/events";
import * as llmCompleteContract from "./contracts/llm-complete";

const plugin: KaizenPlugin = {
  name: "llm-contracts",
  apiVersion: "3.0.0",
  permissions: { tier: "unscoped" },
  services: { provides: [], consumes: [] },

  async setup(ctx) {
    ctx.defineService(eventsContract.CONTRACT_ID, { description: eventsContract.DESCRIPTION });
    ctx.defineService(llmCompleteContract.CONTRACT_ID, { description: llmCompleteContract.DESCRIPTION });
  },
};

export default plugin;
