import { describe, it, expect } from "bun:test";
import { createStore, type StoreDeps } from "../store.ts";
import { createRegistry } from "../secrets/registry.ts";

interface Fs {
  files: Map<string, string>;
  reads: number;
}

function makeDeps(over: Partial<StoreDeps> = {}, fs?: Fs): { deps: StoreDeps; fs: Fs } {
  const f: Fs = fs ?? { files: new Map(), reads: 0 };
  const watchers = new Map<string, Set<() => void>>();
  const deps: StoreDeps = {
    homePath: "/home/u/.kaizen/harnesses/default/config.json",
    projectPath: "/proj/.kaizen/harnesses/default/config.json",
    readFile: (p) => {
      f.reads++;
      const v = f.files.get(p);
      if (v === undefined) {
        const err: NodeJS.ErrnoException = new Error("ENOENT");
        err.code = "ENOENT";
        throw err;
      }
      return v;
    },
    writeFile: (p, v) => f.files.set(p, JSON.stringify(v, null, 2) + "\n"),
    watchFile: (p, cb) => {
      let set = watchers.get(p);
      if (!set) { set = new Set(); watchers.set(p, set); }
      set.add(cb);
      return () => { set!.delete(cb); };
    },
    env: {},
    log: () => {},
    fireWatch: (p) => watchers.get(p)?.forEach((cb) => cb()),
    ...over,
  } as StoreDeps & { fireWatch: (p: string) => void };
  return { deps, fs: f };
}

describe("store — register + get", () => {
  it("returns defaults when nothing on disk", () => {
    const { deps } = makeDeps();
    const store = createStore(deps);
    store.register({ plugin: "x", defaults: { a: 1 } });
    expect(store.get<{ a: number }>("x")).toEqual({ a: 1 });
  });

  it("home file overrides defaults", () => {
    const { deps, fs } = makeDeps();
    fs.files.set(deps.homePath, JSON.stringify({ plugins: { x: { a: 5 } } }));
    const store = createStore(deps);
    store.register({ plugin: "x", defaults: { a: 1, b: 2 } });
    expect(store.get<{ a: number; b: number }>("x")).toEqual({ a: 5, b: 2 });
  });

  it("project file overrides home", () => {
    const { deps, fs } = makeDeps();
    fs.files.set(deps.homePath, JSON.stringify({ plugins: { x: { a: 5 } } }));
    fs.files.set(deps.projectPath, JSON.stringify({ plugins: { x: { a: 9 } } }));
    const store = createStore(deps);
    store.register({ plugin: "x", defaults: { a: 1 } });
    expect(store.get<{ a: number }>("x")).toEqual({ a: 9 });
  });

  it("env beats all file layers", () => {
    const { deps, fs } = makeDeps({ env: { OPENAI_KEY: "from-env" } });
    fs.files.set(deps.projectPath, JSON.stringify({ plugins: { x: { apiKey: "from-proj" } } }));
    const store = createStore(deps);
    store.register({
      plugin: "x",
      defaults: { apiKey: "" },
      schema: { apiKey: { type: "string" } },
      envVars: { apiKey: "OPENAI_KEY" },
    });
    expect(store.get<{ apiKey: string }>("x").apiKey).toBe("from-env");
  });

  it("deep-merges nested objects one level", () => {
    const { deps, fs } = makeDeps();
    fs.files.set(deps.homePath, JSON.stringify({ plugins: { x: { retry: { max: 5 } } } }));
    const store = createStore(deps);
    store.register({ plugin: "x", defaults: { retry: { max: 1, base: 100 } } });
    expect(store.get<any>("x").retry).toEqual({ max: 5, base: 100 });
  });

  it("arrays are replaced, not merged", () => {
    const { deps, fs } = makeDeps();
    fs.files.set(deps.homePath, JSON.stringify({ plugins: { x: { items: [3, 4] } } }));
    const store = createStore(deps);
    store.register({ plugin: "x", defaults: { items: [1, 2] } });
    expect(store.get<any>("x").items).toEqual([3, 4]);
  });

  it("throws on get for unregistered plugin", () => {
    const { deps } = makeDeps();
    const store = createStore(deps);
    expect(() => store.get("missing")).toThrow(/not registered/);
  });

  it("validation failure on boot falls back to defaults and logs", () => {
    const logs: string[] = [];
    const { deps, fs } = makeDeps({ log: (m) => logs.push(m) });
    fs.files.set(deps.homePath, JSON.stringify({ plugins: { x: { n: -1 } } }));
    const store = createStore(deps);
    store.register({
      plugin: "x",
      defaults: { n: 5 },
      schema: { n: { type: "number", min: 0 } },
    });
    expect(store.get<{ n: number }>("x")).toEqual({ n: 5 });
    expect(logs.join("\n")).toMatch(/validation.*'x'/i);
  });
});

describe("store — set", () => {
  it("writes the partial to home by default", async () => {
    const { deps, fs } = makeDeps();
    const store = createStore(deps);
    store.register({ plugin: "x", defaults: { a: 1 } });
    await store.set("x", { a: 2 });
    const written = JSON.parse(fs.files.get(deps.homePath)!);
    expect(written.plugins.x).toEqual({ a: 2 });
  });

  it("writes to project when scope=project", async () => {
    const { deps, fs } = makeDeps();
    const store = createStore(deps);
    store.register({ plugin: "x", defaults: { a: 1 } });
    await store.set("x", { a: 9 }, "project");
    expect(fs.files.get(deps.projectPath)).toBeDefined();
    expect(fs.files.get(deps.homePath)).toBeUndefined();
  });

  it("re-validates merged value and rejects invalid set", async () => {
    const { deps } = makeDeps();
    const store = createStore(deps);
    store.register({
      plugin: "x",
      defaults: { n: 1 },
      schema: { n: { type: "number", min: 0 } },
    });
    await expect(store.set("x", { n: -5 })).rejects.toThrow(/validation/i);
  });
});

describe("store — watch", () => {
  it("fires callback when a layer changes", () => {
    const fired: any[] = [];
    const { deps, fs } = makeDeps();
    const store = createStore(deps);
    store.register({ plugin: "x", defaults: { a: 1 } });
    store.watch<{ a: number }>("x", (v) => fired.push(v));
    fs.files.set(deps.homePath, JSON.stringify({ plugins: { x: { a: 7 } } }));
    (deps as any).fireWatch(deps.homePath);
    expect(fired).toEqual([{ a: 7 }]);
  });

  it("does not fire when validation fails", () => {
    const fired: any[] = [];
    const logs: string[] = [];
    const { deps, fs } = makeDeps({ log: (m) => logs.push(m) });
    const store = createStore(deps);
    store.register({
      plugin: "x",
      defaults: { n: 1 },
      schema: { n: { type: "number", min: 0 } },
    });
    store.watch<any>("x", (v) => fired.push(v));
    fs.files.set(deps.homePath, JSON.stringify({ plugins: { x: { n: -3 } } }));
    (deps as any).fireWatch(deps.homePath);
    expect(fired).toEqual([]);
    expect(logs.join("\n")).toMatch(/validation/i);
  });

  it("returns an unsubscribe function", () => {
    const fired: any[] = [];
    const { deps, fs } = makeDeps();
    const store = createStore(deps);
    store.register({ plugin: "x", defaults: { a: 1 } });
    const off = store.watch<{ a: number }>("x", (v) => fired.push(v));
    off();
    fs.files.set(deps.homePath, JSON.stringify({ plugins: { x: { a: 9 } } }));
    (deps as any).fireWatch(deps.homePath);
    expect(fired).toEqual([]);
  });
});

describe("store — list", () => {
  it("reports per-plugin paths and existence", () => {
    const { deps, fs } = makeDeps();
    fs.files.set(deps.homePath, JSON.stringify({ plugins: {} }));
    const store = createStore(deps);
    store.register({ plugin: "x", defaults: { a: 1 } });
    const rows = store.list();
    expect(rows).toHaveLength(1);
    expect(rows[0].plugin).toBe("x");
    expect(rows[0].homeExists).toBe(true);
    expect(rows[0].projectExists).toBe(false);
  });
});

describe("store — secret refs on load", () => {
  it("returns the SecretRef sentinel when value is a $ref and no backend resolves", () => {
    const { deps, fs } = makeDeps();
    fs.files.set(deps.homePath, JSON.stringify({
      plugins: { x: { apiKey: { $ref: "keychain:x/apiKey" } } },
    }));
    const store = createStore(deps);
    store.register({
      plugin: "x",
      defaults: { apiKey: "" },
      schema: { apiKey: { type: "string", secret: true } },
    });
    const v = store.get<{ apiKey: string | { $ref: string } }>("x");
    expect(v.apiKey).toEqual({ $ref: "keychain:x/apiKey" });
  });

  it("reports secret:<scheme> resolution for ref-valued fields", () => {
    const { deps, fs } = makeDeps();
    fs.files.set(deps.homePath, JSON.stringify({
      plugins: { x: { apiKey: { $ref: "keychain:x/apiKey" } } },
    }));
    const store = createStore(deps);
    store.register({
      plugin: "x",
      defaults: { apiKey: "" },
      schema: { apiKey: { type: "string", secret: true } },
    });
    const status = store.list().find((s) => s.plugin === "x")!;
    expect(status.resolution.apiKey).toBe("secret:keychain");
  });
});

describe("store — ready() with backend", () => {
  it("ready() resolves $refs against the registered backend", async () => {
    const { deps, fs } = makeDeps();
    fs.files.set(deps.homePath, JSON.stringify({
      plugins: { x: { apiKey: { $ref: "fake:x/apiKey" } } },
    }));
    const registry = createRegistry();
    registry.register({
      scheme: "fake",
      async get(k) { return k === "x/apiKey" ? "resolved-value" : (() => { throw new Error("nope"); })(); },
      async set() {},
      async delete() {},
    });
    const store = createStore({ ...deps, registry });
    store.register({
      plugin: "x",
      defaults: { apiKey: "" },
      schema: { apiKey: { type: "string", secret: true } },
    });
    expect(store.get<{ apiKey: unknown }>("x").apiKey).toEqual({ $ref: "fake:x/apiKey" });
    await store.ready();
    expect(store.get<{ apiKey: string }>("x").apiKey).toBe("resolved-value");
  });

  it("ready() leaves SecretRef in place when scheme is not registered", async () => {
    const { deps, fs } = makeDeps();
    fs.files.set(deps.homePath, JSON.stringify({
      plugins: { x: { apiKey: { $ref: "missing:k" } } },
    }));
    const registry = createRegistry();
    const store = createStore({ ...deps, registry });
    store.register({
      plugin: "x",
      defaults: { apiKey: "" },
      schema: { apiKey: { type: "string", secret: true } },
    });
    await store.ready();
    expect(store.get<{ apiKey: unknown }>("x").apiKey).toEqual({ $ref: "missing:k" });
  });

  it("ready() tolerates backend get() failures (keeps SecretRef, does not throw)", async () => {
    const { deps, fs } = makeDeps();
    fs.files.set(deps.homePath, JSON.stringify({
      plugins: { x: { apiKey: { $ref: "fake:x/apiKey" } } },
    }));
    const registry = createRegistry();
    registry.register({
      scheme: "fake",
      async get() { throw new Error("backend exploded"); },
      async set() {},
      async delete() {},
    });
    const store = createStore({ ...deps, registry });
    store.register({
      plugin: "x",
      defaults: { apiKey: "" },
      schema: { apiKey: { type: "string", secret: true } },
    });
    await store.ready();
    expect(store.get<{ apiKey: unknown }>("x").apiKey).toEqual({ $ref: "fake:x/apiKey" });
  });
});
