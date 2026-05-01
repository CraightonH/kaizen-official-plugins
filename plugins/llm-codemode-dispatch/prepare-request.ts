import type { ToolSchema } from "llm-events/public";
import { renderDts } from "./dts-render.ts";

const PREAMBLE = `You have access to a sandboxed TypeScript runtime. To use a tool, write a single \`\`\`typescript code block. The code is executed in order; the value of the last expression (or any explicit \`return\` from a top-level statement) is returned to you as the tool result. Use \`console.log\` to surface intermediate output. Only one set of \`\`\`typescript blocks per turn will be executed; if you write none, your reply is treated as a final answer to the user.

After you emit a code block, you will see a message from the user starting with \`[code execution result]\`. Treat it as the runtime's response, not a new request from the human.

The following API is available:`;

const EXAMPLE = `Example:
\`\`\`typescript
const contents = await kaizen.tools.readFile({ path: "/etc/hostname" });
console.log("read", contents.length, "bytes");
contents;
\`\`\``;

export async function prepareRequest(input: { availableTools: ToolSchema[] }): Promise<{ tools?: ToolSchema[]; systemPromptAppend?: string }> {
  const dts = await renderDts(input.availableTools);
  const systemPromptAppend = `${PREAMBLE}\n\n\`\`\`typescript\n${dts}\n\`\`\`\n\n${EXAMPLE}\n`;
  return { systemPromptAppend };
}
