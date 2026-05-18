import { describe, it, expect } from "bun:test";
import { resolveServers } from "../servers.ts";

describe("resolveServers", () => {
  it("returns empty map silently when servers is empty/missing", () => {
    expect(resolveServers({}, {}).servers.size).toBe(0);
    expect(resolveServers(undefined, {}).servers.size).toBe(0);
    expect(resolveServers(null, {}).servers.size).toBe(0);
  });

  it("infers transport: command -> stdio, url -> http, explicit sse honored", () => {
    const r = resolveServers(
      {
        fs: { command: "true" },
        gh: { transport: "sse", url: "https://x", headers: { Authorization: "Bearer ${env:TOK}" } },
        api: { url: "https://api.example.com" },
      },
      { TOK: "tok" },
    );
    expect(r.servers.get("fs")!.transport).toBe("stdio");
    expect(r.servers.get("gh")!.transport).toBe("sse");
    expect(r.servers.get("gh")!.headers!.Authorization).toBe("Bearer tok");
    expect(r.servers.get("api")!.transport).toBe("http");
  });

  it("rejects invalid server names; keeps others", () => {
    const r = resolveServers({ "Bad Name!": { command: "true" }, "ok-name": { command: "true" } }, {});
    expect(r.servers.has("ok-name")).toBe(true);
    expect(r.servers.has("Bad Name!")).toBe(false);
    expect(r.warnings.some((w) => w.includes("Bad Name!"))).toBe(true);
  });

  it("missing env interpolation skips that server with warning", () => {
    const r = resolveServers(
      {
        "needs-env": { transport: "sse", url: "https://x", headers: { Authorization: "Bearer ${env:MISSING_VAR}" } },
        "fine": { command: "true" },
      },
      {},
    );
    expect(r.servers.has("needs-env")).toBe(false);
    expect(r.servers.has("fine")).toBe(true);
    expect(r.warnings.some((w) => w.includes("MISSING_VAR"))).toBe(true);
  });

  it("defaults: enabled=true, timeoutMs=30000, healthCheckMs=60000", () => {
    const r = resolveServers({ x: { command: "true" } }, {});
    const x = r.servers.get("x")!;
    expect(x.enabled).toBe(true);
    expect(x.timeoutMs).toBe(30000);
    expect(x.healthCheckMs).toBe(60000);
  });

  it("disabled: enabled=false survives into resolved", () => {
    const r = resolveServers({ x: { command: "true", enabled: false } }, {});
    expect(r.servers.get("x")!.enabled).toBe(false);
  });

  it("skips entry that is not an object", () => {
    const r = resolveServers({ x: "nope" as any }, {});
    expect(r.servers.has("x")).toBe(false);
    expect(r.warnings.some((w) => w.includes("must be an object"))).toBe(true);
  });

  it("stdio requires command; sse/http requires url", () => {
    const r = resolveServers(
      {
        "no-cmd": { transport: "stdio" },
        "no-url": { transport: "http" },
      },
      {},
    );
    expect(r.servers.has("no-cmd")).toBe(false);
    expect(r.servers.has("no-url")).toBe(false);
    expect(r.warnings.length).toBe(2);
  });

  it("deep-interpolates env in args, env, headers", () => {
    const r = resolveServers(
      {
        s: {
          command: "${env:CMD}",
          args: ["--token", "${env:TOK}"],
          env: { API: "${env:API_KEY}" },
        },
      },
      { CMD: "/bin/x", TOK: "abc", API_KEY: "k" },
    );
    const s = r.servers.get("s")!;
    expect(s.command).toBe("/bin/x");
    expect(s.args).toEqual(["--token", "abc"]);
    expect(s.env).toEqual({ API: "k" });
  });
});
