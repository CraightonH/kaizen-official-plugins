import type { KaizenPlugin } from "kaizen/types";
import * as eventsContract from "./contracts/events";

const plugin: KaizenPlugin = {
  name: "llm-contracts",
  apiVersion: "3.0.0",
  permissions: { tier: "unscoped" },
  services: { provides: [], consumes: [] },

  async setup(ctx) {
    ctx.defineService(eventsContract.CONTRACT_ID, { description: eventsContract.DESCRIPTION });
  },
};

export default plugin;
