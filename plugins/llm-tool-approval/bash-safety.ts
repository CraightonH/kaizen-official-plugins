/**
 * Inspects a bash `command` string for shell control characters that imply
 * multiple commands or unparseable structure. Returns the first matching
 * reason, or `null` if the command appears to be a single simple command.
 *
 * Checks are intentionally string-level — quoted metacharacters are NOT
 * exempted. Over-flagging is the safer default for an approval gate.
 */
export function bashSafety(command: unknown): string | null {
  if (typeof command !== "string" || command.length === 0) {
    return "non-string command";
  }
  if (command.includes("\n") || command.includes("\r")) {
    return "multiline command";
  }
  if (command.includes("`")) {
    return "backtick command substitution — unable to inspect";
  }
  if (command.includes("$(")) {
    return "command substitution $(…) — unable to inspect";
  }
  if (command.includes("&&") || command.includes("||")) {
    return "conditional chaining (&& / ||)";
  }
  if (command.includes(";")) {
    return "command separator ;";
  }
  if (containsPipe(command)) {
    return "pipe |";
  }
  if (/&\s*$/.test(command)) {
    return "background execution &";
  }
  return null;
}

// `&&` and `||` are handled before this; here we look for any `|` that is not
// part of `||`.
function containsPipe(command: string): boolean {
  for (let i = 0; i < command.length; i++) {
    if (command[i] !== "|") continue;
    const next = command[i + 1];
    const prev = command[i - 1];
    if (next === "|" || prev === "|") continue;
    return true;
  }
  return false;
}
