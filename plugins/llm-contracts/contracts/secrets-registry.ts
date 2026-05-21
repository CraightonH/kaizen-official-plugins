export interface SecretRef {
  $ref: string;
}

export function isSecretRef(v: unknown): v is SecretRef {
  return typeof v === "object"
    && v !== null
    && !Array.isArray(v)
    && typeof (v as { $ref?: unknown }).$ref === "string";
}

export interface SecretsResolver {
  readonly scheme: string;
  readonly readOnly?: boolean;

  get(key: string): Promise<string>;
  set?(key: string, value: string): Promise<void>;
  delete?(key: string): Promise<void>;
  list?(): Promise<string[]>;
}

export interface SecretsRegistryService {
  register(resolver: SecretsResolver): () => void;
  /** Throws on unknown scheme or missing key. */
  resolve(ref: SecretRef): Promise<string>;
  store(scheme: string, key: string, value: string): Promise<SecretRef>;
  /** No-op if already absent. */
  delete(ref: SecretRef): Promise<void>;
  schemes(): string[];
  readOnlySchemes(): string[];
  has(scheme: string): boolean;
}

export const CONTRACT_ID = "secrets:registry" as const;
export const DESCRIPTION =
  "Route table for secret resolvers. Backend plugins register by scheme; consumers resolve $ref pointers to plaintext values.";
