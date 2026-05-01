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
});
