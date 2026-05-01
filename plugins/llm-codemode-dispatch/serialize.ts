export function stringifyReturn(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "bigint") return JSON.stringify(`${value.toString()}n`);
  if (typeof value === "function") return JSON.stringify("[Function]");
  if (typeof value === "symbol") return JSON.stringify("[Symbol]");
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_k, v) => {
    if (typeof v === "bigint") return `${v.toString()}n`;
    if (typeof v === "function") return "[Function]";
    if (typeof v === "symbol") return "[Symbol]";
    if (typeof v === "object" && v !== null) {
      if (seen.has(v)) return "[Circular]";
      seen.add(v);
    }
    return v;
  });
}

export function truncate(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.byteLength <= maxBytes) return s;
  const head = buf.subarray(0, maxBytes).toString("utf8");
  const more = buf.byteLength - maxBytes;
  return `${head}\n...[truncated, ${more} more bytes]`;
}

export interface FormatInputOk { ok: true; returnValue: unknown; stdout: string; ignoredBlocks?: number; }
export interface FormatInputErr { ok: false; errorName: string; errorMessage: string; stdout: string; ignoredBlocks?: number; }
export type FormatInput = FormatInputOk | FormatInputErr;

export function formatResultMessage(
  input: FormatInput,
  caps: { maxStdoutBytes: number; maxReturnBytes: number; maxBlocksPerResponse?: number },
): string {
  const stdout = truncate(input.stdout ?? "", caps.maxStdoutBytes);
  const lines: string[] = ["[code execution result]"];
  if (input.ok) {
    lines.push("exit: ok");
    const ret = truncate(stringifyReturn(input.returnValue), caps.maxReturnBytes);
    lines.push(`returned: ${ret}`);
  } else {
    lines.push("exit: error");
    lines.push(`error: ${input.errorName}: ${input.errorMessage}`);
  }
  lines.push("stdout:");
  lines.push(stdout);
  if (input.ignoredBlocks && input.ignoredBlocks > 0) {
    const limit = caps.maxBlocksPerResponse ?? 8;
    lines.push(`note: ${input.ignoredBlocks} additional code block(s) were ignored because the limit is ${limit}`);
  }
  return lines.join("\n");
}
