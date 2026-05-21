/** A pointer to a secret living in a backend. On-disk and in-memory sentinel. */
export interface SecretRef {
  $ref: string;   // e.g. "keychain:llm-tavily-search/apiKey"
}

/** Runtime helper. Exported as a value so consumers don't reimplement it. */
export function isSecretRef(v: unknown): v is SecretRef {
  return typeof v === "object"
    && v !== null
    && !Array.isArray(v)
    && typeof (v as { $ref?: unknown }).$ref === "string";
}

/** Implemented by backend plugins and registered with the registry. */
export interface SecretsResolver {
  /** URI scheme this resolver handles. Lowercase ASCII, no colons. */
  readonly scheme: string;
  /** If true, set/delete are rejected. `env:` is read-only; `keychain:` is not. */
  readonly readOnly?: boolean;

  get(key: string): Promise<string>;
  set?(key: string, value: string): Promise<void>;
  delete?(key: string): Promise<void>;
  /** Best-effort enumeration. Some backends can't list. */
  list?(): Promise<string[]>;
}

export interface SecretsRegistryService {
  /** Backend plugins call this in setup(). Returns unregister fn. */
  register(resolver: SecretsResolver): () => void;
  /** Resolve a $ref to its plaintext. Throws on unknown scheme or missing key. */
  resolve(ref: SecretRef): Promise<string>;
  /** Store a value under a scheme; returns the canonical $ref to record on disk. */
  store(scheme: string, key: string, value: string): Promise<SecretRef>;
  /** Delete a stored secret by $ref. No-op if already absent. */
  delete(ref: SecretRef): Promise<void>;
  /** Which schemes are currently registered. */
  schemes(): string[];
  has(scheme: string): boolean;
}

export const CONTRACT_ID = "secrets:registry" as const;
export const DESCRIPTION =
  "Route table for secret resolvers. Backend plugins register by scheme; consumers resolve $ref pointers to plaintext values.";
