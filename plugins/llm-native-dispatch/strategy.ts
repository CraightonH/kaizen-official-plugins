import type {
  ChatMessage,
  ToolSchema,
  LLMResponse,
  ToolsRegistryService,
  ToolExecutionContext,
} from "llm-events/public";
import { serializeResult, serializeError } from "./serialize.ts";
import { isValidToolArgs, malformedArgsMessage } from "./args-validation.ts";

export interface ToolDispatchStrategy {
  prepareRequest(input: { availableTools: ToolSchema[] }): { tools?: ToolSchema[]; systemPromptAppend?: string };
  handleResponse(input: {
    response: LLMResponse;
    registry: ToolsRegistryService;
    signal: AbortSignal;
    emit: (event: string, payload: unknown) => Promise<void>;
  }): Promise<ChatMessage[]>;
}

const CANCELLED_CONTENT = JSON.stringify({ error: "cancelled" });

export function makeStrategy(): ToolDispatchStrategy {
  return {
    prepareRequest({ availableTools }) {
      return { tools: availableTools };
    },

    async handleResponse({ response, registry, signal, emit }) {
      const calls = response.toolCalls ?? [];
      if (calls.length === 0) return [];

      const assistant: ChatMessage = {
        role: "assistant",
        content: response.content ?? "",
        toolCalls: calls,
      };
      const out: ChatMessage[] = [assistant];

      for (let i = 0; i < calls.length; i++) {
        const call = calls[i]!;

        if (signal.aborted) {
          // Fill cancelled messages for this and remaining calls.
          for (let j = i; j < calls.length; j++) {
            const c = calls[j]!;
            out.push({
              role: "tool",
              toolCallId: c.id,
              name: c.name,
              content: CANCELLED_CONTENT,
            });
          }
          break;
        }

        if (!isValidToolArgs(call.arguments)) {
          await emit("tool:error", {
            name: call.name,
            callId: call.id,
            message: "malformed arguments JSON from LLM",
          });
          out.push({
            role: "tool",
            toolCallId: call.id,
            name: call.name,
            content: malformedArgsMessage(call.arguments),
          });
          continue;
        }

        const ctx: ToolExecutionContext = {
          signal,
          callId: call.id,
          log: (msg) => { void emit("status:item-update", { key: `tool:${call.id}`, value: msg }); },
        };

        let content: string;
        try {
          const result = await registry.invoke(call.name, call.arguments, ctx);
          const ser = serializeResult(result);
          if (ser.circular) {
            await emit("tool:error", {
              name: call.name,
              callId: call.id,
              message: "result not JSON-serializable, coerced to string",
            });
          }
          content = ser.content;
        } catch (err) {
          const message = String((err as any)?.message ?? err);
          content = serializeError(message);
        }

        out.push({
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content,
        });
      }

      return out;
    },
  };
}
