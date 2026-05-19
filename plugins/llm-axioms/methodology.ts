export const METHODOLOGY_TEXT: string = [
  "# First-principles reasoning",
  "",
  "When a request contains vague qualifiers (\"world-class\", \"robust\", \"production-grade\"),",
  "conflicting constraints, novel problems, or appeals to precedent (\"we've always done it",
  "this way\"), pause and derive axioms before producing a solution.",
  "",
  "An axiom in this workspace is a *premised, scoped* truth — not an opinion or a preference.",
  "It has:",
  "- a one-sentence **statement** (declarative, falsifiable),",
  "- one or more **premises** it rests on (cite other axioms with `[[id]]`),",
  "- **reasoning** for why premises imply the statement,",
  "- a **scope** of applicability (which part of this session's problem it constrains).",
  "",
  "Use `axiom_record` before applying an axiom in your reasoning. Use `axiom_amend` when a",
  "later observation refines it. Use `axiom_drop` (with a reason) when you discover an axiom",
  "is wrong or has been superseded.",
  "",
  "Cite axioms by id (`[[id]]`) when applying them, so reasoning chains stay legible.",
].join("\n");

export function renderMethodology(): string {
  return METHODOLOGY_TEXT;
}
