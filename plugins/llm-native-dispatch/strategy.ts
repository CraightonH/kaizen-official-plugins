import type {
  ChatMessage,
} from "llm-contracts/public";
import type { ToolExecutionContext } from "llm-tools-registry/public";
import type { ToolDispatchStrategy } from "llm-driver/public";
import { serializeResult, serializeError } from "./serialize.ts";
import { isValidToolArgs, malformedArgsMessage } from "./args-validation.ts";

const CANCELLED_CONTENT = JSON.stringify({ error: "cancelled" });

export function makeStrategy(): ToolDispatchStrategy {
  return {
    prepareRequest({ availableTools }) {
      return { tools: availableTools };
    },

    async handleResponse({ response, registry, signal, emit, turnId, sessionId }) {
      const calls = response.toolCalls ?? [];
      if (calls.length === 0) return [];

      // The driver pre-appends the assistant message before calling handleResponse
      // (see plugins/llm-driver/loop.ts:237). We must NOT include it here, or it
      // duplicates in the conversation.
      const out: ChatMessage[] = [];

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
            turnId,
            sessionId,
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
          turnId,
          sessionId,
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
              turnId,
              sessionId,
            });
          }
          content = ser.content;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
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
