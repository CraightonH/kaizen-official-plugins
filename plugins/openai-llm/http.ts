import type { ChatMessage, LLMRequest, ToolSchema } from "llm-events/public";
import type { OpenAILLMConfig } from "./config.ts";

export function buildHeaders(cfg: OpenAILLMConfig, version: string): Record<string, string> {
  const base: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "text/event-stream",
    "User-Agent": `kaizen-openai-llm/${version}`,
  };
  if (cfg.apiKey) base["Authorization"] = `Bearer ${cfg.apiKey}`;
  return { ...base, ...cfg.extraHeaders };
}

export function mapMessages(msgs: ChatMessage[]): unknown[] {
  return msgs.map((m) => {
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length) {
      return {
        role: "assistant",
        content: m.content,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments ?? {}) },
        })),
      };
    }
    if (m.role === "tool") {
      return { role: "tool", content: m.content, tool_call_id: m.toolCallId, name: m.name };
    }
    return { role: m.role, content: m.content };
  });
}

export function mapTools(tools: ToolSchema[] | undefined): unknown[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

export function buildChatBody(req: LLMRequest, cfg: OpenAILLMConfig): Record<string, unknown> {
  const messages: any[] = [];
  if (req.systemPrompt && (req.messages.length === 0 || req.messages[0]!.role !== "system")) {
    messages.push({ role: "system", content: req.systemPrompt });
  }
  messages.push(...mapMessages(req.messages));

  const body: Record<string, unknown> = {
    model: req.model || cfg.defaultModel,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    temperature: req.temperature ?? cfg.defaultTemperature,
  };

  if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
  if (req.stop && req.stop.length) body.stop = req.stop;
  const tools = mapTools(req.tools);
  if (tools) {
    body.tools = tools;
    body.tool_choice = "auto";
  }

  if (req.extra) {
    if ((req.extra as any).n !== undefined && Number((req.extra as any).n) > 1) {
      throw new Error("openai-llm: multiple choices (n>1) not supported");
    }
    Object.assign(body, req.extra);
  }
  return body;
}
