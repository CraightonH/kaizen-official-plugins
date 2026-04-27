import type { KaizenPlugin } from "kaizen/types";
import type { UiChannel } from "../claude-tui/public";
import { runTurn } from "./loop.ts";
import { realSpawner } from "./spawn.ts";
import { pickBusyMessage } from "./busy-messages.ts";

const plugin: KaizenPlugin = {
  name: "claude-driver",
  apiVersion: "3.0.0",
  driver: true,
  permissions: { tier: "unscoped" },
  services: { consumes: ["claude-events:vocabulary", "ui:channel"] },

  async setup(ctx) {
    ctx.consumeService("claude-events:vocabulary");
    ctx.consumeService("ui:channel");
    ctx.log("claude-driver setup complete");
  },

  async start(ctx) {
    const ui = ctx.useService<UiChannel>("ui:channel");
    let sessionId: string | null = null;
    const cancelController = { current: null as AbortController | null };

    ctx.on("turn:cancel", async () => {
      cancelController.current?.abort();
    });

    await ctx.emit("session:start");
    try {
      while (true) {
        const line = await ui.readInput();
        if (line === "") break;

        await ctx.emit("turn:before", { prompt: line });
        ui.setBusy(true, pickBusyMessage());
        const ac = new AbortController();
        cancelController.current = ac;
        try {
          const r = await runTurn({
            prompt: line,
            hasSession: sessionId !== null,
            spawner: realSpawner,
            writeOutput: (chunk) => ui.writeOutput(chunk),
            emit: ctx.emit.bind(ctx),
            log: ctx.log.bind(ctx),
            cancelSignal: ac.signal,
          });
          if (r.cancelled) {
            ui.writeNotice("↯ cancelled");
            sessionId = null; // start fresh next turn
          } else if (r.exitCode !== 0) {
            await ctx.emit("session:error", { message: `claude exited ${r.exitCode}` });
            sessionId = null;
          } else if (r.sessionId) {
            sessionId = r.sessionId;
          }
        } catch (err) {
          await ctx.emit("session:error", { message: (err as Error).message });
          sessionId = null;
        } finally {
          cancelController.current = null;
          ui.setBusy(false);
        }
      }
    } finally {
      await ctx.emit("session:end");
    }
  },
};

export default plugin;
