import React from "react";
import { describe, it, expect } from "bun:test";
import { render } from "ink-testing-library";
import { InputBox } from "./InputBox.tsx";
import { TuiStore } from "../state/store.ts";
import { makeCompletionRegistry } from "../completion/registry.ts";
import { DEFAULT_THEME } from "../theme/loader.ts";
import type { CompletionSource } from "llm-contracts/public";

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

function setup() {
  const store = new TuiStore();
  const reg = makeCompletionRegistry({ debounceMs: 0 });
  const sources = new Map<string, CompletionSource>();
  // Mirror the production wrapper from llm-tui/index.tsx so register()
  // updates the sources map AND bumps the snapshot version. Without this,
  // tests can drift from production behavior — see the post-mount registration
  // regression test below.
  const origRegister = reg.service.register;
  reg.service.register = (source) => {
    sources.set(source.id, source);
    store.bumpSourcesVersion();
    const off = origRegister(source);
    return () => {
      if (sources.get(source.id) === source) sources.delete(source.id);
      store.bumpSourcesVersion();
      off();
    };
  };
  const onSubmit = (text: string) => store.submit(text);
  return { store, reg, sources, onSubmit };
}

describe("InputBox", () => {
  it("renders prompt label and typed characters", async () => {
    const ctx = setup();
    const { stdin, lastFrame } = render(
      <InputBox store={ctx.store} registry={ctx.reg} sources={ctx.sources} theme={DEFAULT_THEME} onSubmit={ctx.onSubmit} />,
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
      <InputBox store={ctx.store} registry={ctx.reg} sources={ctx.sources} theme={DEFAULT_THEME} onSubmit={(t) => { submitted = t; }} />,
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
    const src = { id: "a", trigger: "/", list: () => [{ label: "/help", insertText: "/help " }] };
    ctx.sources.set(src.id, src);
    ctx.reg.service.register(src);
    const { stdin } = render(
      <InputBox store={ctx.store} registry={ctx.reg} sources={ctx.sources} theme={DEFAULT_THEME} onSubmit={ctx.onSubmit} />,
    );
    await tick();
    stdin.write("/");
    await tick(60);
    expect(ctx.store.snapshot().popup?.trigger).toBe("/");
    expect(ctx.store.snapshot().popup?.items.map(i => i.label)).toEqual(["/help"]);
  });

  it("does NOT open popup for trigger inside a word", async () => {
    const ctx = setup();
    const src = { id: "a", trigger: "/", list: () => [{ label: "/x", insertText: "/x" }] };
    ctx.sources.set(src.id, src);
    ctx.reg.service.register(src);
    const { stdin } = render(
      <InputBox store={ctx.store} registry={ctx.reg} sources={ctx.sources} theme={DEFAULT_THEME} onSubmit={ctx.onSubmit} />,
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
    const src = { id: "a", trigger: "/", list: () => [{ label: "/x", insertText: "/x" }] };
    ctx.sources.set(src.id, src);
    ctx.reg.service.register(src);
    const { stdin } = render(
      <InputBox store={ctx.store} registry={ctx.reg} sources={ctx.sources} theme={DEFAULT_THEME} onSubmit={ctx.onSubmit} />,
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
      <InputBox store={ctx.store} registry={ctx.reg} sources={ctx.sources} theme={DEFAULT_THEME} onSubmit={ctx.onSubmit} />,
    );
    await tick();
    stdin.write("/");
    await tick(60);
    expect(ctx.store.snapshot().popup).toBeNull();
  });

  it("Up/Down navigates popup; Enter accepts and inserts", async () => {
    const ctx = setup();
    const src = {
      id: "a", trigger: "/",
      list: () => [
        { label: "/alpha", insertText: "/alpha " },
        { label: "/beta", insertText: "/beta " },
      ],
    };
    ctx.sources.set(src.id, src);
    ctx.reg.service.register(src);
    let submitted: string | null = null;
    const { stdin } = render(
      <InputBox store={ctx.store} registry={ctx.reg} sources={ctx.sources} theme={DEFAULT_THEME} onSubmit={(t) => { submitted = t; }} />,
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
    const src = { id: "a", trigger: "/", list: () => [{ label: "/help", insertText: "/help " }] };
    ctx.sources.set(src.id, src);
    ctx.reg.service.register(src);
    const { stdin } = render(
      <InputBox store={ctx.store} registry={ctx.reg} sources={ctx.sources} theme={DEFAULT_THEME} onSubmit={ctx.onSubmit} />,
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
    const src = { id: "a", trigger: "/", list: () => [] };
    ctx.sources.set(src.id, src);
    ctx.reg.service.register(src);
    let submitted = "";
    const { stdin } = render(
      <InputBox store={ctx.store} registry={ctx.reg} sources={ctx.sources} theme={DEFAULT_THEME} onSubmit={(t) => { submitted = t; }} />,
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
    const src = { id: "a", trigger: "/", list: () => [{ label: "/help", insertText: "/help " }] };
    ctx.sources.set(src.id, src);
    ctx.reg.service.register(src);
    const { stdin } = render(
      <InputBox store={ctx.store} registry={ctx.reg} sources={ctx.sources} theme={DEFAULT_THEME} onSubmit={ctx.onSubmit} />,
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
    const src = { id: "a", trigger: "/", list: () => [{ label: "/x", insertText: "/x" }] };
    ctx.sources.set(src.id, src);
    ctx.reg.service.register(src);
    const { stdin } = render(
      <InputBox store={ctx.store} registry={ctx.reg} sources={ctx.sources} theme={DEFAULT_THEME} onSubmit={ctx.onSubmit} />,
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
        <InputBox store={ctx.store} registry={ctx.reg} sources={ctx.sources} theme={DEFAULT_THEME} onSubmit={ctx.onSubmit} />,
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
        <InputBox store={ctx.store} registry={ctx.reg} sources={ctx.sources} theme={DEFAULT_THEME} onSubmit={ctx.onSubmit} />,
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
        <InputBox store={ctx.store} registry={ctx.reg} sources={ctx.sources} theme={DEFAULT_THEME} onSubmit={ctx.onSubmit} />,
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
        <InputBox store={ctx.store} registry={ctx.reg} sources={ctx.sources} theme={DEFAULT_THEME} onSubmit={ctx.onSubmit} />,
      );
      await tick();
      stdin.write("a".repeat(120));
      await tick();
      // Cursor at end of buffer should still be drawable (no crash, no
      // visible breakage). Buffer length 120 means cursor column 120.
      expect(ctx.store.snapshot().input.cursor).toBe(120);
    });
  });

  describe("bracketed paste", () => {
    // Ink strips the leading ESC, so the start marker arrives in `input` as
    // literal "[200~". The end marker keeps its ESC because it sits mid-chunk.
    it("paste in a single chunk inserts a placeholder, not the raw text", async () => {
      const ctx = setup();
      const { stdin } = render(
        <InputBox store={ctx.store} registry={ctx.reg} sources={ctx.sources} theme={DEFAULT_THEME} onSubmit={ctx.onSubmit} />,
      );
      await tick();
      stdin.write("\x1b[200~hello\nworld\x1b[201~");
      await tick();
      const buf = ctx.store.snapshot().input.value;
      expect(buf).toBe("[Pasted text #1 +2 lines]");
      // Raw text not present in visible buffer.
      expect(buf).not.toContain("hello\nworld");
    });

    it("paste split across two chunks accumulates correctly", async () => {
      const ctx = setup();
      const { stdin } = render(
        <InputBox store={ctx.store} registry={ctx.reg} sources={ctx.sources} theme={DEFAULT_THEME} onSubmit={ctx.onSubmit} />,
      );
      await tick();
      stdin.write("\x1b[200~partial");
      await tick();
      // No placeholder yet — paste isn't closed.
      expect(ctx.store.snapshot().input.value).toBe("");
      stdin.write(" rest\x1b[201~");
      await tick();
      expect(ctx.store.snapshot().input.value).toBe("[Pasted text #1 +1 line]");
    });

    it("Enter submits the paste with placeholders expanded back to content", async () => {
      const ctx = setup();
      let submitted = "";
      const { stdin } = render(
        <InputBox store={ctx.store} registry={ctx.reg} sources={ctx.sources} theme={DEFAULT_THEME} onSubmit={(t) => { submitted = t; }} />,
      );
      await tick();
      stdin.write("\x1b[200~line one\nline two\x1b[201~");
      await tick();
      stdin.write("\r");
      await tick();
      expect(submitted).toBe("line one\nline two");
    });

    it("backspace at end of placeholder deletes the whole token atomically", async () => {
      const ctx = setup();
      const { stdin } = render(
        <InputBox store={ctx.store} registry={ctx.reg} sources={ctx.sources} theme={DEFAULT_THEME} onSubmit={ctx.onSubmit} />,
      );
      await tick();
      stdin.write("\x1b[200~hello\nworld\x1b[201~");
      await tick();
      expect(ctx.store.snapshot().input.value).toBe("[Pasted text #1 +2 lines]");
      stdin.write("\x7f"); // backspace
      await tick();
      expect(ctx.store.snapshot().input.value).toBe("");
      expect(ctx.store.snapshot().input.cursor).toBe(0);
    });

    it("backspace works atomically on a manually typed placeholder", async () => {
      const ctx = setup();
      const { stdin } = render(
        <InputBox store={ctx.store} registry={ctx.reg} sources={ctx.sources} theme={DEFAULT_THEME} onSubmit={ctx.onSubmit} />,
      );
      await tick();
      stdin.write("a[Pasted text #99 +3 lines]b");
      await tick();
      // Cursor at end (29). Move to just past the "]" (cursor 28) so backspace
      // hits the placeholder boundary.
      const v = ctx.store.snapshot().input.value;
      const idx = v.indexOf("]") + 1;
      ctx.store.setInput(v, idx);
      await tick();
      stdin.write("\x7f"); // backspace
      await tick();
      expect(ctx.store.snapshot().input.value).toBe("ab");
      expect(ctx.store.snapshot().input.cursor).toBe(1);
    });

    it("Left arrow at end of placeholder jumps to its start atomically", async () => {
      const ctx = setup();
      const { stdin } = render(
        <InputBox store={ctx.store} registry={ctx.reg} sources={ctx.sources} theme={DEFAULT_THEME} onSubmit={ctx.onSubmit} />,
      );
      await tick();
      stdin.write("ab");
      await tick();
      stdin.write("\x1b[200~PASTED\x1b[201~");
      await tick();
      stdin.write("cd");
      await tick();
      // Buffer: "ab[Pasted text #1 +1 line]cd". Cursor at end (28).
      const v = ctx.store.snapshot().input.value;
      expect(v).toBe("ab[Pasted text #1 +1 line]cd");
      expect(ctx.store.snapshot().input.cursor).toBe(v.length);
      stdin.write("\x1b[D"); await tick(); // Left → over "d"
      expect(ctx.store.snapshot().input.cursor).toBe(v.length - 1);
      stdin.write("\x1b[D"); await tick(); // Left → over "c"
      expect(ctx.store.snapshot().input.cursor).toBe(v.length - 2);
      stdin.write("\x1b[D"); await tick(); // Left across the placeholder
      expect(ctx.store.snapshot().input.cursor).toBe(2); // before "[Pasted..."
    });

    it("Right arrow at start of placeholder jumps to its end atomically", async () => {
      const ctx = setup();
      const { stdin } = render(
        <InputBox store={ctx.store} registry={ctx.reg} sources={ctx.sources} theme={DEFAULT_THEME} onSubmit={ctx.onSubmit} />,
      );
      await tick();
      stdin.write("ab");
      await tick();
      stdin.write("\x1b[200~PASTED\x1b[201~");
      await tick();
      stdin.write("cd");
      await tick();
      const v = ctx.store.snapshot().input.value;
      ctx.store.setInput(v, 2); // cursor right before "["
      await tick();
      stdin.write("\x1b[C"); await tick(); // Right across the placeholder
      const phEnd = v.indexOf("]") + 1;
      expect(ctx.store.snapshot().input.cursor).toBe(phEnd);
    });

    it("Option+Left across a placeholder lands on its start", async () => {
      const ctx = setup();
      const { stdin } = render(
        <InputBox store={ctx.store} registry={ctx.reg} sources={ctx.sources} theme={DEFAULT_THEME} onSubmit={ctx.onSubmit} />,
      );
      await tick();
      stdin.write("hello ");
      await tick();
      stdin.write("\x1b[200~PASTED\x1b[201~");
      await tick();
      stdin.write(" world");
      await tick();
      // Buffer: "hello [Pasted text #1 +1 line] world". Cursor at end.
      const v = ctx.store.snapshot().input.value;
      expect(ctx.store.snapshot().input.cursor).toBe(v.length);
      stdin.write("\x1b[1;3D"); await tick(); // Option+Left → start of "world"
      stdin.write("\x1b[1;3D"); await tick(); // Option+Left across placeholder
      // Should not be inside the placeholder.
      const c = ctx.store.snapshot().input.cursor;
      const phStart = v.indexOf("[Pasted");
      const phEnd = v.indexOf("]") + 1;
      expect(c <= phStart || c >= phEnd).toBe(true);
    });

    it("paste text mixed with typed text expands only the placeholder", async () => {
      const ctx = setup();
      let submitted = "";
      const { stdin } = render(
        <InputBox store={ctx.store} registry={ctx.reg} sources={ctx.sources} theme={DEFAULT_THEME} onSubmit={(t) => { submitted = t; }} />,
      );
      await tick();
      stdin.write("before ");
      await tick();
      stdin.write("\x1b[200~PASTED\x1b[201~");
      await tick();
      stdin.write(" after");
      await tick();
      stdin.write("\r");
      await tick();
      expect(submitted).toBe("before PASTED after");
    });
  });

  describe("Ctrl+C two-step exit", () => {
    it("first press shows hint and clears buffer; does NOT call onExit", async () => {
      const ctx = setup();
      let exited = false;
      const { stdin, lastFrame } = render(
        <InputBox store={ctx.store} registry={ctx.reg} sources={ctx.sources} theme={DEFAULT_THEME} onSubmit={ctx.onSubmit} onExit={() => { exited = true; }} />,
      );
      await tick();
      stdin.write("draft");
      await tick();
      stdin.write("\x03"); // Ctrl+C
      await tick();
      expect(exited).toBe(false);
      expect(ctx.store.snapshot().input.value).toBe("");
      expect(lastFrame()).toContain("Press Ctrl-C again to exit");
    });

    it("hint clears after the exit window expires", async () => {
      const ctx = setup();
      const { stdin, lastFrame } = render(
        <InputBox store={ctx.store} registry={ctx.reg} sources={ctx.sources} theme={DEFAULT_THEME} onSubmit={ctx.onSubmit} onExit={() => {}} />,
      );
      await tick();
      stdin.write("\x03");
      await tick();
      expect(lastFrame()).toContain("Press Ctrl-C again to exit");
      // Window is 2000ms; wait it out and confirm the hint is gone.
      await tick(2100);
      expect(lastFrame()).not.toContain("Press Ctrl-C again to exit");
    });

    it("second Ctrl+C within window calls onExit", async () => {
      const ctx = setup();
      let exitCount = 0;
      const { stdin } = render(
        <InputBox store={ctx.store} registry={ctx.reg} sources={ctx.sources} theme={DEFAULT_THEME} onSubmit={ctx.onSubmit} onExit={() => { exitCount++; }} />,
      );
      await tick();
      stdin.write("\x03");
      await tick();
      stdin.write("\x03");
      await tick();
      expect(exitCount).toBe(1);
    });
  });

  it("opens popup from a match-based source", async () => {
    const ctx = setup();
    const src: import("llm-contracts/public").CompletionSource = {
      id: "args",
      match: (line: string, _cursor: number) => {
        if (line === "/foo bar") return { triggerPos: 5, query: "bar" };
        return null;
      },
      list: (q: string) => [{ label: `key:${q}`, insertText: `key:${q}` }],
    };
    ctx.sources.set(src.id, src);
    ctx.reg.service.register(src);
    const { stdin } = render(
      <InputBox store={ctx.store} registry={ctx.reg} sources={ctx.sources} theme={DEFAULT_THEME} onSubmit={ctx.onSubmit} />,
    );
    await tick();
    stdin.write("/foo bar");
    await tick(80);
    const popup = ctx.store.snapshot().popup;
    expect(popup?.sourceId).toBe("args");
    expect(popup?.anchor).toBe(5);
    expect(popup?.query).toBe("bar");
    expect(popup?.items.map(i => i.label)).toEqual(["key:bar"]);
  });

  it("picks up sources registered after mount (regression: char trigger)", async () => {
    // In production, llm-slash-commands registers its sources on harness:start
    // which fires AFTER the TUI mounts. The InputBox must observe those
    // registrations and treat their trigger chars as live.
    const ctx = setup();
    const { stdin } = render(
      <InputBox store={ctx.store} registry={ctx.reg} sources={ctx.sources} theme={DEFAULT_THEME} onSubmit={ctx.onSubmit} />,
    );
    await tick();
    // Register the "/" source AFTER mount.
    ctx.reg.service.register({
      id: "post-mount",
      trigger: "/",
      list: () => [{ label: "/help", insertText: "/help " }],
    });
    await tick();
    stdin.write("/");
    await tick(60);
    expect(ctx.store.snapshot().popup?.trigger).toBe("/");
    expect(ctx.store.snapshot().popup?.items.map(i => i.label)).toEqual(["/help"]);
  });

  it("keeps match-based popup open while typing additional characters", async () => {
    const ctx = setup();
    const src: import("llm-contracts/public").CompletionSource = {
      id: "args-keep",
      match: (line: string, _c: number) =>
        line.startsWith("/cmd ") ? { triggerPos: 5, query: line.slice(5) } : null,
      list: (q: string) => [{ label: `it:${q}`, insertText: `it:${q}` }],
    };
    ctx.sources.set(src.id, src);
    ctx.reg.service.register(src);
    const { stdin } = render(
      <InputBox store={ctx.store} registry={ctx.reg} sources={ctx.sources} theme={DEFAULT_THEME} onSubmit={ctx.onSubmit} />,
    );
    await tick();
    stdin.write("/cmd ");
    await tick(80);
    expect(ctx.store.snapshot().popup?.sourceId).toBe("args-keep");
    // Type into the open match-based popup — popup must remain open and query must update.
    stdin.write("a");
    await tick(80);
    expect(ctx.store.snapshot().popup?.sourceId).toBe("args-keep");
    expect(ctx.store.snapshot().popup?.query).toBe("a");
    stdin.write("b");
    await tick(80);
    expect(ctx.store.snapshot().popup?.sourceId).toBe("args-keep");
    expect(ctx.store.snapshot().popup?.query).toBe("ab");
  });

  it("closes match-based popup when match returns null", async () => {
    const ctx = setup();
    const src: import("llm-contracts/public").CompletionSource = {
      id: "args2",
      match: (line: string, _c: number) => line.startsWith("/foo ") ? { triggerPos: 5, query: line.slice(5) } : null,
      list: (q: string) => [{ label: q || "(empty)", insertText: q }],
    };
    ctx.sources.set(src.id, src);
    ctx.reg.service.register(src);
    const { stdin } = render(
      <InputBox store={ctx.store} registry={ctx.reg} sources={ctx.sources} theme={DEFAULT_THEME} onSubmit={ctx.onSubmit} />,
    );
    await tick();
    stdin.write("/foo ");
    await tick(80);
    expect(ctx.store.snapshot().popup?.sourceId).toBe("args2");
    // Backspace 5 times to remove "/foo " — match returns null after that.
    for (let i = 0; i < 5; i++) stdin.write("\x7f"); // DEL (backspace)
    await tick(80);
    expect(ctx.store.snapshot().popup).toBeNull();
  });

  it("Up arrow recalls history when popup is closed", async () => {
    const ctx = setup();
    ctx.store.submit("first");
    const { stdin, lastFrame } = render(
      <InputBox store={ctx.store} registry={ctx.reg} sources={ctx.sources} theme={DEFAULT_THEME} onSubmit={ctx.onSubmit} />,
    );
    await tick();
    stdin.write("\x1b[A");
    await tick();
    expect(lastFrame()).toContain("first");
  });
});

describe("InputBox Ctrl+X copy", () => {
  function harness(opts?: {
    copyToClipboard?: (text: string) => Promise<{ ok: boolean; via: string; error?: string }>;
  }) {
    const ctx = setup();
    const view = render(
      <InputBox
        store={ctx.store}
        registry={ctx.reg}
        sources={ctx.sources}
        theme={DEFAULT_THEME}
        onSubmit={ctx.onSubmit}
        copyToClipboard={opts?.copyToClipboard}
      />,
    );
    return { store: ctx.store, view };
  }

  it("posts 'nothing to copy yet' when no output exists", async () => {
    const { store, view } = harness();
    view.stdin.write("\x18"); // Ctrl+X
    await tick();
    const snap = store.snapshot();
    const notices = snap.transcript.filter((e) => e.kind === "notice");
    expect(notices.at(-1)?.text).toContain("nothing to copy");
    view.unmount();
  });

  it("calls injected copyToClipboard with latest output text", async () => {
    let received: string | undefined;
    const fakeCopy = async (text: string) => {
      received = text;
      return { ok: true, via: "pbcopy" as const };
    };
    const { store, view } = harness({ copyToClipboard: fakeCopy });
    store.appendOutput("the answer");
    view.stdin.write("\x18");
    await tick();
    expect(received).toBe("the answer");
    const notices = store.snapshot().transcript.filter((e) => e.kind === "notice");
    expect(notices.at(-1)?.text).toMatch(/copied .* chars/);
    view.unmount();
  });

  it("surfaces failure as a notice", async () => {
    const fakeCopy = async () => ({ ok: false, via: "none" as const, error: "no clipboard mechanism" });
    const { store, view } = harness({ copyToClipboard: fakeCopy });
    store.appendOutput("ignored");
    view.stdin.write("\x18");
    await tick();
    const notices = store.snapshot().transcript.filter((e) => e.kind === "notice");
    expect(notices.at(-1)?.text).toContain("copy failed");
    expect(notices.at(-1)?.text).toContain("no clipboard mechanism");
    view.unmount();
  });

  it("Ctrl+X does not fall through to typing 'x'", async () => {
    const { store, view } = harness();
    view.stdin.write("\x18"); // Ctrl+X
    await tick();
    expect(store.snapshot().input.value).toBe("");
    view.unmount();
  });
});
