import type { KaizenPlugin } from "kaizen/types";
import { EVENTS } from "core-events";
import type { UserMessageContext, ResponseContext } from "core-events";

const plugin: KaizenPlugin = {
  name: "timestamps",
  apiVersion: "2.0.0",
  permissions: {
    tier: "scoped",
    events: { subscribe: ["session:*"] },
  },
  capabilities: { consumes: ["core-lifecycle:lifecycle.drive", "core-events:service"] },

  async setup(ctx) {
    ctx.on(EVENTS.USER_MESSAGE, async (payload) => {
      const msg = payload as UserMessageContext;
      msg.content = `[${new Date().toISOString()}] ${msg.content}`;
    });

    ctx.on(EVENTS.AGENT_RESPONSE, async (payload) => {
      const msg = payload as ResponseContext;
      msg.content = `[${new Date().toISOString()}] ${msg.content}`;
    });
  },
};

export default plugin;
