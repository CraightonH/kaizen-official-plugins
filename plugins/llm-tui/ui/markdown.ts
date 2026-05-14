import chalk from "chalk";
import Table from "cli-table3";
import { marked } from "marked";
import { markedTerminal } from "marked-terminal";

// One-time configuration. marked-terminal installs a custom renderer that
// emits ANSI-styled strings instead of HTML.
const GUTTER = chalk.gray("│ ");

const mtExt = markedTerminal({
  codespan: chalk.bgAnsi256(236).yellow,
}) as any;

// Replace the 4-space indent that marked-terminal prepends to fenced code
// blocks with a gray gutter ("│ ") + 2 spaces (same visual width). Scoped to
// renderer.code so blockquote indents and other 4-space prefixes are untouched.
const origCode = mtExt.renderer.code;
mtExt.renderer.code = function (...args: unknown[]) {
  const out = origCode.apply(this, args);
  return typeof out === "string" ? out.replace(/^ {4}/gm, GUTTER + "  ") : out;
};

// marked-terminal's default table renderer hands a cli-table3 instance no
// colWidths, so long cells overflow the terminal and the box-drawing border
// wraps onto a new line — visually clobbering the table. We override it to
// compute even per-column widths from the current terminal width and let
// cli-table3 wrap inside each cell.
mtExt.renderer.table = function (token: any) {
  const parser = (this as any).parser;
  const renderInline = (cell: any) =>
    parser ? parser.parseInline(cell.tokens) : String(cell?.text ?? cell);

  const header = (token.header ?? []).map(renderInline);
  const rows = (token.rows ?? []).map((row: any[]) => row.map(renderInline));
  const colCount = Math.max(header.length, 1);
  const termCols = (process.stdout && process.stdout.columns) || 80;
  // cli-table3 borders: 1 char per column boundary + 2 outer + 1 padding/side.
  // Total fixed overhead ≈ 3 * colCount + 1. Leave a small right margin (2).
  const overhead = 3 * colCount + 3;
  const avail = Math.max(colCount * 6, termCols - overhead);
  const perCol = Math.max(6, Math.floor(avail / colCount));
  const colWidths = Array(colCount).fill(perCol);

  const t = new Table({ head: header, colWidths, wordWrap: true, wrapOnWordBoundary: true });
  for (const row of rows) t.push(row);
  return "\n" + t.toString() + "\n\n";
};

marked.use(mtExt);

/**
 * Render a markdown source string as an ANSI-styled string suitable for
 * passing directly to Ink's <Text> (Ink honors embedded ANSI). Returns the
 * input verbatim if the renderer throws — we never want a malformed message
 * to crash the TUI.
 *
 * chalk.level is temporarily forced to ≥1 for the duration of the parse so
 * marked-terminal emits ANSI in non-TTY environments (e.g. test runners).
 * We restore it immediately after to avoid bleeding into other components.
 */
export function renderMarkdown(src: string): string {
  const prevLevel = chalk.level;
  if (chalk.level === 0) chalk.level = 1;
  try {
    const result = marked.parse(src);
    // marked appends trailing newlines after block tokens; strip them so the
    // rendered output occupies exactly the visual space its content needs.
    return typeof result === "string" ? result.replace(/\s+$/, "") : src;
  } catch {
    return src;
  } finally {
    chalk.level = prevLevel;
  }
}
