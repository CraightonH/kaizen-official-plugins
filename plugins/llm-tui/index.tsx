import React from "react";
import { render } from "ink";
import type { KaizenPlugin } from "kaizen/types";
import type { UiChannelService, UiTheme, UiThemeService, UiStatusService, UiCompletionService } from "llm-contracts/public";
import { TuiStore } from "./state/store.ts";
import { makeCompletionRegistry } from "./completion/registry.ts";
import { makeToolRendererRegistry } from "./tool-renderers/registry.ts";
import type { TuiToolRendererService } from "./tool-renderers/registry.ts";
import { defaultRenderers } from "./tool-renderers/defaults.tsx";
import { loadTheme, realThemeDeps } from "./theme/loader.ts";
import { App } from "./ui/App.tsx";
import { createFallbackChannel } from "./fallback.ts";

const plugin: KaizenPlugin = {
  name: "llm-tui",
  apiVersion: "3.0.0",
  permissions: { tier: "unscoped" },
  services: {
    provides: ["ui:channel", "ui:completion-source", "ui:status", "ui:theme", "llm-tui:tool-renderer"],
    consumes: ["events:vocabulary"],
  },

  async setup(ctx) {
    ctx.consumeService("events:vocabulary");

    // Plugin-private control events (not in the shared VOCAB; owned by this
    // plugin per llm-events convention). Peers emit these to drive TUI state.
    ctx.defineEvent("tui:enter-history");

    // ui:channel is defined on llm-contracts; this plugin provides the implementation.
    // ui:completion-source is defined on llm-contracts; this plugin provides the implementation.
    // ui:status is defined on llm-contracts; this plugin provides the implementation.
    // ui:theme is defined on llm-contracts; this plugin provides the implementation.
    ctx.defineService("llm-tui:tool-renderer", { description: "Per-tool TUI rendering registry." });

    // Theme: harness defaults from plugin config, user override from config file.
    const harnessDefaults = (ctx.config as any)?.theme as Partial<UiTheme> | undefined;
    const theme = await loadTheme(realThemeDeps(ctx.log, harnessDefaults));
    const themeService: UiThemeService = { current: () => theme };
    ctx.provideService<UiThemeService>("ui:theme", themeService);

    // Status bar: marker service, but also publish the empty value so consumers can wire dependencies.
    const statusService: UiStatusService = {};
    ctx.provideService<UiStatusService>("ui:status", statusService);

    // Store + completion registry are shared between the channel + UI.
    const store = new TuiStore();
    const registry = makeCompletionRegistry();
    ctx.provideService<UiCompletionService>("ui:completion-source", registry.service);
    const toolRenderers = makeToolRendererRegistry();
    ctx.provideService<TuiToolRendererService>("llm-tui:tool-renderer", toolRenderers.service);
    // Built-in opt-in renderers for common local tools (edit, write, create,
    // bash). Each provides a verbose result view rendered inline below the
    // one-line summary. External tools can override by registering their own
    // renderer with the same toolName.
    for (const r of defaultRenderers(theme)) toolRenderers.service.register(r);

    // Triggers are derived from registered sources. We track the set live by
    // wrapping register() so the InputBox always sees the current trigger map
    // without re-rendering on every registration.
    const triggers = new Set<string>();
    const refCount = new Map<string, number>();
    const registeredSources = new Map<string, { trigger: string; ref: object }>();
    const origRegister = registry.service.register;
    const decrementTrigger = (trigger: string) => {
      const n = (refCount.get(trigger) ?? 1) - 1;
      if (n <= 0) {
        refCount.delete(trigger);
        triggers.delete(trigger);
      } else {
        refCount.set(trigger, n);
      }
    };
    registry.service.register = (source) => {
      const previous = registeredSources.get(source.id);
      if (previous) decrementTrigger(previous.trigger);
      registeredSources.set(source.id, { trigger: source.trigger, ref: source });
      triggers.add(source.trigger);
      refCount.set(source.trigger, (refCount.get(source.trigger) ?? 0) + 1);
      const off = origRegister(source);
      return () => {
        off();
        if (registeredSources.get(source.id)?.ref !== source) return;
        registeredSources.delete(source.id);
        decrementTrigger(source.trigger);
      };
    };

    // Reasoning events → live thinking buffer; finalize when the LLM call ends.
    ctx.on("llm:reasoning", async (payload: any) => {
      const delta = typeof payload?.delta === "string" ? payload.delta : "";
      if (delta) store.appendReasoning(delta);
    });
    // Streamed completion tokens → bump the spinner counter live.
    ctx.on("llm:token", async () => {
      store.incrementBusyTokens(1);
    });
    ctx.on("llm:done", async (payload: any) => {
      // Move accumulated reasoning into the transcript as a Thoughts block,
      // sitting between the user message and the assistant reply.
      store.finalizeReasoning();
      // Replace the streaming estimate with the authoritative count if the
      // provider reported usage.
      const usage = payload?.response?.usage;
      if (usage && typeof usage.completionTokens === "number") {
        store.updateBusyTokens(usage.completionTokens);
      }
    });
    ctx.on("turn:end", async () => {
      // Belt-and-suspenders: if a turn ended without an llm:done (e.g. tool
      // dispatch errored mid-stream), drop any in-flight reasoning so the
      // box doesn't linger above the next prompt.
      store.clearLiveThinking();
      store.clearLiveToolCalls();
      store.clearBusyTiming();
    });

    // /history slash command → modal audit view.
    ctx.on("tui:enter-history", async () => {
      store.enterHistoryMode();
    });

    // session:handoff → either prefill the input buffer for human review
    // (autostart=false) or append the seeded prompt as a user transcript line
    // with a handoff badge (autostart=true). The driver short-circuits the
    // autostart=false case, so the TUI is the only path that surfaces the
    // seeded prompt in either branch.
    ctx.on("session:handoff", async (payload: any) => {
      if (!payload || typeof payload.prompt !== "string") return;
      if (payload.autostart === false) {
        store.setInput(payload.prompt, payload.prompt.length);
      } else {
        const from = typeof payload.from === "string" ? payload.from : undefined;
        store.appendUser(payload.prompt, from ? { handoffFrom: from } : undefined);
      }
    });

    // Tool lifecycle events → live tool calls + finalized transcript entries.
    ctx.on("tool:execute", async (payload: any) => {
      if (!payload || typeof payload.callId !== "string" || typeof payload.name !== "string") return;
      store.appendLiveToolCall(payload.callId, payload.name, payload.args);
    });
    ctx.on("tool:progress", async (payload: any) => {
      if (!payload || typeof payload.callId !== "string" || typeof payload.delta !== "string") return;
      store.updateLiveToolCall(payload.callId, { stdoutDelta: payload.delta });
    });
    ctx.on("tool:result", async (payload: any) => {
      if (!payload || typeof payload.callId !== "string") return;
      const result = typeof payload.result === "string" ? payload.result : safeJson(payload.result);
      if (store.hasLiveToolCall(payload.callId)) {
        store.updateLiveToolCall(payload.callId, { result });
        store.finalizeLiveToolCall(payload.callId, "done");
      } else {
        const name = typeof payload.name === "string" ? payload.name : "(unknown)";
        store.appendToolCallToTranscript(payload.callId, name, undefined, "done", result);
      }
    });
    ctx.on("tool:error", async (payload: any) => {
      if (!payload || typeof payload.callId !== "string") return;
      const msg = typeof payload.message === "string" ? payload.message : "tool error";
      if (store.hasLiveToolCall(payload.callId)) {
        store.updateLiveToolCall(payload.callId, { errorMessage: msg });
        store.finalizeLiveToolCall(payload.callId, "error");
      } else {
        const name = typeof payload.name === "string" ? payload.name : "(unknown)";
        store.appendToolCallToTranscript(payload.callId, name, undefined, "error", undefined, msg);
      }
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
      ctx.provideService<UiChannelService>("ui:channel", channel);
      return;
    }

    const onCancel = () => {
      if (store.snapshot().busy.active) {
        ctx.emit("turn:cancel").catch(() => {});
      }
    };

    // Two-step Ctrl+C exit. We disable Ink's built-in exitOnCtrlC handler
    // (below) so the first press can surface a hint instead of tearing down
    // the UI silently; InputBox arms this and calls back on the second press.
    const onExit = () => {
      try { (plugin as any).__ink?.unmount(); } catch { /* ignore */ }
      process.exit(0);
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
        toolRenderers={toolRenderers}
        triggers={triggers}
        theme={theme}
        onSubmit={onSubmit}
        onCancel={onCancel}
        onExit={onExit}
      />,
      { exitOnCtrlC: false },
    );

    const channel: UiChannelService = {
      readInput: () => store.awaitInput(),
      writeOutput: (chunk: string) => store.appendOutput(chunk),
      writeNotice: (text: string) => store.appendNotice(text),
      writeUser: (text: string) => store.appendUser(text),
      setBusy: (busy: boolean, message?: string) => store.setBusy(busy, message),
      setBusyTiming: (startedAt: number) => store.setBusyTiming(startedAt),
      updateBusyTokens: (deltaTokens: number) => store.updateBusyTokens(deltaTokens),
      incrementBusyTokens: (n?: number) => store.incrementBusyTokens(n),
      appendReasoning: (delta: string) => store.appendReasoning(delta),
      finalizeReasoning: () => store.finalizeReasoning(),
      clearLiveThinking: () => store.clearLiveThinking(),
      setInputDraft: (text: string) => store.setInput(text, text.length),
    };
    ctx.provideService<UiChannelService>("ui:channel", channel);

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

function safeJson(v: unknown): string {
  try { return JSON.stringify(v); } catch { return String(v); }
}
