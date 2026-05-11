import type {
  ChatMessage,
  LLMCompleteService,
  LLMRequest,
  LLMResponse,
  ToolSchema,
} from "llm-events/public";
import type { SessionsStoreService } from "llm-session-manager/public";
import type { RunConversationInput, RunConversationOutput } from "./public";
import { aggregateUsage } from "./state.ts";

export interface ToolsRegistryService {
  list(filter?: { tags?: string[]; names?: string[] }): ToolSchema[];
  invoke(name: string, args: unknown, ctx: any): Promise<unknown>;
  register?(...args: unknown[]): unknown;
}

export interface ToolDispatchStrategy {
  prepareRequest(input: { availableTools: ToolSchema[] }):
    | { tools?: ToolSchema[]; systemPromptAppend?: string }
    | Promise<{ tools?: ToolSchema[]; systemPromptAppend?: string }>;
  handleResponse(input: {
    response: LLMResponse;
    registry: ToolsRegistryService;
    signal: AbortSignal;
    emit: (event: string, payload: unknown) => Promise<void>;
    turnId: string;
    sessionId: string;
  }): Promise<ChatMessage[]>;
}

export interface PromptSystemServiceLike {
  assemble(): Promise<string>;
  generation(): number;
}

export interface RunConversationDeps {
  emit: (name: string, payload?: unknown) => Promise<void>;
  llmComplete: LLMCompleteService;
  registry: ToolsRegistryService | undefined;
  strategy: ToolDispatchStrategy | undefined;
  sessions: SessionsStoreService;
  log: (msg: string) => void;
  idGen: () => string;
  defaultSystemPrompt: string;
  promptSystem?: PromptSystemServiceLike;
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    for (const v of Object.values(o)) deepFreeze(v as unknown);
    Object.freeze(o);
  }
  return o;
}

function appendSystemAppend(sp: string | undefined, append: string | undefined): string | undefined {
  if (!append) return sp;
  if (!sp) return append;
  return `${sp}\n\n${append}`;
}

interface AssemblyCache {
  generation: number;
  prompt: string;
}
const assemblyCache = new WeakMap<RunConversationDeps, AssemblyCache>();

async function resolveSystemPrompt(
  input: RunConversationInput,
  deps: RunConversationDeps,
  legacyAppend: string | undefined,
): Promise<string | undefined> {
  if (deps.promptSystem) {
    const gen = deps.promptSystem.generation();
    const cached = assemblyCache.get(deps);
    if (!cached || cached.generation !== gen) {
      const prompt = await deps.promptSystem.assemble();
      assemblyCache.set(deps, { generation: gen, prompt });
      return prompt;
    }
    return cached.prompt;
  }
  return appendSystemAppend(input.systemPrompt, legacyAppend);
}

async function completeOnce(
  request: LLMRequest,
  input: RunConversationInput,
  deps: RunConversationDeps,
  turnId: string,
  signal: AbortSignal,
): Promise<LLMResponse> {
  const startedAt = Date.now();
  let finalResponse: LLMResponse | null = null;
  try {
    for await (const ev of deps.llmComplete.complete(request, { signal })) {
      if (ev.type === "token") {
        await deps.emit("llm:token", { delta: ev.delta, turnId, sessionId: input.sessionId });
      } else if (ev.type === "reasoning") {
        await deps.emit("llm:reasoning", { delta: ev.delta, turnId, sessionId: input.sessionId });
      } else if (ev.type === "tool-call") {
        await deps.emit("llm:tool-call", { toolCall: ev.toolCall, turnId, sessionId: input.sessionId });
      } else if (ev.type === "done") {
        finalResponse = ev.response;
        await deps.emit("llm:done", {
          response: ev.response,
          latencyMs: Date.now() - startedAt,
          turnId,
          sessionId: input.sessionId,
        });
      } else if (ev.type === "error") {
        await deps.emit("llm:error", {
          message: ev.message,
          cause: ev.cause,
          latencyMs: Date.now() - startedAt,
          turnId,
          sessionId: input.sessionId,
        });
        throw Object.assign(new Error(ev.message), { name: "LLMError", cause: ev.cause });
      }
    }
  } catch (err: any) {
    if (err?.name === "AbortError" || signal.aborted) throw err;
    if (err?.name === "LLMError") throw err;
    throw err;
  }

  if (finalResponse === null) {
    throw Object.assign(new Error("stream ended without 'done' event"), { name: "LLMError" });
  }
  return finalResponse;
}

export async function runConversation(
  input: RunConversationInput,
  deps: RunConversationDeps,
): Promise<RunConversationOutput> {
  const ownsTurn = input.externalTurnId === undefined;
  const turnId = input.externalTurnId ?? deps.idGen();
  const trigger = input.trigger ?? "agent";
  const signal = input.signal ?? new AbortController().signal;
  const turnHandle = "turnHandle" in input && input.turnHandle
    ? input.turnHandle
    : deps.sessions.beginTurn(input.sessionId, turnId);
  const usages: Array<LLMResponse["usage"]> = [];

  if (ownsTurn) {
    if (input.userMessage !== undefined) {
      turnHandle.append(input.userMessage);
      await deps.emit("conversation:user-message", { message: input.userMessage });
    } else {
      // No user message provided: snapshot tail must already be a user turn
      // (e.g. seeded by llm-session-manager during a session:handoff). Validate.
      const tail = await deps.sessions.getMessages(input.sessionId);
      if (tail.length === 0 || tail[tail.length - 1]?.role !== "user") {
        throw new Error("runConversation: no userMessage and no pending user turn at snapshot tail");
      }
    }
    await deps.emit("turn:start", {
      turnId,
      sessionId: input.sessionId,
      trigger,
      ...(input.parentTurnId !== undefined ? { parentTurnId: input.parentTurnId } : {}),
    });
  }

  async function makeRequest(): Promise<{ request: LLMRequest; response: LLMResponse }> {
    const additions = deps.strategy
      ? await deps.strategy.prepareRequest({
          availableTools: deps.registry ? deps.registry.list(input.toolFilter) : [],
        })
      : { tools: undefined as ToolSchema[] | undefined, systemPromptAppend: undefined };

    const request: LLMRequest = {
      model: input.model,
      messages: await deps.sessions.getMessages(input.sessionId),
      systemPrompt: await resolveSystemPrompt(input, deps, additions.systemPromptAppend),
      tools: additions.tools,
    };

    await deps.emit("llm:before-call", { request, turnId, sessionId: input.sessionId });
    if (request.cancelled === true) {
      const messages = await deps.sessions.getMessages(input.sessionId);
      const response: LLMResponse = {
        content: messages[messages.length - 1]?.content ?? "",
        finishReason: "stop",
      };
      return { request, response };
    }

    await deps.emit("llm:request", {
      request: deepFreeze(structuredClone(request)),
      turnId,
      sessionId: input.sessionId,
    });
    return { request, response: await completeOnce(request, input, deps, turnId, signal) };
  }

  try {
    const first = await makeRequest();
    if (first.request.cancelled === true) {
      const messages = await deps.sessions.getMessages(input.sessionId);
      const finalMessage = messages[messages.length - 1] ?? { role: "assistant", content: "" };
      if (ownsTurn) {
        await turnHandle.commit();
        await deps.emit("turn:end", { turnId, sessionId: input.sessionId, reason: "complete" });
      }
      return { finalMessage, usage: aggregateUsage(usages) };
    }
    let response = first.response;
    if (response.usage) usages.push(response.usage);

    const assistantMsg: ChatMessage = {
      role: "assistant",
      content: response.content,
      ...(response.toolCalls ? { toolCalls: response.toolCalls } : {}),
    };
    turnHandle.append(assistantMsg);

    if (!deps.strategy || !deps.registry) {
      if (ownsTurn) {
        await turnHandle.commit();
        await deps.emit("turn:end", { turnId, sessionId: input.sessionId, reason: "complete" });
      }
      return { finalMessage: assistantMsg, usage: aggregateUsage(usages) };
    }

    while (true) {
      const appended = await deps.strategy.handleResponse({
        response,
        registry: deps.registry,
        signal,
        emit: deps.emit,
        turnId,
        sessionId: input.sessionId,
      });

      if (appended.length === 0) {
        if (ownsTurn) {
          await turnHandle.commit();
          await deps.emit("turn:end", { turnId, sessionId: input.sessionId, reason: "complete" });
        }
        const messages = await deps.sessions.getMessages(input.sessionId);
        return {
          finalMessage: messages[messages.length - 1] ?? assistantMsg,
          usage: aggregateUsage(usages),
        };
      }

      for (const msg of appended) turnHandle.append(msg);

      const next = await makeRequest();
      if (next.request.cancelled === true) {
        const messages = await deps.sessions.getMessages(input.sessionId);
        const finalMessage = messages[messages.length - 1] ?? assistantMsg;
        if (ownsTurn) {
          await turnHandle.commit();
          await deps.emit("turn:end", { turnId, sessionId: input.sessionId, reason: "complete" });
        }
        return { finalMessage, usage: aggregateUsage(usages) };
      }
      response = next.response;
      if (response.usage) usages.push(response.usage);
      const nextAssistant: ChatMessage = {
        role: "assistant",
        content: response.content,
        ...(response.toolCalls ? { toolCalls: response.toolCalls } : {}),
      };
      turnHandle.append(nextAssistant);
    }
  } catch (err: any) {
    if (ownsTurn) {
      const isAbort = err?.name === "AbortError" || signal.aborted;
      const reason = isAbort ? "cancelled" : "error";
      if (isAbort) {
        await turnHandle.partialCommit();
      } else {
        await turnHandle.rollback();
        await deps.emit("turn:error", {
          turnId,
          sessionId: input.sessionId,
          message: err?.message ?? String(err),
          cause: err,
        });
      }
      await deps.emit("turn:end", { turnId, sessionId: input.sessionId, reason });
    }
    throw err;
  }
}
