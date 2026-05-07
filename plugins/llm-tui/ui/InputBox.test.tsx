import React from "react";
import { describe, it, expect } from "bun:test";
import { render } from "ink-testing-library";
import { InputBox } from "./InputBox.tsx";
import { TuiStore } from "../state/store.ts";
import { makeCompletionRegistry } from "../completion/registry.ts";
import { DEFAULT_THEME } from "../theme/loader.ts";

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

function setup() {
  const store = new TuiStore();
  const reg = makeCompletionRegistry({ debounceMs: 0 });
  const triggers = new Set<string>();
  const onSubmit = (text: string) => store.submit(text);
  return { store, reg, triggers, onSubmit };
}

describe("InputBox", () => {
  it("renders prompt label and typed characters", async () => {
    const ctx = setup();
    const { stdin, lastFrame } = render(
      <InputBox store={ctx.store} registry={ctx.reg} triggers={ctx.triggers} theme={DEFAULT_THEME} onSubmit={ctx.onSubmit} />,
    );
    await tick();
    stdin.write("hello");
    await tick();
    expect(lastFrame()).toContain("kaizen");
    expect(lastFrame()).toContain("hello");
  });

  it("Enter submits when popup is closed", async () => {
    const ctx = setup();
    let submitted = "";
    const { stdin } = render(
      <InputBox store={ctx.store} registry={ctx.reg} triggers={ctx.triggers} theme={DEFAULT_THEME} onSubmit={(t) => { submitted = t; }} />,
    );
    await tick();
    stdin.write("ping");
    await tick();
    stdin.write("\r");
    await tick();
    expect(submitted).toBe("ping");
  });

  it("opens popup on trigger at word-start with registered source", async () => {
    const ctx = setup();
    ctx.triggers.add("/");
    ctx.reg.service.register({
      id: "a", trigger: "/",
      list: () => [{ label: "/help", insertText: "/help " }],
    });
    const { stdin } = render(
      <InputBox store={ctx.store} registry={ctx.reg} triggers={ctx.triggers} theme={DEFAULT_THEME} onSubmit={ctx.onSubmit} />,
    );
    await tick();
    stdin.write("/");
    await tick(60);
    expect(ctx.store.snapshot().popup?.trigger).toBe("/");
    expect(ctx.store.snapshot().popup?.items.map(i => i.label)).toEqual(["/help"]);
  });

  it("does NOT open popup for trigger inside a word", async () => {
    const ctx = setup();
    ctx.triggers.add("/");
    ctx.reg.service.register({ id: "a", trigger: "/", list: () => [{ label: "/x", insertText: "/x" }] });
    const { stdin } = render(
      <InputBox store={ctx.store} registry={ctx.reg} triggers={ctx.triggers} theme={DEFAULT_THEME} onSubmit={ctx.onSubmit} />,
    );
    await tick();
    stdin.write("foo");
    await tick();
    stdin.write("/");
    await tick(60);
    expect(ctx.store.snapshot().popup).toBeNull();
  });

  it("does NOT open popup for trigger inside double-quotes", async () => {
    const ctx = setup();
    ctx.triggers.add("/");
    ctx.reg.service.register({ id: "a", trigger: "/", list: () => [{ label: "/x", insertText: "/x" }] });
    const { stdin } = render(
      <InputBox store={ctx.store} registry={ctx.reg} triggers={ctx.triggers} theme={DEFAULT_THEME} onSubmit={ctx.onSubmit} />,
    );
    await tick();
    stdin.write('say "');
    await tick();
    stdin.write("/");
    await tick(60);
    expect(ctx.store.snapshot().popup).toBeNull();
  });

  it("does NOT open popup for unregistered trigger", async () => {
    const ctx = setup();
    // triggers stays empty
    const { stdin } = render(
      <InputBox store={ctx.store} registry={ctx.reg} triggers={ctx.triggers} theme={DEFAULT_THEME} onSubmit={ctx.onSubmit} />,
    );
    await tick();
    stdin.write("/");
    await tick(60);
    expect(ctx.store.snapshot().popup).toBeNull();
  });

  it("Up/Down navigates popup; Enter accepts and inserts", async () => {
    const ctx = setup();
    ctx.triggers.add("/");
    ctx.reg.service.register({
      id: "a", trigger: "/",
      list: () => [
        { label: "/alpha", insertText: "/alpha " },
        { label: "/beta", insertText: "/beta " },
      ],
    });
    let submitted: string | null = null;
    const { stdin } = render(
      <InputBox store={ctx.store} registry={ctx.reg} triggers={ctx.triggers} theme={DEFAULT_THEME} onSubmit={(t) => { submitted = t; }} />,
    );
    await tick();
    stdin.write("/");
    await tick(60);
    stdin.write("\x1b[B"); // down
    await tick();
    expect(ctx.store.snapshot().popup?.selectedIndex).toBe(1);
    stdin.write("\r"); // accept
    await tick(60);
    expect(ctx.store.snapshot().popup).toBeNull();
    expect(ctx.store.snapshot().input.value).toBe("/beta ");
    expect(submitted).toBeNull();
  });

  it("Tab is a synonym for Enter (accept popup)", async () => {
    const ctx = setup();
    ctx.triggers.add("/");
    ctx.reg.service.register({ id: "a", trigger: "/", list: () => [{ label: "/help", insertText: "/help " }] });
    const { stdin } = render(
      <InputBox store={ctx.store} registry={ctx.reg} triggers={ctx.triggers} theme={DEFAULT_THEME} onSubmit={ctx.onSubmit} />,
    );
    await tick();
    stdin.write("/");
    await tick(60);
    stdin.write("\t");
    await tick();
    expect(ctx.store.snapshot().popup).toBeNull();
    expect(ctx.store.snapshot().input.value).toBe("/help ");
  });

  it("Enter with popup open but no matches submits the line and closes popup", async () => {
    const ctx = setup();
    ctx.triggers.add("/");
    ctx.reg.service.register({ id: "a", trigger: "/", list: () => [] });
    let submitted: string | null = null;
    const { stdin } = render(
      <InputBox store={ctx.store} registry={ctx.reg} triggers={ctx.triggers} theme={DEFAULT_THEME} onSubmit={(t) => { submitted = t; }} />,
    );
    await tick();
    stdin.write("/notarealcommand");
    await tick(60);
    expect(ctx.store.snapshot().popup?.items.length).toBe(0);
    stdin.write("\r");
    await tick();
    expect(submitted).toBe("/notarealcommand");
    expect(ctx.store.snapshot().popup).toBeNull();
  });

  it("Esc closes popup; query stays in buffer", async () => {
    const ctx = setup();
    ctx.triggers.add("/");
    ctx.reg.service.register({ id: "a", trigger: "/", list: () => [{ label: "/help", insertText: "/help " }] });
    const { stdin } = render(
      <InputBox store={ctx.store} registry={ctx.reg} triggers={ctx.triggers} theme={DEFAULT_THEME} onSubmit={ctx.onSubmit} />,
    );
    await tick();
    stdin.write("/he");
    await tick(60);
    expect(ctx.store.snapshot().popup).not.toBeNull();
    stdin.write("\x1b"); // Esc
    await tick();
    expect(ctx.store.snapshot().popup).toBeNull();
    expect(ctx.store.snapshot().input.value).toBe("/he");
  });

  it("Backspacing past the trigger closes popup", async () => {
    const ctx = setup();
    ctx.triggers.add("/");
    ctx.reg.service.register({ id: "a", trigger: "/", list: () => [{ label: "/x", insertText: "/x" }] });
    const { stdin } = render(
      <InputBox store={ctx.store} registry={ctx.reg} triggers={ctx.triggers} theme={DEFAULT_THEME} onSubmit={ctx.onSubmit} />,
    );
    await tick();
    stdin.write("/");
    await tick(60);
    expect(ctx.store.snapshot().popup).not.toBeNull();
    stdin.write("\x7f"); // backspace
    await tick(60);
    expect(ctx.store.snapshot().popup).toBeNull();
    expect(ctx.store.snapshot().input.value).toBe("");
  });

  describe("word/line cursor navigation", () => {
    // ANSI CSI modifier table: 1=Shift, 2=Alt/Meta, 4=Ctrl. Sent as (mod+1).
    const optLeft  = "\x1b[1;3D"; // Option/Alt+Left
    const optRight = "\x1b[1;3C"; // Option/Alt+Right
    const ctrlLeft  = "\x1b[1;5D";
    const ctrlRight = "\x1b[1;5C";
    const home = "\x1b[H";
    const end  = "\x1b[F";

    async function typed(text: string) {
      const ctx = setup();
      const { stdin } = render(
        <InputBox store={ctx.store} registry={ctx.reg} triggers={ctx.triggers} theme={DEFAULT_THEME} onSubmit={ctx.onSubmit} />,
      );
      await tick();
      stdin.write(text);
      await tick();
      return { ...ctx, stdin };
    }

    it("Option+Left jumps to previous word boundary", async () => {
      const ctx = await typed("foo bar baz");
      expect(ctx.store.snapshot().input.cursor).toBe(11);
      ctx.stdin.write(optLeft); await tick();
      expect(ctx.store.snapshot().input.cursor).toBe(8); // start of "baz"
      ctx.stdin.write(optLeft); await tick();
      expect(ctx.store.snapshot().input.cursor).toBe(4); // start of "bar"
      ctx.stdin.write(optLeft); await tick();
      expect(ctx.store.snapshot().input.cursor).toBe(0); // start of "foo"
    });

    it("Option+Right jumps to next word boundary", async () => {
      const ctx = await typed("foo bar baz");
      // Move cursor to start.
      ctx.store.setInput("foo bar baz", 0);
      await tick();
      ctx.stdin.write(optRight); await tick();
      expect(ctx.store.snapshot().input.cursor).toBe(3); // end of "foo"
      ctx.stdin.write(optRight); await tick();
      expect(ctx.store.snapshot().input.cursor).toBe(7); // end of "bar"
      ctx.stdin.write(optRight); await tick();
      expect(ctx.store.snapshot().input.cursor).toBe(11); // end of "baz"
    });

    it("Ctrl+Left/Right jump to line start/end", async () => {
      const ctx = await typed("hello world");
      ctx.stdin.write(ctrlLeft); await tick();
      expect(ctx.store.snapshot().input.cursor).toBe(0);
      ctx.stdin.write(ctrlRight); await tick();
      expect(ctx.store.snapshot().input.cursor).toBe(11);
    });

    it("Home/End jump to line start/end", async () => {
      const ctx = await typed("abc def");
      ctx.stdin.write(home); await tick();
      expect(ctx.store.snapshot().input.cursor).toBe(0);
      ctx.stdin.write(end); await tick();
      expect(ctx.store.snapshot().input.cursor).toBe(7);
    });

    it("ESC+b / ESC+f (Option+arrow on macOS Terminal) jump by word", async () => {
      const ctx = await typed("foo bar baz");
      ctx.stdin.write("\x1bb"); await tick();
      expect(ctx.store.snapshot().input.cursor).toBe(8);
      ctx.stdin.write("\x1bb"); await tick();
      expect(ctx.store.snapshot().input.cursor).toBe(4);
      ctx.stdin.write("\x1bf"); await tick();
      expect(ctx.store.snapshot().input.cursor).toBe(7);
    });

    it("Ctrl+A / Ctrl+E (Cmd+arrow on macOS Terminal) jump to line bounds", async () => {
      const ctx = await typed("hello world");
      ctx.stdin.write("\x01"); await tick(); // Ctrl+A
      expect(ctx.store.snapshot().input.cursor).toBe(0);
      ctx.stdin.write("\x05"); await tick(); // Ctrl+E
      expect(ctx.store.snapshot().input.cursor).toBe(11);
    });

    it("line jumps respect newlines (multi-line buffer)", async () => {
      const ctx = setup();
      const { stdin } = render(
        <InputBox store={ctx.store} registry={ctx.reg} triggers={ctx.triggers} theme={DEFAULT_THEME} onSubmit={ctx.onSubmit} />,
      );
      await tick();
      // "abc\ndefgh" — place cursor in middle of second line (offset 6 = "de|fgh").
      ctx.store.setInput("abc\ndefgh", 6);
      await tick();
      stdin.write(home); await tick();
      expect(ctx.store.snapshot().input.cursor).toBe(4); // start of second line
      stdin.write(end); await tick();
      expect(ctx.store.snapshot().input.cursor).toBe(9); // end of second line
    });
  });

  describe("wrapping", () => {
    // ink-testing-library hardcodes columns to 100. With prefix "│   " (4 cols)
    // and 1-col cursor reserve, the inner width is 95.
    it("breaks long lines into rows that each begin with the gutter prefix", async () => {
      const ctx = setup();
      const { stdin, lastFrame } = render(
        <InputBox store={ctx.store} registry={ctx.reg} triggers={ctx.triggers} theme={DEFAULT_THEME} onSubmit={ctx.onSubmit} />,
      );
      await tick();
      stdin.write("a".repeat(120)); // forces at least 2 visual rows
      await tick();
      const frame = lastFrame()!;
      // First row carries the "❯ " prompt; continuation row uses "│   ".
      expect(frame).toContain("│ ❯ ");
      // Left-frame pipe "│" appears at the start of every visual row of the
      // input. 120 chars at inner-width 95 = 2 rows → 2 pipes.
      const pipeCount = (frame.match(/│/g) ?? []).length;
      expect(pipeCount).toBeGreaterThanOrEqual(2);
    });

    it("cursor stays aligned across wrap boundary", async () => {
      const ctx = setup();
      const { stdin } = render(
        <InputBox store={ctx.store} registry={ctx.reg} triggers={ctx.triggers} theme={DEFAULT_THEME} onSubmit={ctx.onSubmit} />,
      );
      await tick();
      stdin.write("a".repeat(120));
      await tick();
      // Cursor at end of buffer should still be drawable (no crash, no
      // visible breakage). Buffer length 120 means cursor column 120.
      expect(ctx.store.snapshot().input.cursor).toBe(120);
    });
  });

  it("Up arrow recalls history when popup is closed", async () => {
    const ctx = setup();
    ctx.store.submit("first");
    const { stdin, lastFrame } = render(
      <InputBox store={ctx.store} registry={ctx.reg} triggers={ctx.triggers} theme={DEFAULT_THEME} onSubmit={ctx.onSubmit} />,
    );
    await tick();
    stdin.write("\x1b[A");
    await tick();
    expect(lastFrame()).toContain("first");
  });
});
