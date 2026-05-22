import { describe, test, expect } from "bun:test";
import { validate } from "../../kaizen-config/schema.ts";
import { BUILT_IN_THEME, COLOR_PATTERN, THEME_SCHEMA } from "./schema.ts";

const COLOR_RE = new RegExp(COLOR_PATTERN);

const NAMED_COLORS = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "gray", "grey",
  "blackBright", "redBright", "greenBright", "yellowBright",
  "blueBright", "magentaBright", "cyanBright", "whiteBright",
];

describe("COLOR_PATTERN", () => {
  test("accepts every named color the legacy loader allowed", () => {
    for (const c of NAMED_COLORS) expect(COLOR_RE.test(c)).toBe(true);
  });
  test("accepts 6-digit hex in lower and upper case", () => {
    expect(COLOR_RE.test("#abcdef")).toBe(true);
    expect(COLOR_RE.test("#ABCDEF")).toBe(true);
    expect(COLOR_RE.test("#012345")).toBe(true);
  });
  test("rejects unknown names", () => {
    expect(COLOR_RE.test("purple")).toBe(false);
    expect(COLOR_RE.test("orange")).toBe(false);
  });
  test("rejects 3-digit hex and bad hex", () => {
    expect(COLOR_RE.test("#abc")).toBe(false);
    expect(COLOR_RE.test("#gghhii")).toBe(false);
    expect(COLOR_RE.test("red123")).toBe(false);
  });
  test("rejects empty string", () => {
    expect(COLOR_RE.test("")).toBe(false);
  });
});

describe("BUILT_IN_THEME", () => {
  test("passes its own schema", () => {
    const r = validate(BUILT_IN_THEME, THEME_SCHEMA);
    expect(r.ok).toBe(true);
  });
});

describe("THEME_SCHEMA validation via kaizen-config", () => {
  test("rejects bad color value", () => {
    const r = validate(
      { ...BUILT_IN_THEME, promptColor: "purple" },
      THEME_SCHEMA,
    );
    expect(r.ok).toBe(false);
  });
  test("rejects empty promptLabel", () => {
    const r = validate(
      { ...BUILT_IN_THEME, promptLabel: "" },
      THEME_SCHEMA,
    );
    expect(r.ok).toBe(false);
  });
  test("rejects non-boolean thoughtsMarkdown", () => {
    const r = validate(
      { ...BUILT_IN_THEME, thoughtsMarkdown: "yes" as unknown as boolean },
      THEME_SCHEMA,
    );
    expect(r.ok).toBe(false);
  });
  test("accepts hex color", () => {
    const r = validate(
      { ...BUILT_IN_THEME, promptColor: "#aabbcc" },
      THEME_SCHEMA,
    );
    expect(r.ok).toBe(true);
  });
});
