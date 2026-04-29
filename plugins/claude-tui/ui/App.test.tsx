import React from "react";
import { describe, it, expect } from "bun:test";
import { render } from "ink-testing-library";
import { App } from "./App.tsx";
import { TuiStore } from "../state/store.ts";

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

describe("App", () => {
  it("renders the rounded prompt with ❯", async () => {
    const store = new TuiStore();
    const { lastFrame } = render(<App store={store} />);
    await tick();
    expect(lastFrame()).toContain("❯");
    expect(lastFrame()).toMatch(/[╭╮╯╰]/);
  });

  it("shows typed characters inside the box", async () => {
    const store = new TuiStore();
    const { stdin, lastFrame } = render(<App store={store} />);
    await tick();
    stdin.write("hello");
    await tick();
    expect(lastFrame()).toContain("❯ hello");
  });

  it("Enter resolves pending readInput with the typed line", async () => {
    const store = new TuiStore();
    const { stdin } = render(<App store={store} />);
    await tick();
    const p = store.awaitInput();
    stdin.write("ping");
    await tick();
    stdin.write("\r");
    expect(await p).toBe("ping");
  });

  it("/clear empties the log and does NOT resolve readInput", async () => {
    const store = new TuiStore();
    store.appendOutput("noise-1");
    store.appendOutput("noise-2");
    const { stdin } = render(<App store={store} />);
    await tick();
    let resolved = false;
    store.awaitInput().then(() => { resolved = true; });
    stdin.write("/clear");
    await tick();
    stdin.write("\r");
    await tick();
    expect(store.snapshot().log.length).toBe(0);
    expect(resolved).toBe(false);
  });

  it("up-arrow recalls last submitted line", async () => {
    const store = new TuiStore();
    const { stdin, lastFrame } = render(<App store={store} />);
    await tick();
    store.awaitInput();
    stdin.write("first");
    await tick();
    stdin.write("\r");
    await tick();
    stdin.write("\x1b[A"); // up arrow
    await tick();
    expect(lastFrame()).toContain("❯ first");
  });

  it("setBusy(true,msg) renders SpinnerLine; setBusy(false) removes it", async () => {
    const store = new TuiStore();
    const { lastFrame } = render(<App store={store} />);
    await tick();
    store.setBusy(true, "thinking…");
    await tick();
    expect(lastFrame()).toContain("thinking…");
    store.setBusy(false);
    await tick();
    expect(lastFrame()).not.toContain("thinking…");
  });

  it("upsertStatus renders an item in the status bar", async () => {
    const store = new TuiStore();
    const { lastFrame } = render(<App store={store} />);
    await tick();
    store.upsertStatus({ id: "branch", text: "main" });
    await tick();
    expect(lastFrame()).toContain("main");
  });

});
