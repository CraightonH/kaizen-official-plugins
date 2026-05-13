import React from "react";
import { Text } from "ink";
import type { UiToolRenderer } from "llm-contracts/public";
import type { TuiTheme } from "../theme/loader.ts";
import { extractPrimaryString, PRIMARY_RESULT_KEYS } from "./util.ts";

const PREVIEW_LINES = 10;
const MAX_LINE_WIDTH = 200;

function truncLine(s: string): string {
  if (s.length <= MAX_LINE_WIDTH) return s;
  return s.slice(0, MAX_LINE_WIDTH - 1) + "…";
}

function previewLines(text: string, n = PREVIEW_LINES): { lines: string[]; hidden: number } {
  const all = text.split("\n");
  if (all.length <= n) return { lines: all, hidden: 0 };
  return { lines: all.slice(0, n), hidden: all.length - n };
}

function basename(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx >= 0 ? p.slice(idx + 1) : p;
}

function renderError(msg: string, theme: TuiTheme): React.ReactNode {
  return <Text color={theme.noticeColor}>{truncLine(msg)}</Text>;
}

function renderLines(
  lines: string[],
  theme: TuiTheme,
  hidden: number,
  prefix: (i: number, line: string) => { glyph: string; color?: string; dim?: boolean } | null = () => null,
): React.ReactNode {
  return (
    <>
      {lines.map((l, i) => {
        const p = prefix(i, l);
        const text = truncLine(l.length === 0 ? " " : l);
        if (p) {
          return (
            <Text key={i} color={p.color ?? theme.outputColor} dimColor={p.dim ?? false}>
              {p.glyph}
              {text}
            </Text>
          );
        }
        return <Text key={i} color={theme.outputColor} dimColor>{text}</Text>;
      })}
      {hidden > 0 && (
        <Text color={theme.outputColor} dimColor>{`… +${hidden} more line${hidden === 1 ? "" : "s"}`}</Text>
      )}
    </>
  );
}

export function defaultRenderers(theme: TuiTheme): UiToolRenderer[] {
  return [
    // edit: show a unified-ish diff. str_replace command only; insert handled below.
    {
      toolName: "edit",
      collapsedSummary: (args) => {
        const a = (args ?? {}) as Record<string, unknown>;
        const path = typeof a.path === "string" ? a.path : "";
        const cmd = typeof a.command === "string" ? a.command : "";
        const base = path ? basename(path) : "";
        return cmd && base ? `${cmd} ${base}` : (base || cmd);
      },
      expandedView: (args, _result, status) => {
        if (status === "error") return null;
        const a = (args ?? {}) as Record<string, unknown>;

        if (a.command === "str_replace") {
          const oldStr = typeof a.old_str === "string" ? a.old_str : "";
          const newStr = typeof a.new_str === "string" ? a.new_str : "";
          const oldLines = oldStr === "" ? [] : oldStr.split("\n");
          const newLines = newStr === "" ? [] : newStr.split("\n");
          const headline = `Replaced ${oldLines.length} → ${newLines.length} line${newLines.length === 1 ? "" : "s"}`;
          const oldPrev = previewLines(oldStr, PREVIEW_LINES);
          const newPrev = previewLines(newStr, PREVIEW_LINES);
          return (
            <>
              <Text color={theme.outputColor}>{headline}</Text>
              {renderLines(oldPrev.lines, theme, oldPrev.hidden, () => ({
                glyph: "- ",
                color: theme.noticeColor,
              }))}
              {renderLines(newPrev.lines, theme, newPrev.hidden, () => ({
                glyph: "+ ",
                color: theme.promptColor,
              }))}
            </>
          );
        }

        if (a.command === "insert") {
          const text = typeof a.insert_text === "string" ? a.insert_text : "";
          const line = typeof a.insert_line === "number" ? a.insert_line : 0;
          const total = text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
          const prev = previewLines(text, PREVIEW_LINES);
          return (
            <>
              <Text color={theme.outputColor}>{`Inserted ${total} line${total === 1 ? "" : "s"} at line ${line}`}</Text>
              {renderLines(prev.lines, theme, prev.hidden, () => ({
                glyph: "+ ",
                color: theme.promptColor,
              }))}
            </>
          );
        }

        return null;
      },
    },

    // write: show line count + first lines of the new content.
    {
      toolName: "write",
      collapsedSummary: (args) => {
        const a = (args ?? {}) as Record<string, unknown>;
        const path = typeof a.path === "string" ? a.path : "";
        return path ? basename(path) : "";
      },
      expandedView: (args, _result, status) => {
        if (status === "error") return null;
        const a = (args ?? {}) as Record<string, unknown>;
        const content = typeof a.content === "string" ? a.content : "";
        const total = content === "" ? 0 : content.split("\n").length;
        const prev = previewLines(content, PREVIEW_LINES);
        return (
          <>
            <Text color={theme.outputColor}>{`Wrote ${total} line${total === 1 ? "" : "s"}`}</Text>
            {renderLines(prev.lines, theme, prev.hidden)}
          </>
        );
      },
    },

    // create: same shape as write, different headline.
    {
      toolName: "create",
      collapsedSummary: (args) => {
        const a = (args ?? {}) as Record<string, unknown>;
        const path = typeof a.path === "string" ? a.path : "";
        return path ? basename(path) : "";
      },
      expandedView: (args, _result, status) => {
        if (status === "error") return null;
        const a = (args ?? {}) as Record<string, unknown>;
        const content = typeof a.content === "string" ? a.content : "";
        const total = content === "" ? 0 : content.split("\n").length;
        const prev = previewLines(content, PREVIEW_LINES);
        return (
          <>
            <Text color={theme.outputColor}>{`Created ${total} line${total === 1 ? "" : "s"}`}</Text>
            {renderLines(prev.lines, theme, prev.hidden)}
          </>
        );
      },
    },

    // bash: show stdout preview (or result string if stdout was not streamed).
    {
      toolName: "bash",
      collapsedSummary: (args) => {
        const a = (args ?? {}) as Record<string, unknown>;
        const cmd = typeof a.command === "string" ? a.command : "";
        return cmd.replace(/\s+/g, " ").trim();
      },
      expandedView: (_args, result, status, stdout) => {
        if (status === "error") {
          return result ? renderError(result, theme) : null;
        }
        // Prefer streamed stdout. Otherwise try to extract the primary
        // string field (e.g. `output`) from the JSON-stringified handler
        // result so the expansion shows real text instead of a JSON blob.
        // Empty extraction (output: "") is kept — falls through to (no output)
        // below rather than being clobbered by the raw JSON.
        let text = stdout && stdout.length > 0 ? stdout : "";
        if (!text && result) {
          const extracted = extractPrimaryString(result, PRIMARY_RESULT_KEYS);
          text = extracted ?? result;
        }
        if (!text) return <Text color={theme.outputColor} dimColor>(no output)</Text>;
        const prev = previewLines(text, PREVIEW_LINES);
        return renderLines(prev.lines, theme, prev.hidden);
      },
    },
  ];
}
