import { describe, it, expect } from "bun:test";
import { buildKaizenTree, type RegistrationLike } from "../kaizen-tree.ts";
import type { ToolSource } from "llm-tools-registry/public";

function r(name: string, source: ToolSource): RegistrationLike {
  return { name, source };
}

describe("buildKaizenTree — shape-locking", () => {
  it("places every known bucket kind in its dedicated namespace in one pass", () => {
    const tree = buildKaizenTree(
      [
        r("read_file", { kind: "local" }),
        r("write_file", { kind: "local" }),
        r("filesystem_read", { kind: "mcp", server: "filesystem" }),
        r("ping", { kind: "mcp", server: "cloudflare-fs" }),
        r("delegate", { kind: "agent" }),
        r("brainstorm", { kind: "skill" }),
        r("recall", { kind: "memory" }),
      ],
      (name) => `leaf:${name}`,
    );

    expect(Object.keys(tree.tools ?? {}).sort()).toEqual(["read_file", "write_file"]);
    expect(Object.keys(tree.mcp ?? {}).sort()).toEqual(["cloudflare_fs", "filesystem"]);
    expect(Object.keys(tree.mcp!.filesystem!)).toEqual(["filesystem_read"]);
    expect(Object.keys(tree.mcp!.cloudflare_fs!)).toEqual(["ping"]);
    expect(Object.keys(tree.agents ?? {})).toEqual(["delegate"]);
    expect(Object.keys(tree.skills ?? {})).toEqual(["brainstorm"]);
    expect(Object.keys(tree.memory ?? {})).toEqual(["recall"]);
  });

  it("omits namespaces with no entries", () => {
    const tree = buildKaizenTree([r("a", { kind: "local" })], (name) => name);
    expect(tree.mcp).toBeUndefined();
    expect(tree.agents).toBeUndefined();
    expect(tree.skills).toBeUndefined();
    expect(tree.memory).toBeUndefined();
  });

  it("calls leaf() once per registration with the registration name", () => {
    const seen: string[] = [];
    buildKaizenTree(
      [
        r("a", { kind: "local" }),
        r("b", { kind: "mcp", server: "x" }),
        r("c", { kind: "agent" }),
      ],
      (name) => { seen.push(name); return name; },
    );
    expect(seen.sort()).toEqual(["a", "b", "c"]);
  });

  it("unknown source kinds fall through to the tools bucket (matches buckets.ts policy)", () => {
    const tree = buildKaizenTree(
      [r("weird", { kind: "workflow" } as unknown as ToolSource)],
      (name) => name,
    );
    expect(tree.tools?.weird).toBe("weird");
  });

  it("multiple tools per MCP server group under the same normalized key", () => {
    const tree = buildKaizenTree(
      [
        r("a", { kind: "mcp", server: "foo-bar" }),
        r("b", { kind: "mcp", server: "foo.bar" }),
      ],
      (name) => name,
    );
    // Both normalize to foo_bar; the last write wins on key collision, but
    // both invocations land in the same namespace. We only assert the
    // namespace exists with the right normalized key here — collision
    // reporting is the assembler's job, not the tree's.
    expect(tree.mcp?.foo_bar).toBeDefined();
  });
});
