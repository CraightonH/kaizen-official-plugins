import React from "react";
import { describe, it, expect } from "bun:test";
import { render } from "ink-testing-library";
import { SpinnerLine } from "./SpinnerLine.tsx";

describe("SpinnerLine", () => {
  it("renders default 'thinking' message", () => {
    const { lastFrame } = render(<SpinnerLine color="magenta" />);
    expect(lastFrame()).toContain("thinking");
  });

  it("renders custom message", () => {
    const { lastFrame } = render(<SpinnerLine color="magenta" message="streaming" />);
    expect(lastFrame()).toContain("streaming");
  });

  it("renders elapsed time and token delta when startedAt is provided", () => {
    const now = Date.now();
    const { lastFrame } = render(<SpinnerLine color="magenta" message="honking" startedAt={now} deltaTokens={856} />);
    const frame = lastFrame()!;
    expect(frame).toContain("honking");
    expect(frame).toContain("↓ 856 tokens");
    // Should contain elapsed time like "(0s" or "(1s"
    expect(frame).toMatch(/\(\d+s · ↓ 856 tokens\)/);
  });

  it("formats duration > 60s correctly", () => {
    const now = Date.now() - 125000; // 2m 5s ago
    const { lastFrame } = render(<SpinnerLine color="magenta" startedAt={now} deltaTokens={100} />);
    const frame = lastFrame()!;
    expect(frame).toMatch(/\(2m 5s · ↓ 100 tokens\)/);
  });
});
