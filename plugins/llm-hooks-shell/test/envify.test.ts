import { describe, it, expect } from "bun:test";
import { envify, camelToUpperSnake } from "../envify.ts";

describe("camelToUpperSnake", () => {
  it("turnId → TURN_ID", () => expect(camelToUpperSnake("turnId")).toBe("TURN_ID"));
  it("parentTurnId → PARENT_TURN_ID", () => expect(camelToUpperSnake("parentTurnId")).toBe("PARENT_TURN_ID"));
  it("a → A", () => expect(camelToUpperSnake("a")).toBe("A"));
  it("already_snake stays uppercased", () => expect(camelToUpperSnake("already_snake")).toBe("ALREADY_SNAKE"));
  it("HTTPRequest folds runs of capitals to a single break", () => {
    // We accept either HTTP_REQUEST or HTTPREQUEST; pick HTTP_REQUEST for readability.
    expect(camelToUpperSnake("HTTPRequest")).toBe("HTTP_REQUEST");
  });
});

describe("envify", () => {
  it("turn:start { turnId, trigger } produces the documented set", () => {
    const env = envify("turn:start", { turnId: "t-7", trigger: "user" });
    expect(env.EVENT_NAME).toBe("turn:start");
    expect(env.EVENT_TURN_ID).toBe("t-7");
    expect(env.EVENT_TRIGGER).toBe("user");
    expect(env.EVENT_JSON).toBe(JSON.stringify({ turnId: "t-7", trigger: "user" }));
  });

  it("nested payload flattens to leaf vars and JSON blob", () => {
    const env = envify("llm:before-call", {
      request: { model: "gpt-4.1", messages: [{ role: "user", content: "hi" }] },
    });
    expect(env.EVENT_REQUEST_MODEL).toBe("gpt-4.1");
    expect(env.EVENT_REQUEST_MESSAGES).toBe(JSON.stringify([{ role: "user", content: "hi" }]));
    expect(env.EVENT_REQUEST).toBe(JSON.stringify({ model: "gpt-4.1", messages: [{ role: "user", content: "hi" }] }));
  });

  it("depth cap at 4 — depth-6 payload only emits up to depth-4 leaves; deeper levels collapsed to JSON blob", () => {
    const payload: any = { a: { b: { c: { d: { e: { f: "deep" } } } } } };
    const env = envify("custom:event", payload);
    // Reachable via the cap (depth 4 from the root):
    expect(env.EVENT_A_B_C_D).toBe(JSON.stringify({ e: { f: "deep" } }));
    // Beyond cap not present:
    expect(env.EVENT_A_B_C_D_E).toBeUndefined();
    expect(env.EVENT_A_B_C_D_E_F).toBeUndefined();
  });

  it("primitive scalars stringified", () => {
    const env = envify("e", { count: 42, ok: true, nothing: null });
    expect(env.EVENT_COUNT).toBe("42");
    expect(env.EVENT_OK).toBe("true");
    expect(env.EVENT_NOTHING).toBe("null");
  });

  it("EVENT_JSON always present even for empty payload", () => {
    const env = envify("noop", {});
    expect(env.EVENT_NAME).toBe("noop");
    expect(env.EVENT_JSON).toBe("{}");
  });

  it("non-object payload is wrapped under EVENT_JSON only", () => {
    const env = envify("e", "string-payload");
    expect(env.EVENT_NAME).toBe("e");
    expect(env.EVENT_JSON).toBe(JSON.stringify("string-payload"));
  });

  it("array at top level emits the JSON blob and indexed leaves up to cap", () => {
    const env = envify("e", { items: ["a", "b"] });
    expect(env.EVENT_ITEMS).toBe(JSON.stringify(["a", "b"]));
    expect(env.EVENT_ITEMS_0).toBe("a");
    expect(env.EVENT_ITEMS_1).toBe("b");
  });
});
