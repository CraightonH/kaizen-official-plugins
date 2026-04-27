import { describe, it, expect } from "bun:test";
import { renderPrompt, renderStatusRow, type StatusItem } from "./render.ts";

describe("renderPrompt", () => {
  it("draws a rounded box with kaizen title and an empty caret line", () => {
    const out = renderPrompt({ width: 60, busy: false, busyMessage: undefined });
    // strip ansi for assertions
    const plain = out.replace(/\x1b\[[0-9;]*m/g, "");
    const lines = plain.split("\n");
    expect(lines[0]).toMatch(/^╭─ kaizen ─+╮$/);
    expect(lines[1]).toMatch(/^│ ❯ +│$/);
    expect(lines[2]).toMatch(/^╰─+╯$/);
  });

  it("shows busy message inside the box when busy=true", () => {
    const out = renderPrompt({ width: 60, busy: true, busyMessage: "thinking…" });
    expect(out).toContain("thinking…");
    const plain = out.replace(/\x1b\[[0-9;]*m/g, "");
    expect(plain).not.toMatch(/^│ ❯ +│$/m);
  });
});

describe("renderStatusRow", () => {
  it("orders items by priority ascending and joins with ' · '", () => {
    const items: StatusItem[] = [
      { id: "git.branch", content: "main", priority: 90 },
      { id: "llm.model", content: "opus-4.7", priority: 10 },
      { id: "cwd", content: "kaizen-official-plugins", priority: 80 },
    ];
    const out = renderStatusRow(items, 80);
    const plain = out.replace(/\x1b\[[0-9;]*m/g, "");
    expect(plain).toBe(" opus-4.7 · kaizen-official-plugins · main");
  });

  it("renders empty when no items", () => {
    expect(renderStatusRow([], 80)).toBe("");
  });
});
