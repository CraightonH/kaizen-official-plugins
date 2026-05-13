import type { KaizenPlugin } from "kaizen/types";
import type {
  ChatMessage,
  LLMCompleteService,
  SessionsStoreService,
} from "llm-contracts/public";
import type { DriverService, RunConversationInput, RunConversationOutput, ToolDispatchStrategy } from "./public";
import { runConversation, type RunConversationDeps, type ToolsRegistryService } from "./loop.ts";
import { type CurrentTurn } from "./state.ts";
import { newTurnId } from "./ids.ts";
import { wireCancel } from "./cancel.ts";
import { pickBusyMessage } from "./busy-messages.ts";
import { pickDoneMessage } from "./done-messages.ts";

interface UiChannel {
  readInput(): Promise<string>;
  setBusy(b: boolean, msg?: string): void;
  setBusyTiming(startedAt: number): void;
  writeOutput(s: string): void;
  writeNotice(s: string): void;
  writeUser?(s: string): void;
}

interface DriverConfig {
  defaultSystemPrompt?: string;
}

const DEFAULTS = {
  defaultSystemPrompt: "",
} as const;

// Plugin-scoped state. setup() and start() receive different ctx instances
// (kaizen creates a fresh ctx for the driver's start phase), so state must
// live here rather than stashed on the setup-ctx.
//
// The driver does not track or default a model name. Model selection lives
// with the LLM provider plugin (e.g. openai-llm), which fills in its own
// configured default when a request omits `model`. Per-call overrides flow
// through `runConversation(input.model)`.
const state: {
  currentTurn: CurrentTurn | null;
  activeSessionId: string | null;
  systemPrompt: string;
} = {
  currentTurn: null,
  activeSessionId: null,
  systemPrompt: "",
};
let buildDeps: (() => RunConversationDeps) | null = null;
// `input:handled` short-circuit: subscribers (e.g. llm-slash-commands) emit
// this to tell the driver to skip the LLM round-trip for the just-submitted
// line. The flag is set by a subscriber registered in setup() (kaizen forbids
// ctx.on after init) and consumed/reset in start() per submit.
let inputHandled = false;
// `harness:exit-requested` flips this so the next loop iteration breaks.
// The /exit slash command (and anything else that wants a clean shutdown)
// emits the event; the driver owns the actual loop termination.
let exitRequested = false;
// UI channel reference set in start(). Setup-time subscribers reach the UI
// through this — kaizen forbids ctx.on after init, so listeners must be
// registered in setup() but use the channel resolved later.
let moduleUi: UiChannel | null = null;

const plugin: KaizenPlugin = {
  name: "llm-driver",
  apiVersion: "3.0.0",
  driver: true,
  permissions: { tier: "unscoped" },
  config: {
    schema: {
      type: "object",
      properties: {
        defaultSystemPrompt: {
          type: "string",
          description: "Fallback system prompt used by the interactive loop when prompt:system is not bound.",
        },
      },
      additionalProperties: false,
    },
    defaults: DEFAULTS,
  },
  services: {
    consumes: [
      "events:vocabulary",
      "llm-tui:channel",
      "llm:complete",
      "sessions:store",
    ],
    provides: ["driver:run-conversation"],
  },

  async setup(ctx) {
    ctx.consumeService("events:vocabulary");
    ctx.consumeService("llm-tui:channel");
    ctx.consumeService("llm:complete");
    ctx.consumeService("sessions:store");
    // Optional services are discovered with safeUse() below instead of hard
    // service edges. That keeps A-tier harnesses valid when tools/strategy or
    // prompt:system are absent.

    ctx.defineService("driver:run-conversation", {
      description: "Run a (possibly nested) conversation against the LLM with optional tool dispatch.",
    });

    // Reset plugin-scoped state on every setup() so test re-setups and
    // re-loads start from a clean slate.
    state.currentTurn = null;
    state.activeSessionId = null;
    state.systemPrompt = "";
    inputHandled = false;
    exitRequested = false;
    moduleUi = null;

    // Subscribers
    wireCancel(ctx as any, () => state.currentTurn);
    ctx.on("input:handled", () => { inputHandled = true; });
    ctx.on("harness:exit-requested", () => { exitRequested = true; });
    ctx.on("session:active-changed", (payload: any) => {
      if (typeof payload?.to === "string") state.activeSessionId = payload.to;
    });
    // session:handoff (from llm-session-manager) carries autostart=true when
    // the handed-off session already has a seeded user turn at its tail. We
    // dispatch a turn against payload.to (not state.activeSessionId — pass it
    // explicitly to avoid relying on subscriber ordering with active-changed).
    // Single-flight guard: if a turn is already in progress we skip; the
    // owned-turn path in runConversation creates its own turn lifecycle.
    ctx.on("session:handoff", async (payload: any) => {
      if (!payload || payload.autostart !== true) return;
      if (typeof payload.to !== "string") return;
      if (state.currentTurn) return;
      if (!buildDeps) return;
      try {
        await runConversation(
          {
            systemPrompt: state.systemPrompt,
            sessionId: payload.to,
            trigger: "agent",
          },
          buildDeps(),
        );
      } catch (err) {
        ctx.log(`session:handoff autostart failed: ${(err as any)?.message ?? String(err)}`);
      }
    });
    // Bridge system messages (slash command output, plugin notices) to the
    // UI so /help and friends are actually visible. Uses moduleUi resolved
    // in start() because kaizen forbids ctx.on registration past setup().
    ctx.on("conversation:system-message", (payload: any) => {
      const text = payload?.message?.content;
      if (typeof text === "string" && text && moduleUi) {
        moduleUi.writeNotice(text);
      }
    });

    // Build the deps bag for runConversation. We resolve services lazily inside
    // each call so consumers that load after setup() (registry/strategy) are seen.
    // Capture optional services with try/catch since they may not be present
    // in minimal harnesses (A-tier graceful degradation per Spec 0).
    const safeUse = <T>(name: string): T | undefined => {
      try { return ctx.useService<T>(name); } catch { return undefined; }
    };
    // Memoize the deps bag so the loop's per-deps WeakMap cache for
    // prompt:system assembly survives across turns. A fresh object every
    // call would defeat the cache (key would never match).
    let depsCache: RunConversationDeps | null = null;
    buildDeps = (): RunConversationDeps => {
      if (depsCache) return depsCache;
      depsCache = {
        emit: ctx.emit.bind(ctx),
        llmComplete: ctx.useService<LLMCompleteService>("llm:complete")!,
        sessions: ctx.useService<SessionsStoreService>("sessions:store")!,
        registry: safeUse<ToolsRegistryService>("tools:registry"),
        strategy: safeUse<ToolDispatchStrategy>("dispatch:strategy"),
        log: ctx.log.bind(ctx),
        idGen: newTurnId,
        defaultSystemPrompt: state.systemPrompt || (ctx.config as DriverConfig)?.defaultSystemPrompt || DEFAULTS.defaultSystemPrompt,
        promptSystem: safeUse<{ assemble(): Promise<string>; generation(): number }>("prompt:registry"),
      };
      return depsCache;
    };

    const driverService: DriverService = {
      async runConversation(input: RunConversationInput): Promise<RunConversationOutput> {
        return runConversation(input, buildDeps!());
      },
    };
    ctx.provideService<DriverService>("driver:run-conversation", driverService);
  },

  async start(ctx) {
    const ui = ctx.useService<UiChannel>("llm-tui:channel")!;
    moduleUi = ui;
    if (!buildDeps) {
      throw new Error("llm-driver.start() called before setup() — buildDeps not initialized");
    }

    const cfg = (ctx.config ?? {}) as DriverConfig;
    state.systemPrompt = cfg.defaultSystemPrompt ?? DEFAULTS.defaultSystemPrompt;
    const sessions = ctx.useService<SessionsStoreService>("sessions:store")!;

    await ctx.emit("harness:start");
    try {
      if (!state.activeSessionId) {
        const initial = await sessions.create({});
        state.activeSessionId = initial.id;
        await ctx.emit("session:active-changed", { from: null, to: initial.id, alias: initial.alias ?? null });
      }

      while (true) {
        const line = await ui.readInput();
        if (line === "") break;

        // input:handled short-circuit. Reset the flag, emit, then check.
        // The subscription itself is registered in setup() (kaizen forbids
        // ctx.on after init).
        inputHandled = false;
        await ctx.emit("input:submit", { text: line });
        if (exitRequested) break;
        if (inputHandled) continue;
        if (!state.activeSessionId) {
          const next = await sessions.create({});
          state.activeSessionId = next.id;
          await ctx.emit("session:active-changed", { from: null, to: next.id, alias: next.alias ?? null });
        }

        const userMsg: ChatMessage = { role: "user", content: line };
        const sessionId = state.activeSessionId;
        const turnId = newTurnId();
        const handle = sessions.beginTurn(sessionId, turnId);
        handle.append(userMsg);
        ui.writeUser?.(line);
        await ctx.emit("conversation:user-message", { message: userMsg });

        const controller = new AbortController();
        state.currentTurn = { id: turnId, controller };
        const turnStartedAt = Date.now();
        ui.setBusy(true, pickBusyMessage());
        ui.setBusyTiming(turnStartedAt);
        await ctx.emit("turn:start", { turnId, sessionId, trigger: "user" });

        try {
          const result = await runConversation({
            systemPrompt: state.systemPrompt,
            sessionId,
            turnHandle: handle,
            signal: controller.signal,
            externalTurnId: turnId,
            trigger: "user",
          }, buildDeps());
          await handle.commit();
          // Models sometimes emit leading/trailing whitespace in their reply
          // (Qwen often prefixes with two newlines). Strip outer whitespace
          // so the transcript spacing is driven by layout, not by the model.
          const raw = typeof result.finalMessage.content === "string" ? result.finalMessage.content : "";
          const text = raw.trim();
          // One blank line before and after each assistant turn — leading
          // breathing room from the user message, trailing room before the
          // input box reappears.
          if (text) ui.writeOutput("\n" + text + "\n");
          // Post a notice with the wall-clock duration of the turn so the
          // user can see how long the assistant took without watching a
          // stopwatch. Verb is randomized (see done-messages.ts) so the line
          // doesn't read like a stuck template.
          const elapsedSec = Math.max(0, Math.round((Date.now() - turnStartedAt) / 1000));
          ui.writeNotice(`✻ ${pickDoneMessage()} for ${elapsedSec}s`);
          await ctx.emit("conversation:assistant-message", { message: result.finalMessage });
          await ctx.emit("turn:end", { turnId, sessionId, reason: "complete", durationMs: Date.now() - turnStartedAt });
        } catch (err: any) {
          const isAbort = err?.name === "AbortError" || controller.signal.aborted;
          if (isAbort) {
            await handle.partialCommit();
            ui.writeNotice("↯ cancelled");
            await ctx.emit("turn:end", { turnId, sessionId, reason: "cancelled" });
          } else {
            // recoverable error: roll back, surface, continue
            const message = err?.message ?? String(err);
            await handle.rollback();
            ui.writeNotice(`error: ${message}`);
            await ctx.emit("turn:error", { turnId, sessionId, message, cause: err });
            await ctx.emit("turn:end", { turnId, sessionId, reason: "error" });
          }
        } finally {
          state.currentTurn = null;
          ui.setBusy(false);
        }
      }
    } catch (err: any) {
      await ctx.emit("harness:error", { message: err?.message ?? String(err), cause: err });
    } finally {
      await ctx.emit("harness:end");
    }
  },
};

export default plugin;
