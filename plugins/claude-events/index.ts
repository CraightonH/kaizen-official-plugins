import type { KaizenPlugin } from "kaizen/types";
import type { Vocab } from "./public";

export const VOCAB: Vocab = Object.freeze({
  SESSION_START: "session:start",
  SESSION_END: "session:end",
  SESSION_ERROR: "session:error",
  TURN_BEFORE: "turn:before",
  TURN_AFTER: "turn:after",
  TURN_CANCEL: "turn:cancel",
  STATUS_ITEM_UPDATE: "status:item-update",
  STATUS_ITEM_CLEAR: "status:item-clear",
} as const);

const plugin: KaizenPlugin = {
  name: "claude-events",
  apiVersion: "3.0.0",
  permissions: { tier: "trusted" },
  services: { provides: ["claude-events:vocabulary"] },

  async setup(ctx) {
    ctx.defineService("claude-events:vocabulary", {
      description: "Event-name vocabulary for the claude-wrapper harness.",
    });
    ctx.provideService<Vocab>("claude-events:vocabulary", VOCAB);
    for (const name of Object.values(VOCAB)) ctx.defineEvent(name);
    ctx.log("claude-events ready");
  },
};

export default plugin;
