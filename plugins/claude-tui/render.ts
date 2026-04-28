export interface StatusItem {
  id: string;
  content: string;
  priority?: number;
  ttlMs?: number;
  expiresAt?: number;
}

export interface PromptState {
  width: number;
  busy: boolean;
  busyMessage?: string;
}

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  accent: "\x1b[35m",   // magenta-ish; close enough to "kaizen purple" without truecolor.
  yellow: "\x1b[33m",
};

export function renderPrompt(state: PromptState): string {
  const w = Math.max(20, state.width);
  const titleRaw = " kaizen ";
  // top: ╭─ kaizen ─...─╮
  const dashes = w - 2 /* corners */ - 1 /* leading dash */ - titleRaw.length;
  const top = `${C.accent}╭─${titleRaw}${"─".repeat(Math.max(0, dashes))}╮${C.reset}`;
  const inner = w - 2;
  const innerContent = state.busy
    ? ` ⠙ ${C.yellow}${state.busyMessage ?? "thinking…"}${C.reset}`
    : ` ${C.accent}❯${C.reset} `;
  const visibleLen = stripAnsi(innerContent).length;
  const padded = innerContent + " ".repeat(Math.max(0, inner - visibleLen));
  const middle = `${C.accent}│${C.reset}${padded}${C.accent}│${C.reset}`;
  const bottom = `${C.accent}╰${"─".repeat(w - 2)}╯${C.reset}`;
  return `${top}\n${middle}\n${bottom}`;
}

export function renderStatusRow(items: StatusItem[], width: number): string {
  if (items.length === 0) return "";
  const sorted = [...items].sort((a, b) => (a.priority ?? 50) - (b.priority ?? 50));
  const parts = sorted.map((it) => it.content);
  const joined = ` ${parts.join(` ${C.dim}·${C.reset} `)}`;
  // Truncation: if visible length exceeds width, drop trailing items until it fits.
  if (stripAnsi(joined).length <= width) return joined;
  let take = sorted.length;
  while (take > 1) {
    take -= 1;
    const trimmed = ` ${sorted.slice(0, take).map((it) => it.content).join(` ${C.dim}·${C.reset} `)}…`;
    if (stripAnsi(trimmed).length <= width) return trimmed;
  }
  return ` ${sorted[0].content.slice(0, Math.max(0, width - 2))}…`;
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}
