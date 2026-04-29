import { describe, it, expect } from "bun:test";
import { handleSlash } from "./slash.ts";
import { TuiStore } from "./state/store.ts";

describe("handleSlash", () => {
  it("returns 'forward' for non-slash input", () => {
    const s = new TuiStore();
    expect(handleSlash("hello", s)).toBe("forward");
  });

  it("returns 'forward' for /exit (caller decides)", () => {
    const s = new TuiStore();
    expect(handleSlash("/exit", s)).toBe("forward");
  });

  it("returns 'forward' for unknown slash commands", () => {
    const s = new TuiStore();
    expect(handleSlash("/unknown", s)).toBe("forward");
  });

  it("clears log and returns 'swallow' for /clear", () => {
    const s = new TuiStore();
    s.appendOutput("noise");
    expect(handleSlash("/clear", s)).toBe("swallow");
    expect(s.snapshot().log.length).toBe(0);
  });

  it("trims whitespace before matching", () => {
    const s = new TuiStore();
    s.appendOutput("noise");
    expect(handleSlash("  /clear  ", s)).toBe("swallow");
    expect(s.snapshot().log.length).toBe(0);
  });
});
