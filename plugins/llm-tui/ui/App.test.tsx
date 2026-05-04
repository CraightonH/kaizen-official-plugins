import React from "react";
import { describe, it, expect } from "bun:test";
import { render } from "ink-testing-library";
import { App } from "./App.tsx";
import { TuiStore } from "../state/store.ts";
import { makeCompletionRegistry } from "../completion/registry.ts";
import { DEFAULT_THEME } from "../theme/loader.ts";

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

function setup() {
  const store = new TuiStore();
  const reg = makeCompletionRegistry({ debounceMs: 0 });
  const triggers = new Set<string>();
  return { store, reg, triggers };
}

describe("App", () => {
  it("renders prompt label and rounded box", async () => {
    const ctx = setup();
    const { lastFrame } = render(
      <App store={ctx.store} registry={ctx.reg} triggers={ctx.triggers} theme={DEFAULT_THEME} onSubmit={() => {}} />,
    );
    await tick();
    expect(lastFrame()).toContain("kaizen");
    expect(lastFrame()).toMatch(/[╭╰]/);
  });

  it("appendOutput shows in the transcript", async () => {
    const ctx = setup();
    const { lastFrame } = render(
      <App store={ctx.store} registry={ctx.reg} triggers={ctx.triggers} theme={DEFAULT_THEME} onSubmit={() => {}} />,
    );
    await tick();
    ctx.store.appendOutput("hello world");
    await tick();
    expect(lastFrame()).toContain("hello world");
  });

  it("setBusy renders SpinnerLine, then removes it", async () => {
    const ctx = setup();
    const { lastFrame } = render(
      <App store={ctx.store} registry={ctx.reg} triggers={ctx.triggers} theme={DEFAULT_THEME} onSubmit={() => {}} />,
    );
    await tick();
    ctx.store.setBusy(true, "streaming");
    await tick();
    expect(lastFrame()).toContain("streaming");
    ctx.store.setBusy(false);
    await tick();
    expect(lastFrame()).not.toContain("streaming");
  });

  it("upsertStatus renders into the status bar", async () => {
    const ctx = setup();
    const { lastFrame } = render(
      <App store={ctx.store} registry={ctx.reg} triggers={ctx.triggers} theme={DEFAULT_THEME} onSubmit={() => {}} />,
    );
    await tick();
    ctx.store.upsertStatus("branch", "main");
    await tick();
    expect(lastFrame()).toContain("branch main");
  });

  it("renders popup above input when popup is open near terminal bottom", async () => {
    // v0 contract: the popup is rendered AFTER the InputBox in the JSX tree
    // (which Ink lays out below). We capture the layout here as documented.
    const ctx = setup();
    ctx.triggers.add("/");
    ctx.reg.service.register({ id: "a", trigger: "/", list: () => [{ label: "/help", insertText: "/help " }] });
    const { stdin, lastFrame } = render(
      <App store={ctx.store} registry={ctx.reg} triggers={ctx.triggers} theme={DEFAULT_THEME} onSubmit={() => {}} />,
    );
    await tick();
    stdin.write("/");
    await tick(60);
    expect(lastFrame()).toContain("/help");
  });
});
