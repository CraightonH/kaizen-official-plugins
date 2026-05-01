import type { MemoryConfig } from "./config.ts";

export interface RunConversationFn {
  (input: {
    systemPrompt: string;
    messages: { role: "system" | "user" | "assistant" | "tool"; content: string }[];
    toolFilter?: { tags?: string[]; names?: string[] };
    parentTurnId?: string;
  }): Promise<unknown>;
}

export interface ExtractDeps {
  config: Pick<MemoryConfig, "autoExtract" | "extractTriggers">;
  runConversation: RunConversationFn | null;
  log: (msg: string) => void;
}

export interface TurnEndPayload {
  reason: "complete" | "cancelled" | "error" | string;
  lastUserMessage: string;
  turnId: string;
}

export function hasTrigger(text: string, triggers: string[]): boolean {
  const lower = text.toLowerCase();
  for (const t of triggers) {
    const idx = lower.indexOf(t);
    if (idx === -1) continue;
    // Word-boundary check: previous char (if any) must not be a letter when the
    // trigger starts with a letter — so "iodine" does not match "i ".
    const prev = idx === 0 ? " " : lower[idx - 1]!;
    if (/[a-z]/.test(prev)) continue;
    return true;
  }
  return false;
}

const SIDE_PROMPT = `You are a memory extractor for the user's persistent memory store.
Decide whether the user's most recent message contains a durable preference,
fact, or correction worth remembering across sessions. If yes, call the
\`memory_save\` tool exactly once with a concise \`name\`, a one-line
\`description\` (<200 chars), the relevant \`content\`, and an appropriate
\`type\` ("user" | "feedback" | "project" | "reference"). If no, do nothing.
Never reply with prose; only a tool call or no output at all.`;

export async function maybeExtract(payload: TurnEndPayload, deps: ExtractDeps): Promise<void> {
  if (!deps.config.autoExtract) return;
  if (payload.reason !== "complete") return;
  if (!hasTrigger(payload.lastUserMessage, deps.config.extractTriggers)) return;
  if (!deps.runConversation) {
    deps.log("llm-memory: autoExtract enabled but driver:run-conversation not available; skipping");
    return;
  }
  try {
    await deps.runConversation({
      systemPrompt: SIDE_PROMPT,
      messages: [{ role: "user", content: payload.lastUserMessage }],
      toolFilter: { names: ["memory_save"] },
      parentTurnId: payload.turnId,
    });
  } catch (err) {
    deps.log(`llm-memory: extract side-call failed: ${(err as Error).message}`);
  }
}
