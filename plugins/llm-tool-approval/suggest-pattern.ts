import { stringLeaves } from "./string-leaves.ts";

/**
 * Produces a sensible default pattern for the "Approve Pattern Always" prompt
 * option. The user can edit or clear it before submitting.
 *
 *   bash + "git status"                    → "git *"
 *   web_search + "https://github.com/x/y"  → "*github.com/*"
 *   read + "/Users/chancock/foo/bar"       → "/Users/chancock/*"
 *
 * Returns null when args have no string leaves (option should be hidden).
 */
export function suggestPattern(name: string, args: unknown): string | null {
  const leaves = stringLeaves(args);
  if (leaves.length === 0) return null;

  if (name === "bash") {
    const cmd = leaves[0]!;
    const firstTok = cmd.split(/\s+/)[0] ?? cmd;
    return `${firstTok} *`;
  }

  const leaf = leaves.reduce((longest, s) => (s.length > longest.length ? s : longest), leaves[0]!);

  const urlHost = extractHost(leaf);
  if (urlHost) return `*${urlHost}/*`;

  if (leaf.startsWith("/") || leaf.startsWith("~/")) {
    return collapseTwoSegments(leaf);
  }

  return leaf;
}

function extractHost(s: string): string | null {
  const m = s.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i);
  return m ? m[1]! : null;
}

function collapseTwoSegments(p: string): string {
  const trimmed = p.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  if (parts.length <= 2) return `${trimmed}/*`;
  return `${parts.slice(0, 3).join("/")}/*`;
}
