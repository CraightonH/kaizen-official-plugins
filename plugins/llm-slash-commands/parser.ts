export interface ParsedSlash {
  name: string;
  args: string;
}

// Name allows dashed segments separated by colons: e.g. "help", "mcp:reload",
// "mcp:my-server:my-prompt". Per-segment rule [a-z][a-z0-9-]*.
const NAME_RE = /^\/([a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)*)(?:$|[ \t])/;

export function parse(text: string): ParsedSlash | null {
  if (!text || text[0] !== "/") return null;
  const m = NAME_RE.exec(text);
  if (!m) return null;
  const name = m[1]!;
  const after = text.slice(m[0].length);
  // m[0] consumed the optional single space/tab terminator; the leading-space
  // strip rule is "strip one leading space only", which matches what we did.
  // If the match ended at end-of-input, args is "".
  if (text.length === m[0].length && !m[0].endsWith(" ") && !m[0].endsWith("\t")) {
    return { name, args: "" };
  }
  return { name, args: after };
}
