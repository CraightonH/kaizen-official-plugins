import type { KaizenPlugin } from "kaizen/types";

export const VOCAB = Object.freeze({
  SESSION_START: "session:start",
  SESSION_END: "session:end",
  SESSION_ERROR: "session:error",
  INPUT_RECEIVED: "input:received",
  SHELL_BEFORE: "shell:before",
  SHELL_AFTER: "shell:after",
} as const);

export type Vocab = typeof VOCAB;
export type EventName = Vocab[keyof Vocab];

const plugin: KaizenPlugin = {
  name: "events",
  apiVersion: "2.0.0",
  permissions: { tier: "trusted" },
  services: { provides: ["events:vocabulary"] },

  async setup(ctx) {
    ctx.defineService("events:vocabulary", {
      description: "Canonical event-name vocabulary for the minimum shell harness.",
    });
    ctx.provideService<Vocab>("events:vocabulary", VOCAB);
    for (const name of Object.values(VOCAB)) ctx.defineEvent(name);
    ctx.log("events setup complete");
  },
};

export default plugin;
