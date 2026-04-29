import React from "react";
import { render } from "ink";
import type { KaizenPlugin } from "kaizen/types";
import type { UiChannel } from "./public.d.ts";
import { TuiStore } from "./state/store.ts";
import { App } from "./ui/App.tsx";
import { createFallbackChannel } from "./fallback.ts";

const plugin: KaizenPlugin = {
  name: "claude-tui",
  apiVersion: "3.0.0",
  permissions: { tier: "unscoped" },
  services: {
    provides: ["claude-tui:channel"],
    consumes: ["claude-events:vocabulary"],
  },

  async setup(ctx) {
    ctx.consumeService("claude-events:vocabulary");
    ctx.defineService("claude-tui:channel", { description: "Terminal UI channel: input + output + status bar." });

    const isTTY = !!(process.stdout.isTTY && process.stdin.isTTY);

    if (!isTTY) {
      const channel = createFallbackChannel();
      ctx.provideService<UiChannel>("claude-tui:channel", channel);
      ctx.on("status:item-update", async () => {});
      ctx.on("status:item-clear", async () => {});
      return;
    }

    const store = new TuiStore();

    const onCtrlC = () => {
      if (store.snapshot().busy.on) {
        ctx.emit("turn:cancel").catch(() => {});
      } else {
        process.exit(0);
      }
    };

    const inkApp = render(<App store={store} onCtrlC={onCtrlC} />);

    ctx.on("status:item-update", async (payload: any) => {
      if (!payload?.id) return;
      store.upsertStatus({
        id: payload.id,
        text: payload.content ?? "",
        tone: payload.tone,
        priority: payload.priority,
      });
    });
    ctx.on("status:item-clear", async (payload: any) => {
      if (!payload?.id) return;
      store.clearStatus(payload.id);
    });

    const channel: UiChannel = {
      readInput: () => store.awaitInput(),
      writeOutput: (chunk: string) => store.appendOutput(chunk),
      writeNotice: (line: string) => store.appendNotice(line),
      setBusy: (busy: boolean, message?: string) => store.setBusy(busy, message),
    };

    ctx.provideService<UiChannel>("claude-tui:channel", channel);

    (plugin as any).__ink = inkApp;
  },

  async stop() {
    const inkApp = (plugin as any).__ink;
    if (inkApp) {
      try { inkApp.unmount(); } catch { /* ignore */ }
    }
  },
};

export default plugin;
