import React from "react";
import { render } from "ink";
import type { KaizenPlugin } from "kaizen/types";
import type {
  TuiChannelService,
  TuiCompletionService,
  TuiStatusService,
  TuiThemeService,
} from "./public.d.ts";
import { TuiStore } from "./state/store.ts";
import { makeCompletionRegistry } from "./completion/registry.ts";
import { loadTheme, realThemeDeps, type TuiTheme } from "./theme/loader.ts";
import { App } from "./ui/App.tsx";
import { createFallbackChannel } from "./fallback.ts";

const plugin: KaizenPlugin = {
  name: "llm-tui",
  apiVersion: "3.0.0",
  permissions: { tier: "unscoped" },
  services: {
    provides: ["llm-tui:channel", "llm-tui:completion", "llm-tui:status", "llm-tui:theme"],
    consumes: ["llm-events:vocabulary"],
  },

  async setup(ctx) {
    ctx.consumeService("llm-events:vocabulary");
    ctx.defineService("llm-tui:channel", { description: "Pull-style chat I/O channel." });
    ctx.defineService("llm-tui:completion", { description: "Registry of completion sources for the input popup." });
    ctx.defineService("llm-tui:status", { description: "Marker service: subscribes to status:item-* and renders the bar." });
    ctx.defineService("llm-tui:theme", { description: "Read-only theme tokens." });

    // Theme: harness defaults from plugin config, user override from config file.
    const harnessDefaults = (ctx.config as any)?.theme as Partial<TuiTheme> | undefined;
    const theme = await loadTheme(realThemeDeps(ctx.log, harnessDefaults));
    const themeService: TuiThemeService = { current: () => theme };
    ctx.provideService<TuiThemeService>("llm-tui:theme", themeService);

    // Status bar: marker service, but also publish the empty value so consumers can wire dependencies.
    const statusService: TuiStatusService = {};
    ctx.provideService<TuiStatusService>("llm-tui:status", statusService);

    // Store + completion registry are shared between the channel + UI.
    const store = new TuiStore();
    const registry = makeCompletionRegistry();
    ctx.provideService<TuiCompletionService>("llm-tui:completion", registry.service);

    // Triggers are derived from registered sources. We track the set live by
    // wrapping register() so the InputBox always sees the current trigger map
    // without re-rendering on every registration.
    const triggers = new Set<string>();
    const refCount = new Map<string, number>();
    const origRegister = registry.service.register;
    registry.service.register = (source) => {
      triggers.add(source.trigger);
      refCount.set(source.trigger, (refCount.get(source.trigger) ?? 0) + 1);
      const off = origRegister(source);
      return () => {
        off();
        const n = (refCount.get(source.trigger) ?? 1) - 1;
        if (n <= 0) {
          refCount.delete(source.trigger);
          triggers.delete(source.trigger);
        } else {
          refCount.set(source.trigger, n);
        }
      };
    };

    // Reasoning events → live thinking buffer; finalize when the LLM call ends.
    ctx.on("llm:reasoning", async (payload: any) => {
      const delta = typeof payload?.delta === "string" ? payload.delta : "";
      if (delta) store.appendReasoning(delta);
    });
    ctx.on("llm:done", async () => {
      // Move accumulated reasoning into the transcript as a Thoughts block,
      // sitting between the user message and the assistant reply.
      store.finalizeReasoning();
    });
    ctx.on("turn:end", async () => {
      // Belt-and-suspenders: if a turn ended without an llm:done (e.g. tool
      // dispatch errored mid-stream), drop any in-flight reasoning so the
      // box doesn't linger above the next prompt.
      store.clearLiveThinking();
    });

    // Status events → store.
    ctx.on("status:item-update", async (payload: any) => {
      if (!payload || typeof payload.key !== "string") return;
      store.upsertStatus(payload.key, String(payload.value ?? ""));
    });
    ctx.on("status:item-clear", async (payload: any) => {
      if (!payload || typeof payload.key !== "string") return;
      store.clearStatus(payload.key);
    });

    const isTTY = !!(process.stdout.isTTY && process.stdin.isTTY);

    if (!isTTY) {
      const channel = createFallbackChannel();
      ctx.provideService<TuiChannelService>("llm-tui:channel", channel);
      return;
    }

    const onCtrlC = () => {
      if (store.snapshot().busy.active) {
        ctx.emit("turn:cancel").catch(() => {});
      } else {
        process.exit(0);
      }
    };

    // Hand the line to the driver via the readInput channel and let the
    // driver own the input:submit emit. Emitting it here too creates a
    // race: two parallel dispatches mean the slash-commands handler's
    // reentrancy guard rejects one, and the driver's `await emit()` may
    // return before the first dispatch fires `input:handled`, sending
    // the slash command on to the LLM instead of short-circuiting.
    const onSubmit = (text: string) => {
      store.submit(text);
    };

    const inkApp = render(
      <App
        store={store}
        registry={registry}
        triggers={triggers}
        theme={theme}
        onSubmit={onSubmit}
        onCtrlC={onCtrlC}
      />,
    );

    const channel: TuiChannelService = {
      readInput: () => store.awaitInput(),
      writeOutput: (chunk: string) => store.appendOutput(chunk),
      writeNotice: (text: string) => store.appendNotice(text),
      writeUser: (text: string) => store.appendUser(text),
      setBusy: (busy: boolean, message?: string) => store.setBusy(busy, message),
      appendReasoning: (delta: string) => store.appendReasoning(delta),
      finalizeReasoning: () => store.finalizeReasoning(),
      clearLiveThinking: () => store.clearLiveThinking(),
    };
    ctx.provideService<TuiChannelService>("llm-tui:channel", channel);

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
