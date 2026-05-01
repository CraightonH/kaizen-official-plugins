import React from "react";
import { describe, it, expect } from "bun:test";
import { render } from "ink-testing-library";
import { StatusBar } from "./StatusBar.tsx";

describe("StatusBar", () => {
  it("renders nothing when empty", () => {
    const { lastFrame } = render(<StatusBar items={{}} color="gray" />);
    expect(lastFrame() ?? "").toBe("");
  });

  it("renders items in insertion order with separators", () => {
    const { lastFrame } = render(
      <StatusBar items={{ branch: "main", model: "gpt-4o" }} color="gray" />,
    );
    const f = lastFrame() ?? "";
    expect(f).toContain("branch main");
    expect(f).toContain("model gpt-4o");
    expect(f.indexOf("branch")).toBeLessThan(f.indexOf("model"));
  });
});
