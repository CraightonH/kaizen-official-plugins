import { describe, it, expect } from "bun:test";
import {
  BareNamePluginError,
  ReentrantSlashEmitError,
  DuplicateRegistrationError,
  InvalidNameError,
} from "../errors.ts";

describe("error classes", () => {
  it("BareNamePluginError carries name and is instanceof Error", () => {
    const e = new BareNamePluginError("foo");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("BareNamePluginError");
    expect(e.bareName).toBe("foo");
    expect(e.message).toMatch(/foo/);
    expect(e.message).toMatch(/<source>:<name>/);
  });

  it("ReentrantSlashEmitError flags input:submit re-entry", () => {
    const e = new ReentrantSlashEmitError("input:submit");
    expect(e.event).toBe("input:submit");
    expect(e.name).toBe("ReentrantSlashEmitError");
  });

  it("DuplicateRegistrationError carries the duplicate name", () => {
    const e = new DuplicateRegistrationError("help");
    expect(e.name).toBe("DuplicateRegistrationError");
    expect(e.duplicateName).toBe("help");
  });

  it("InvalidNameError carries the offending name", () => {
    const e = new InvalidNameError("Bad-NAME");
    expect(e.name).toBe("InvalidNameError");
    expect(e.invalidName).toBe("Bad-NAME");
  });
});
