import type { KaizenPlugin } from "kaizen/types";
import type {
  ChatMessage,
  LLMCompleteService,
} from "llm-events/public";
import type { DriverService, RunConversationInput, RunConversationOutput } from "./public";
import { runConversation, type RunConversationDeps, type ToolDispatchStrategy, type ToolsRegistryService } from "./loop.ts";
import { snapshotMessages, type CurrentTurn } from "./state.ts";
import { newTurnId } from "./ids.ts";
import { wireCancel } from "./cancel.ts";
import { pickBusyMessage } from "./busy-messages.ts";

interface UiChannel {
  readInput(): Promise<string>;
  setBusy(b: boolean, msg?: string): void;
  writeOutput(s: string): void;
  writeNotice(s: string): void;
}

interface DriverConfig {
  defaultModel?: string;
  defaultSystemPrompt?: string;
}

const DEFAULTS = {
  defaultModel: "local-model",
  defaultSystemPrompt: "",
} as const;

const plugin: KaizenPlugin = {
  name: "llm-driver",
  apiVersion: "3.0.0",
  driver: true,
  permissions: { tier: "unscoped" },
  services: {
    consumes: [
      "llm-events:vocabulary",
      "claude-tui:channel",
      "llm:complete",
      "tools:registry",
      "tool-dispatch:strategy",
    ],
    provides: ["driver:run-conversation"],
  },

  async setup(ctx) {
    ctx.consumeService("llm-events:vocabulary");
    ctx.consumeService("claude-tui:channel");
    ctx.consumeService("llm:complete");

    ctx.defineService("driver:run-conversation", {
      description: "Run a (possibly nested) conversation against the LLM with optional tool dispatch.",
    });

    // Driver-private state for the interactive loop and the current turn.
    const state: {
      currentTurn: CurrentTurn | null;
      messages: ChatMessage[];
      systemPrompt: string;
      model: string;
    } = {
      currentTurn: null,
      messages: [],
      systemPrompt: "",
      model: "",
    };

    // Subscribers
    wireCancel(ctx as any, () => state.currentTurn);
    ctx.on("conversation:cleared", async () => { state.messages = []; });

    // Build the deps bag for runConversation. We resolve services lazily inside
    // each call so consumers that load after setup() (registry/strategy) are seen.
    const buildDeps = (): RunConversationDeps => ({
      emit: ctx.emit.bind(ctx),
      llmComplete: ctx.useService<LLMCompleteService>("llm:complete")!,
      registry: ctx.useService<ToolsRegistryService>("tools:registry"),
      strategy: ctx.useService<ToolDispatchStrategy>("tool-dispatch:strategy"),
      log: ctx.log.bind(ctx),
      idGen: newTurnId,
      defaultModel: state.model || (ctx.config as DriverConfig)?.defaultModel || DEFAULTS.defaultModel,
      defaultSystemPrompt: state.systemPrompt || (ctx.config as DriverConfig)?.defaultSystemPrompt || DEFAULTS.defaultSystemPrompt,
    });

    const driverService: DriverService = {
      async runConversation(input: RunConversationInput): Promise<RunConversationOutput> {
        return runConversation(input, buildDeps());
      },
    };
    ctx.provideService<DriverService>("driver:run-conversation", driverService);

    // Stash for start().
    (ctx as any).__llmDriverState = state;
    (ctx as any).__llmDriverBuildDeps = buildDeps;
  },

  async start(ctx) {
    const ui = ctx.useService<UiChannel>("claude-tui:channel")!;
    const state = (ctx as any).__llmDriverState as {
      currentTurn: CurrentTurn | null;
      messages: ChatMessage[];
      systemPrompt: string;
      model: string;
    };
    const buildDeps = (ctx as any).__llmDriverBuildDeps as () => RunConversationDeps;

    const cfg = (ctx.config ?? {}) as DriverConfig;
    state.systemPrompt = cfg.defaultSystemPrompt ?? DEFAULTS.defaultSystemPrompt;
    state.model = cfg.defaultModel ?? DEFAULTS.defaultModel;

    await ctx.emit("session:start");
    try {
      while (true) {
        const line = await ui.readInput();
        if (line === "") break;

        // input:handled short-circuit. Subscribe before emit; flag flips synchronously.
        let handled = false;
        const off = ctx.on("input:handled", () => { handled = true; });
        await ctx.emit("input:submit", { text: line });
        off();
        if (handled) continue;

        const userMsg: ChatMessage = { role: "user", content: line };
        const preTurnSnapshot = snapshotMessages(state.messages);
        state.messages.push(userMsg);
        await ctx.emit("conversation:user-message", { message: userMsg });

        const turnId = newTurnId();
        const controller = new AbortController();
        state.currentTurn = { id: turnId, controller };
        ui.setBusy(true, pickBusyMessage());
        await ctx.emit("turn:start", { turnId, trigger: "user" });

        try {
          const result = await runConversation({
            systemPrompt: state.systemPrompt,
            messages: state.messages,
            model: state.model,
            signal: controller.signal,
            externalTurnId: turnId,
            trigger: "user",
          }, buildDeps());
          state.messages = result.messages;
          await ctx.emit("conversation:assistant-message", { message: result.finalMessage });
          await ctx.emit("turn:end", { turnId, reason: "complete" });
        } catch (err: any) {
          const isAbort = err?.name === "AbortError" || controller.signal.aborted;
          if (isAbort) {
            ui.writeNotice("↯ cancelled");
            state.messages = preTurnSnapshot;
            await ctx.emit("turn:end", { turnId, reason: "cancelled" });
          } else {
            // recoverable error: roll back, surface, continue
            await ctx.emit("turn:error", { turnId, message: err?.message ?? String(err), cause: err });
            state.messages = preTurnSnapshot;
            await ctx.emit("turn:end", { turnId, reason: "error" });
          }
        } finally {
          state.currentTurn = null;
          ui.setBusy(false);
        }
      }
    } catch (err: any) {
      await ctx.emit("session:error", { message: err?.message ?? String(err), cause: err });
    } finally {
      await ctx.emit("session:end");
    }
  },
};

export default plugin;
