import { fromMarkdown } from "mdast-util-from-markdown";

const TS_LANGS = new Set(["ts", "typescript", "js", "javascript"]);

export interface ExtractResult {
  code: string;
  ignoredCount: number;
}

function hasClosingFence(source: string, nodeStart: number, nodeEnd: number): boolean {
  // A properly closed fenced code block has a closing fence line after the content.
  // We detect this by checking that the text after the opening fence line has
  // a matching closing fence before nodeEnd.
  const segment = source.slice(nodeStart, nodeEnd);
  // Find the first newline (end of opening fence line)
  const firstNewline = segment.indexOf("\n");
  if (firstNewline === -1) return false;
  const afterOpening = segment.slice(firstNewline + 1);
  // Check for a closing fence (3+ backticks or tildes on their own line)
  return /^(`{3,}|~{3,})\s*$/m.test(afterOpening);
}

export function extractCodeBlocks(text: string, maxBlocks: number): ExtractResult {
  const normalized = text.replace(/\r\n/g, "\n");
  let tree;
  try {
    tree = fromMarkdown(normalized);
  } catch {
    return { code: "", ignoredCount: 0 };
  }

  const blocks: string[] = [];
  for (const node of tree.children) {
    if (node.type !== "code") continue;
    const lang = (node.lang ?? "").toLowerCase();
    if (!lang || !TS_LANGS.has(lang)) continue;
    // Verify the fence is properly closed (mdast tolerates unterminated fences)
    const startOffset = node.position?.start.offset ?? 0;
    const endOffset = node.position?.end.offset ?? normalized.length;
    if (!hasClosingFence(normalized, startOffset, endOffset)) continue;
    blocks.push((node.value ?? "").trim());
  }

  if (blocks.length === 0) return { code: "", ignoredCount: 0 };

  const taken = blocks.slice(0, maxBlocks);
  const ignored = Math.max(0, blocks.length - taken.length);
  return { code: taken.join("\n;\n"), ignoredCount: ignored };
}
