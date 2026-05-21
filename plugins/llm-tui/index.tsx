import React from "react";
import { render } from "ink";
import type { KaizenPlugin } from "kaizen/types";
import type { UiChannelService, UiTheme, UiThemeService, UiStatusService, UiCompletionService, UiToolRendererService, UiPromptService, WriteOptions, CompletionSource } from "llm-contracts/public";
import { TuiStore } from "./state/store.ts";
import { makeCompletionRegistry } from "./completion/registry.ts";
import { makeToolRendererRegistry } from "./tool-renderers/registry.ts";
import { defaultRenderers } from "./tool-renderers/defaults.tsx";
import { loadTheme, realThemeDeps } from "./theme/loader.ts";
import { App } from "./ui/App.tsx";
import { copyToClipboard } from "./clipboard.ts";
import { createFallbackChannel, createFallbackPrompt } from "./fallback.ts";

const plugin: KaizenPlugin = {
  name: "llm-tui",
  apiVersion: "3.0.0",
  permissions: { tier: "unscoped" },
  services: {
    provides: ["ui:channel", "ui:completion-source", "ui:status", "ui:theme", "ui:tool-renderer", "ui:prompt"],
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
    // ui:tool-renderer is defined on llm-contracts; this plugin provides the implementation.

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
    ctx.provideService<UiToolRendererService>("ui:tool-renderer", toolRenderers.service);

    // Built-in opt-in renderers for common local tools (edit, write, create,
    // bash). Each provides a verbose result view rendered inline below the
    // one-line summary. External tools can override by registering their own
    // renderer with the same toolName.
    for (const r of defaultRenderers(theme)) toolRenderers.service.register(r);

    // Track registered sources by id. The InputBox derives both char-trigger
    // activation and match-based activation (Task 7) from this map.
    const sources = new Map<string, CompletionSource>();
    const origRegister = registry.service.register;
    registry.service.register = (source) => {
      sources.set(source.id, source);
      const off = origRegister(source);
      return () => {
        if (sources.get(source.id) === source) sources.delete(source.id);
        off();
      };
    };

    // Sub-agent dispatch tracking: when llm-agents emits
    // `agent:dispatch:start`, we map the child session id to the parent's
    // dispatch_agent tool callId. Streamed events (llm:reasoning, llm:token,
    // llm:tool-call) carrying that sessionId are routed under the parent's
    // tool-call entry rather than the parent's thinking box / spinner.
    const childSessionToCallId = new Map<string, string>();
    // Per-child token buffer: split on newlines, push completed lines to the
    // parent tool-call's agentActivity. The trailing partial line is held
    // until a newline arrives or the dispatch ends.
    const childTokenBuffer = new Map<string, string>();
    const flushChildTokens = (sessionId: string, callId: string, final: boolean) => {
      const buf = childTokenBuffer.get(sessionId) ?? "";
      if (!buf) return;
      const parts = buf.split("\n");
      const tail = final ? "" : parts.pop()!;
      for (const line of parts) {
        const trimmed = line.trim();
        if (trimmed) store.appendAgentActivity(callId, trimmed);
      }
      if (final || tail === "") childTokenBuffer.delete(sessionId);
      else childTokenBuffer.set(sessionId, tail);
    };

    ctx.on("agent:dispatch:start", async (payload: any) => {
      if (!payload || typeof payload.callId !== "string" || typeof payload.sessionId !== "string") return;
      childSessionToCallId.set(payload.sessionId, payload.callId);
    });
    ctx.on("agent:dispatch:end", async (payload: any) => {
      if (!payload || typeof payload.sessionId !== "string") return;
      const callId = childSessionToCallId.get(payload.sessionId);
      if (callId) flushChildTokens(payload.sessionId, callId, true);
      childSessionToCallId.delete(payload.sessionId);
    });

    // Reasoning events → live thinking buffer; finalize when the LLM call ends.
    // Child-session reasoning is suppressed here (the sub-agent has its own
    // dispatch_agent tool-call block; we do not bleed its thoughts into the
    // parent's thinking box).
    ctx.on("llm:reasoning", async (payload: any) => {
      const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId : "";
      if (sessionId && childSessionToCallId.has(sessionId)) return;
      const delta = typeof payload?.delta === "string" ? payload.delta : "";
      if (delta) store.appendReasoning(delta);
    });
    // Streamed completion tokens → bump the spinner counter live. For child
    // sessions, accumulate tokens and push completed lines as agent activity
    // under the parent's dispatch_agent entry.
    ctx.on("llm:token", async (payload: any) => {
      const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId : "";
      const callId = sessionId ? childSessionToCallId.get(sessionId) : undefined;
      if (callId) {
        const delta = typeof payload?.delta === "string" ? payload.delta : "";
        if (delta) {
          childTokenBuffer.set(sessionId, (childTokenBuffer.get(sessionId) ?? "") + delta);
          flushChildTokens(sessionId, callId, false);
        }
        return;
      }
      store.incrementBusyTokens(1);
    });
    // Sub-agent tool calls (announced via llm:tool-call before the tool runs)
    // surface as a single-line entry under the parent's dispatch_agent block.
    ctx.on("llm:tool-call", async (payload: any) => {
      const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId : "";
      const callId = sessionId ? childSessionToCallId.get(sessionId) : undefined;
      if (!callId) return;
      const tc = payload?.toolCall as { name?: unknown; arguments?: unknown } | undefined;
      const name = typeof tc?.name === "string" ? tc.name : "(tool)";
      // Flush any partial assistant line first so ordering reads naturally.
      flushChildTokens(sessionId, callId, true);
      store.appendAgentActivity(callId, `▸ ${name}()`);
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

    // Advertise the copy keybind via the existing status:item-update event.
    // The handler one block up writes it into the store, which the StatusBar
    // renders. Never cleared — the hint is a fixed bottom-bar entry.
    await ctx.emit("status:item-update", {
      key: "_tui:hint:copy",
      value: "⌃X copy last",
    });

    const isTTY = !!(process.stdout.isTTY && process.stdin.isTTY);

    if (!isTTY) {
      const channel = createFallbackChannel();
      ctx.provideService<UiChannelService>("ui:channel", channel);
      ctx.provideService<UiPromptService>("ui:prompt", createFallbackPrompt());
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
        sources={sources}
        theme={theme}
        onSubmit={onSubmit}
        onCancel={onCancel}
        onExit={onExit}
        copyToClipboard={copyToClipboard}
      />,
      { exitOnCtrlC: false },
    );

    const channel = createTuiChannel(store);
    ctx.provideService<UiChannelService>("ui:channel", channel);

    const uiPrompt: UiPromptService = {
      requestOption(req) {
        return new Promise((resolve) => {
          store.openOptionsPrompt(req, resolve);
        });
      },
      requestText(req) {
        return new Promise((resolve) => {
          store.openTextPrompt(req, resolve);
        });
      },
    };
    ctx.provideService<UiPromptService>("ui:prompt", uiPrompt);

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

/** Exported for unit tests: builds the store-wired UiChannelService without mounting Ink. */
export function createTuiChannel(store: TuiStore): UiChannelService {
  return {
    readInput: () => store.awaitInput(),
    writeOutput: (chunk: string, opts?: WriteOptions) => store.appendOutput(chunk, opts),
    writeNotice: (text: string, opts?: WriteOptions) => store.appendNotice(text, opts),
    writeUser: (text: string, opts?: WriteOptions) => store.appendUser(text, opts),
    setBusy: (busy: boolean, message?: string) => store.setBusy(busy, message),
    setBusyTiming: (startedAt: number) => store.setBusyTiming(startedAt),
    updateBusyTokens: (deltaTokens: number) => store.updateBusyTokens(deltaTokens),
    incrementBusyTokens: (n?: number) => store.incrementBusyTokens(n),
    appendReasoning: (delta: string) => store.appendReasoning(delta),
    finalizeReasoning: () => store.finalizeReasoning(),
    clearLiveThinking: () => store.clearLiveThinking(),
    setInputDraft: (text: string) => store.setInput(text, text.length),
  };
}

function safeJson(v: unknown): string {
  try { return JSON.stringify(v); } catch { return String(v); }
}
