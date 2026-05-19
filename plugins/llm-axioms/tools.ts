import type { AxiomsRegistryService } from "./public.d.ts";
import { AxiomValidationError } from "./schema.ts";

export interface ToolSchemaLike {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  tags?: string[];
}

export interface ToolsRegistryLike {
  register(
    schema: ToolSchemaLike,
    handler: (args: any, ctx: any) => Promise<unknown>,
  ): () => void;
}

const TAGS = ["axioms", "write"];

const RECORD_SCHEMA: ToolSchemaLike = {
  name: "axiom_record",
  description:
    "Record a new first-principles axiom for the current session. " +
    "Use before applying the axiom in your reasoning. Each axiom has a stable id, " +
    "one-sentence statement, 1-10 premises (may reference other axioms via [[id]]), " +
    "reasoning, and scope of applicability.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["id", "statement", "premises", "reasoning", "scope"],
    properties: {
      id: { type: "string", description: "Slug, [a-z0-9_-]{1,64}, stable across amend/drop" },
      statement: { type: "string", description: "One-sentence declarative axiom (≤ 280 chars)" },
      premises: {
        type: "array",
        minItems: 1,
        maxItems: 10,
        items: { type: "string" },
      },
      reasoning: { type: "string", description: "Why premises imply the statement (≤ 2000 chars)" },
      scope: { type: "string", description: "Applicability within this session (≤ 200 chars)" },
    },
  },
  tags: TAGS,
};

const AMEND_SCHEMA: ToolSchemaLike = {
  name: "axiom_amend",
  description:
    "Refine an existing axiom in the current session by id. " +
    "Pass any subset of statement/premises/reasoning/scope.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["id"],
    properties: {
      id: { type: "string" },
      statement: { type: "string" },
      premises: { type: "array", items: { type: "string" } },
      reasoning: { type: "string" },
      scope: { type: "string" },
    },
  },
  tags: TAGS,
};

const DROP_SCHEMA: ToolSchemaLike = {
  name: "axiom_drop",
  description: "Remove an axiom from the current session. Reason is required and is audited.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["id", "reason"],
    properties: {
      id: { type: "string" },
      reason: { type: "string", description: "Why the axiom is being dropped (≤ 500 chars)" },
    },
  },
  tags: TAGS,
};

function toStructuredError(e: unknown): { ok: false; error: string; message: string } {
  if (e instanceof AxiomValidationError) {
    return { ok: false, error: e.code, message: e.message };
  }
  const msg = (e as Error)?.message ?? String(e);
  if (msg.startsWith("no_active_session")) {
    return { ok: false, error: "no_active_session", message: msg };
  }
  return { ok: false, error: "internal_error", message: msg };
}

export function registerTools(reg: ToolsRegistryLike, store: AxiomsRegistryService): () => void {
  const offs: Array<() => void> = [];

  offs.push(
    reg.register(RECORD_SCHEMA, async (args) => {
      try {
        const axiom = await store.record({
          id: String(args?.id ?? ""),
          statement: String(args?.statement ?? ""),
          premises: Array.isArray(args?.premises) ? args.premises.map(String) : [],
          reasoning: String(args?.reasoning ?? ""),
          scope: String(args?.scope ?? ""),
        });
        return { ok: true, axiom };
      } catch (e) {
        return toStructuredError(e);
      }
    }),
  );

  offs.push(
    reg.register(AMEND_SCHEMA, async (args) => {
      const id = String(args?.id ?? "");
      const patch: Record<string, unknown> = {};
      if (typeof args?.statement === "string") patch.statement = args.statement;
      if (Array.isArray(args?.premises)) patch.premises = args.premises.map(String);
      if (typeof args?.reasoning === "string") patch.reasoning = args.reasoning;
      if (typeof args?.scope === "string") patch.scope = args.scope;
      if (Object.keys(patch).length === 0) {
        return { ok: false, error: "no_patch_fields", message: "amend requires at least one of statement/premises/reasoning/scope" };
      }
      try {
        const axiom = await store.amend(id, patch as any);
        return { ok: true, axiom };
      } catch (e) {
        return toStructuredError(e);
      }
    }),
  );

  offs.push(
    reg.register(DROP_SCHEMA, async (args) => {
      const id = String(args?.id ?? "");
      const reason = String(args?.reason ?? "");
      try {
        await store.drop(id, reason);
        return { ok: true, droppedId: id, reason };
      } catch (e) {
        return toStructuredError(e);
      }
    }),
  );

  return () => { for (const off of offs) { try { off(); } catch {} } };
}
