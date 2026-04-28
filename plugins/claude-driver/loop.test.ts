import { describe, it, expect } from "bun:test";
import { runTurn, buildArgs } from "./loop.ts";
import type { ClaudeSpawner } from "./spawn.ts";

function fakeSpawner(lines: string[]): ClaudeSpawner {
  return () => {
    let alive = true;
    return {
      stdout: (async function* () {
        for (const l of lines) yield l;
        alive = false; // simulates clean exit after stream ends
      })(),
      stderr: () => "",
      kill: () => { alive = false; },
      wait: async () => 0,
      isAlive: () => alive,
    };
  };
}

describe("buildArgs", () => {
  it("omits --continue on first turn, includes it after", () => {
    expect(buildArgs("hi", false)).not.toContain("--continue");
    expect(buildArgs("hi", true)).toContain("--continue");
  });
  it("always includes stream-json flags", () => {
    const args = buildArgs("hi", false);
    expect(args).toEqual(expect.arrayContaining([
      "-p", "hi", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    ]));
  });
});

describe("runTurn", () => {
  const lines = [
    JSON.stringify({ type: "system", subtype: "init", model: "opus-4.7", session_id: "s1" }),
    JSON.stringify({ type: "stream_event", event: { delta: { type: "text_delta", text: "Hello" } } }),
    JSON.stringify({ type: "stream_event", event: { delta: { type: "text_delta", text: " world" } } }),
    JSON.stringify({
      type: "result", session_id: "s1", duration_ms: 100,
      usage: { input_tokens: 10, output_tokens: 5 },
    }),
  ];

  it("streams text deltas and emits init/result", async () => {
    const writes: string[] = [];
    const emitted: Array<{ ev: string; p: any }> = [];
    const result = await runTurn({
      prompt: "hi",
      hasSession: false,
      spawner: fakeSpawner(lines),
      writeOutput: (c) => writes.push(c),
      emit: async (ev, p) => { emitted.push({ ev, p }); },
      log: () => {},
    });
    expect(writes.join("")).toBe("Hello world\n");
    expect(emitted.find((e) => e.ev === "status:item-update" && e.p.id === "llm.model")?.p.content).toBe("opus-4.7");
    expect(emitted.find((e) => e.ev === "status:item-update" && e.p.id === "llm.context")?.p.content).toMatch(/10.*5/);
    expect(result.sessionId).toBe("s1");
  });

  it("drops malformed lines silently", async () => {
    const withGarbage = [...lines.slice(0, 2), "{not json", ...lines.slice(2)];
    const writes: string[] = [];
    await runTurn({
      prompt: "hi", hasSession: false, spawner: fakeSpawner(withGarbage),
      writeOutput: (c) => writes.push(c),
      emit: async () => {},
      log: () => {},
    });
    expect(writes.join("")).toBe("Hello world\n");
  });

  it("kills child if it stays alive after result (hang bug guard)", async () => {
    let killed: NodeJS.Signals | null = null;
    const spawner: ClaudeSpawner = () => ({
      stdout: (async function* () { for (const l of lines) yield l; })(),
      stderr: () => "",
      kill: (sig) => { if (killed === null) killed = sig; },
      wait: async () => 0,
      isAlive: () => true,  // never dies
    });
    await runTurn({
      prompt: "hi", hasSession: false, spawner,
      writeOutput: () => {}, emit: async () => {}, log: () => {},
      graceMs: 10,
    });
    expect(killed).toBe("SIGTERM");
  });
});
