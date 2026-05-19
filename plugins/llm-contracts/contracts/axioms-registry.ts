export interface AxiomEntry {
  /** Slug, `[a-z0-9_-]{1,64}`, model-chosen, stable across amend/drop. */
  id: string;
  /** One sentence, declarative, falsifiable. */
  statement: string;
  /** Supporting truths; may reference other axioms via `[[id]]`. */
  premises: string[];
  /** Why premises imply the statement. */
  reasoning: string;
  /** Applicability within the session. */
  scope: string;
  /** ms epoch, auto-set on record. */
  derivedAt: number;
  /** ms epoch, auto-set on amend. */
  amendedAt?: number;
}

export interface AxiomsRegistryService {
  list(): readonly AxiomEntry[];
  get(id: string): AxiomEntry | null;
  record(entry: Omit<AxiomEntry, "derivedAt" | "amendedAt">): Promise<AxiomEntry>;
  amend(
    id: string,
    patch: Partial<Omit<AxiomEntry, "id" | "derivedAt">>,
  ): Promise<AxiomEntry>;
  drop(id: string, reason: string): Promise<boolean>;
  clear(): Promise<void>;
  onChange(cb: () => void): () => void;
}

export const CONTRACT_ID = "axioms:registry" as const;
export const DESCRIPTION = "Session-scoped Aristotelean axiom workspace.";
