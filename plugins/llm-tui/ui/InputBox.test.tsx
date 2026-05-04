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
