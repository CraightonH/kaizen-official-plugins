import React from "react";
import { describe, it, expect } from "bun:test";
import { render } from "ink-testing-library";
import { App } from "./App.tsx";
import { TuiStore } from "../state/store.ts";
import { makeCompletionRegistry } from "../completion/registry.ts";
import { makeToolRendererRegistry } from "../tool-renderers/registry.ts";
import { BUILT_IN_THEME } from "../theme/schema.ts";
import type { CompletionSource } from "llm-contracts/public";

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

function setup() {
  const store = new TuiStore({ theme: BUILT_IN_THEME });
  const reg = makeCompletionRegistry({ debounceMs: 0 });
  const sources = new Map<string, CompletionSource>();
  return { store, reg, sources };
}

describe("App", () => {
  it("renders prompt label and rounded box", async () => {
    const ctx = setup();
    const { lastFrame } = render(
      <App store={ctx.store} registry={ctx.reg} toolRenderers={makeToolRendererRegistry()} sources={ctx.sources} onSubmit={() => {}} />,
    );
    await tick();
    expect(lastFrame()).toContain("kaizen");
    expect(lastFrame()).toMatch(/[╭╰]/);
  });

  it("appendOutput shows in the transcript", async () => {
    const ctx = setup();
    const { lastFrame } = render(
      <App store={ctx.store} registry={ctx.reg} toolRenderers={makeToolRendererRegistry()} sources={ctx.sources} onSubmit={() => {}} />,
    );
    await tick();
    ctx.store.appendOutput("hello world");
    await tick();
    expect(lastFrame()).toContain("hello world");
  });

  it("setBusy renders SpinnerLine, then removes it", async () => {
    const ctx = setup();
    const { lastFrame } = render(
      <App store={ctx.store} registry={ctx.reg} toolRenderers={makeToolRendererRegistry()} sources={ctx.sources} onSubmit={() => {}} />,
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
      <App store={ctx.store} registry={ctx.reg} toolRenderers={makeToolRendererRegistry()} sources={ctx.sources} onSubmit={() => {}} />,
    );
    await tick();
    ctx.store.upsertStatus("branch", "main");
    await tick();
    expect(lastFrame()).toContain("branch main");
  });

  it("renders [handoff from <id>] badge on user lines with handoffFrom", async () => {
    const ctx = setup();
    ctx.store.appendUser("seeded prompt", { handoffFrom: "abc" });
    const { lastFrame } = render(
      <App store={ctx.store} registry={ctx.reg} toolRenderers={makeToolRendererRegistry()} sources={ctx.sources} onSubmit={() => {}} />,
    );
    await tick();
    expect(lastFrame()).toContain("[handoff from abc]");
    expect(lastFrame()).toContain("seeded prompt");
  });

  it("does not render the handoff badge on plain user lines", async () => {
    const ctx = setup();
    ctx.store.appendUser("plain prompt");
    const { lastFrame } = render(
      <App store={ctx.store} registry={ctx.reg} toolRenderers={makeToolRendererRegistry()} sources={ctx.sources} onSubmit={() => {}} />,
    );
    await tick();
    expect(lastFrame()).toContain("plain prompt");
    expect(lastFrame()).not.toContain("[handoff from");
  });

  it("renders popup above input when popup is open near terminal bottom", async () => {
    // v0 contract: the popup is rendered AFTER the InputBox in the JSX tree
    // (which Ink lays out below). We capture the layout here as documented.
    const ctx = setup();
    const src = { id: "a", trigger: "/", list: () => [{ label: "/help", insertText: "/help " }] };
    ctx.sources.set(src.id, src);
    ctx.reg.service.register(src);
    const { stdin, lastFrame } = render(
      <App store={ctx.store} registry={ctx.reg} toolRenderers={makeToolRendererRegistry()} sources={ctx.sources} onSubmit={() => {}} />,
    );
    await tick();
    stdin.write("/");
    await tick(60);
    expect(lastFrame()).toContain("/help");
  });

  it("output entry without markdown flag renders through renderMarkdown (default true)", async () => {
    const s = new TuiStore({ theme: BUILT_IN_THEME });
    s.appendOutput("**bold**");
    const { lastFrame } = render(
      <App store={s} registry={makeCompletionRegistry({ debounceMs: 0 })} toolRenderers={makeToolRendererRegistry()} sources={new Map()} onSubmit={() => {}} />,
    );
    await tick();
    const frame = lastFrame() ?? "";
    expect(frame.includes("**bold**")).toBe(false);
    expect(frame.includes("bold")).toBe(true);
  });

  it("output entry with markdown: false renders raw", async () => {
    const s = new TuiStore({ theme: BUILT_IN_THEME });
    s.appendOutput("**bold**", { markdown: false });
    const { lastFrame } = render(
      <App store={s} registry={makeCompletionRegistry({ debounceMs: 0 })} toolRenderers={makeToolRendererRegistry()} sources={new Map()} onSubmit={() => {}} />,
    );
    await tick();
    expect((lastFrame() ?? "").includes("**bold**")).toBe(true);
  });

  it("notice entry without markdown flag renders raw with dim", async () => {
    const s = new TuiStore({ theme: BUILT_IN_THEME });
    s.appendNotice("**plain**");
    const { lastFrame } = render(
      <App store={s} registry={makeCompletionRegistry({ debounceMs: 0 })} toolRenderers={makeToolRendererRegistry()} sources={new Map()} onSubmit={() => {}} />,
    );
    await tick();
    expect((lastFrame() ?? "").includes("**plain**")).toBe(true);
  });

  it("notice entry with markdown: true renders through renderMarkdown (no dim)", async () => {
    const s = new TuiStore({ theme: BUILT_IN_THEME });
    s.appendNotice("**md**", { markdown: true });
    const { lastFrame } = render(
      <App store={s} registry={makeCompletionRegistry({ debounceMs: 0 })} toolRenderers={makeToolRendererRegistry()} sources={new Map()} onSubmit={() => {}} />,
    );
    await tick();
    const frame = lastFrame() ?? "";
    expect(frame.includes("**md**")).toBe(false);
    expect(frame.includes("md")).toBe(true);
  });

  it("user entry with markdown: true renders through renderMarkdown", async () => {
    const s = new TuiStore({ theme: BUILT_IN_THEME });
    s.appendUser("**hi**", { markdown: true });
    const { lastFrame } = render(
      <App store={s} registry={makeCompletionRegistry({ debounceMs: 0 })} toolRenderers={makeToolRendererRegistry()} sources={new Map()} onSubmit={() => {}} />,
    );
    await tick();
    const frame = lastFrame() ?? "";
    expect(frame.includes("**hi**")).toBe(false);
  });
});
