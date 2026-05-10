import React, { useEffect, useState } from "react";
import { Text } from "ink";
import type { ToolCallEntry } from "../state/store.ts";
import type { ToolRendererRegistry } from "../tool-renderers/registry.ts";
import type { TuiTheme } from "../theme/loader.ts";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MAX_PREVIEW = 80;

// Heuristic: when args is an object, these keys (in priority order) usually
// hold the "interesting" payload — show their value rather than the whole
// object. Mirrors what Claude Code does for its built-in tools.
const PRIMARY_ARG_KEYS = [
  "command",     // Bash
  "code",        // execute_typescript / shell-eval
  "file_path", "filePath", "path",   // Read/Edit/Write/Glob
  "pattern",     // Grep/Glob
  "query",       // Search-like tools
  "url",         // Fetch
  "prompt",      // Sub-agent style tools
  "text",
  "message",
  "name",
];

function compactWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}

// Render args as a short, human-readable string. Tries to surface the
// "primary" argument value (e.g. the command for Bash, the file path for
// Read) rather than dumping the full JSON object, which is unreadable
// at a glance and dominated by braces and quotes.
function defaultCollapsedSummary(args: unknown): string {
  if (args == null) return "";
  if (typeof args === "string") return truncate(compactWhitespace(args), MAX_PREVIEW);
  if (typeof args !== "object") return truncate(String(args), MAX_PREVIEW);
  const obj = args as Record<string, unknown>;

  // Prefer a known primary key with a non-empty string value.
  for (const k of PRIMARY_ARG_KEYS) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) return truncate(compactWhitespace(v), MAX_PREVIEW);
  }

  // Single-key object → show its value directly (no key noise).
  const keys = Object.keys(obj);
  if (keys.length === 1) {
    const v = obj[keys[0]!];
    if (typeof v === "string") return truncate(compactWhitespace(v), MAX_PREVIEW);
    let vs: string;
    try { vs = JSON.stringify(v); } catch { vs = String(v); }
    return truncate(compactWhitespace(vs), MAX_PREVIEW);
  }

  // Multi-key fallback: compact "key=value" pairs. Strings render unquoted
  // for readability; non-strings round-trip through JSON.
  const parts = keys.map((k) => {
    const v = obj[k];
    const vs = typeof v === "string" ? v : (() => {
      try { return JSON.stringify(v); } catch { return String(v); }
    })();
    return `${k}=${vs}`;
  });
  return truncate(compactWhitespace(parts.join(", ")), MAX_PREVIEW);
}

export interface ToolCallBlockProps {
  entry: ToolCallEntry;
  registry: ToolRendererRegistry;
  theme: TuiTheme;
}

export const ToolCallBlock: React.FC<ToolCallBlockProps> = ({ entry, registry, theme }) => {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (entry.status !== "running") return;
    const t = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(t);
  }, [entry.status]);

  const renderer = registry.lookup(entry.name);
  const summary = renderer ? renderer.collapsedSummary(entry.args) : defaultCollapsedSummary(entry.args);

  let glyph: string;
  let glyphColor = theme.outputColor;
  if (entry.status === "running") { glyph = SPINNER_FRAMES[frame]!; glyphColor = theme.busyColor; }
  else if (entry.status === "done") { glyph = "✓"; glyphColor = theme.outputColor; }
  else { glyph = "✗"; glyphColor = theme.noticeColor; }

  const trail =
    entry.status === "error" && entry.errorMessage ? ` — ${entry.errorMessage}` :
    entry.status === "done" && entry.result ? ` — ${truncate(entry.result, 40)}` :
    "";

  return (
    <Text>
      <Text color={theme.promptColor}>{"▸ "}</Text>
      <Text color={theme.promptColor} bold>{entry.name}</Text>
      <Text color={theme.outputColor} dimColor>{`(${summary})`}</Text>
      <Text color={glyphColor}>{`  ${glyph}`}</Text>
      <Text color={theme.outputColor} dimColor>{trail}</Text>
    </Text>
  );
};
