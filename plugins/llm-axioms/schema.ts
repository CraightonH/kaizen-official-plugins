export class AxiomValidationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "AxiomValidationError";
  }
}

const ID_RE = /^[a-z0-9_-]{1,64}$/;

export function validateAxiomId(id: unknown): asserts id is string {
  if (typeof id !== "string" || !ID_RE.test(id)) {
    throw new AxiomValidationError("invalid_id", `axiom id must match /^[a-z0-9_-]{1,64}$/, got ${JSON.stringify(id)}`);
  }
}

export interface AxiomEntryInput {
  id: string;
  statement: string;
  premises: string[];
  reasoning: string;
  scope: string;
}

const MAX_STATEMENT = 280;
const MAX_PREMISE = 500;
const MAX_PREMISES = 10;
const MAX_REASONING = 2000;
const MAX_SCOPE = 200;

function nonEmptyString(v: unknown, max: number, field: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new AxiomValidationError(`empty_${field}`, `${field} must be a non-empty string`);
  }
  if (v.length > max) {
    throw new AxiomValidationError(`${field}_too_long`, `${field} exceeds ${max} chars (got ${v.length})`);
  }
  return v;
}

export function validateAxiomEntry(entry: AxiomEntryInput): void {
  validateAxiomId(entry.id);
  nonEmptyString(entry.statement, MAX_STATEMENT, "statement");
  nonEmptyString(entry.reasoning, MAX_REASONING, "reasoning");
  nonEmptyString(entry.scope, MAX_SCOPE, "scope");

  if (!Array.isArray(entry.premises) || entry.premises.length === 0) {
    throw new AxiomValidationError("empty_premises", "premises must be a non-empty array");
  }
  if (entry.premises.length > MAX_PREMISES) {
    throw new AxiomValidationError("too_many_premises", `at most ${MAX_PREMISES} premises (got ${entry.premises.length})`);
  }
  for (const p of entry.premises) {
    nonEmptyString(p, MAX_PREMISE, "premise");
  }
}
