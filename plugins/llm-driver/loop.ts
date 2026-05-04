import type {
  ChatMessage,
  LLMCompleteService,
  LLMRequest,
  LLMResponse,
  ToolSchema,
} from "llm-events/public";
import { aggregateUsage } from "./state.ts";

// These optional service shapes are loose-typed here so loop.ts has no
// non-type-only dependency on packages that don't exist yet.
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
  }): Promise<ChatMessage[]>;
}

export interface RunConversationInput {
  systemPrompt: string;
  messages: ChatMessage[];
  toolFilter?: { tags?: string[]; names?: string[] };
  model?: string;
  parentTurnId?: string;
  signal?: AbortSignal;
  /** Set by index.ts when calling for the interactive loop — turn:start is owned by start(). */
  externalTurnId?: string;
  /** Set by index.ts to label the turn trigger. Defaults to "agent". */
  trigger?: "user" | "agent";
}

export interface RunConversationOutput {
  finalMessage: ChatMessage;
  messages: ChatMessage[];
  usage: { promptTokens: number; completionTokens: number };
}

export interface RunConversationDeps {
  emit: (name: string, payload?: unknown) => Promise<void>;
  llmComplete: LLMCompleteService;
  registry: ToolsRegistryService | undefined;
  strategy: ToolDispatchStrategy | undefined;
  log: (msg: string) => void;
  idGen: () => string;
  defaultSystemPrompt: string;
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

export async function runConversation(
  input: RunConversationInput,
  deps: RunConversationDeps,
): Promise<RunConversationOutput> {
  const ownsTurn = input.externalTurnId === undefined;
  const turnId = input.externalTurnId ?? deps.idGen();
  const trigger = input.trigger ?? "agent";

  if (ownsTurn) {
    await deps.emit("turn:start", {
      turnId,
      trigger,
      ...(input.parentTurnId !== undefined ? { parentTurnId: input.parentTurnId } : {}),
    });
  }

  const signal = input.signal ?? new AbortController().signal;
  const workingMessages: ChatMessage[] = input.messages.slice();
  const usages: Array<LLMResponse["usage"]> = [];

  try {
    // --- single LLM call (A-tier path) ---
    // prepareRequest can be sync or async (codemode renders TS .d.ts and is
    // genuinely async). Awaiting always is correct — sync return values
    // unwrap fine. Reading .systemPromptAppend without await left it
    // `undefined`, so the LLM never saw the kaizen.tools.* API.
    const additions = deps.strategy
      ? await deps.strategy.prepareRequest({
          availableTools: deps.registry ? deps.registry.list(input.toolFilter) : [],
        })
      : { tools: undefined as ToolSchema[] | undefined, systemPromptAppend: undefined };

    const request: LLMRequest = {
      model: input.model,
      messages: workingMessages.slice(),
      systemPrompt: appendSystemAppend(input.systemPrompt, additions.systemPromptAppend),
      tools: additions.tools,
    };

    await deps.emit("llm:before-call", { request, turnId });
    if (request.cancelled === true) {
      const finalMessage = workingMessages[workingMessages.length - 1] ?? {
        role: "assistant" as const, content: "",
      };
      const output: RunConversationOutput = {
        finalMessage,
        messages: workingMessages,
        usage: aggregateUsage(usages),
      };
      if (ownsTurn) await deps.emit("turn:end", { turnId, reason: "complete" });
      return output;
    }
    await deps.emit("llm:request", { request: deepFreeze(structuredClone(request)) });

    let finalResponse: LLMResponse | null = null;
    try {
      for await (const ev of deps.llmComplete.complete(request, { signal })) {
        if (ev.type === "token") {
          await deps.emit("llm:token", { delta: ev.delta });
        } else if (ev.type === "tool-call") {
          await deps.emit("llm:tool-call", { toolCall: ev.toolCall });
        } else if (ev.type === "done") {
          finalResponse = ev.response;
          await deps.emit("llm:done", { response: ev.response });
        } else if (ev.type === "error") {
          await deps.emit("llm:error", { message: ev.message, cause: ev.cause });
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

    if (finalResponse.usage) usages.push(finalResponse.usage);

    const assistantMsg: ChatMessage = {
      role: "assistant",
      content: finalResponse.content,
      ...(finalResponse.toolCalls ? { toolCalls: finalResponse.toolCalls } : {}),
    };
    workingMessages.push(assistantMsg);

    // If no registry/strategy, A-tier path: end turn after one call.
    if (!deps.strategy || !deps.registry) {
      const finalMessage = workingMessages[workingMessages.length - 1]!;
      const output: RunConversationOutput = {
        finalMessage,
        messages: workingMessages,
        usage: aggregateUsage(usages),
      };
      if (ownsTurn) await deps.emit("turn:end", { turnId, reason: "complete" });
      return output;
    }

    // --- multi-step strategy/tool loop ---
    // The first LLM call has already happened above; feed its response to the strategy now.
    let response = finalResponse;
    while (true) {
      const appended = await deps.strategy.handleResponse({
        response,
        registry: deps.registry,
        signal,
        emit: deps.emit,
      });

      if (appended.length === 0) {
        const finalMessage = workingMessages[workingMessages.length - 1]!;
        const output: RunConversationOutput = {
          finalMessage,
          messages: workingMessages,
          usage: aggregateUsage(usages),
        };
        if (ownsTurn) await deps.emit("turn:end", { turnId, reason: "complete" });
        return output;
      }

      workingMessages.push(...appended);

      // Next LLM call.
      const additions2 = await deps.strategy.prepareRequest({
        availableTools: deps.registry.list(input.toolFilter),
      });
      const request2: LLMRequest = {
        model: input.model,
        messages: workingMessages.slice(),
        systemPrompt: appendSystemAppend(input.systemPrompt, additions2.systemPromptAppend),
        tools: additions2.tools,
      };
      await deps.emit("llm:before-call", { request: request2, turnId });
      if (request2.cancelled === true) {
        const finalMessage = workingMessages[workingMessages.length - 1]!;
        const output: RunConversationOutput = {
          finalMessage,
          messages: workingMessages,
          usage: aggregateUsage(usages),
        };
        if (ownsTurn) await deps.emit("turn:end", { turnId, reason: "complete" });
        return output;
      }
      await deps.emit("llm:request", { request: deepFreeze(structuredClone(request2)) });

      let nextResponse: LLMResponse | null = null;
      for await (const ev of deps.llmComplete.complete(request2, { signal })) {
        if (ev.type === "token") {
          await deps.emit("llm:token", { delta: ev.delta });
        } else if (ev.type === "tool-call") {
          await deps.emit("llm:tool-call", { toolCall: ev.toolCall });
        } else if (ev.type === "done") {
          nextResponse = ev.response;
          await deps.emit("llm:done", { response: ev.response });
        } else if (ev.type === "error") {
          await deps.emit("llm:error", { message: ev.message, cause: ev.cause });
          throw Object.assign(new Error(ev.message), { name: "LLMError", cause: ev.cause });
        }
      }

      if (nextResponse === null) {
        throw Object.assign(new Error("stream ended without 'done' event"), { name: "LLMError" });
      }
      if (nextResponse.usage) usages.push(nextResponse.usage);

      const assistantMsg2: ChatMessage = {
        role: "assistant",
        content: nextResponse.content,
        ...(nextResponse.toolCalls ? { toolCalls: nextResponse.toolCalls } : {}),
      };
      workingMessages.push(assistantMsg2);
      response = nextResponse;
    }
  } catch (err: any) {
    if (ownsTurn) {
      const isAbort = err?.name === "AbortError" || signal.aborted;
      const reason = isAbort ? "cancelled" : "error";
      if (reason === "error") {
        await deps.emit("turn:error", { turnId, message: err?.message ?? String(err), cause: err });
      }
      await deps.emit("turn:end", { turnId, reason });
    }
    throw err;
  }
}
