import chalk from "chalk";
import { marked } from "marked";
import { markedTerminal } from "marked-terminal";

// One-time configuration. marked-terminal installs a custom renderer that
// emits ANSI-styled strings instead of HTML.
marked.use(markedTerminal() as any);

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
