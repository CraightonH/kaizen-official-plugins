import { describe, it, expect } from "bun:test";
import { bucketFor, normalizeServerName } from "../buckets.ts";

describe("bucketFor", () => {
  it("maps known kinds to their dedicated buckets", () => {
    expect(bucketFor({ kind: "local" })).toEqual({ kind: "tools" });
    expect(bucketFor({ kind: "agent" })).toEqual({ kind: "agents" });
    expect(bucketFor({ kind: "skill" })).toEqual({ kind: "skills" });
    expect(bucketFor({ kind: "memory" })).toEqual({ kind: "memory" });
  });

  it("normalizes the mcp server name", () => {
    expect(bucketFor({ kind: "mcp", server: "cloudflare-fs" })).toEqual({
      kind: "mcp",
      server: "cloudflare_fs",
    });
  });

  it("falls back to `tools` for unknown kinds (byte-stable for known kinds)", () => {
    expect(bucketFor({ kind: "workflow" })).toEqual({ kind: "tools" });
    expect(bucketFor({ kind: "remote", endpoint: "https://x" } as any)).toEqual({ kind: "tools" });
  });

  it("falls back to `unknown` server when mcp source lacks a server string", () => {
    expect(bucketFor({ kind: "mcp" } as any)).toEqual({ kind: "mcp", server: "unknown" });
    expect(bucketFor({ kind: "mcp", server: 42 } as any)).toEqual({ kind: "mcp", server: "unknown" });
  });
});

describe("normalizeServerName (re-exported by assembler)", () => {
  it("strips non-alphanumerics and prefixes leading digits", () => {
    expect(normalizeServerName("foo.bar")).toBe("foo_bar");
    expect(normalizeServerName("2024-x")).toBe("_2024_x");
  });
});
