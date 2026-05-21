export interface SelectBackendInput {
  configured: string | undefined;
  available: string[];
  readOnly: string[];
}

export type SelectBackendResult =
  | { ok: true; scheme: string }
  | { ok: false; error: string };

export function selectBackend(input: SelectBackendInput): SelectBackendResult {
  const ro = new Set(input.readOnly);
  const writable = input.available.filter((s) => !ro.has(s));

  if (input.configured) {
    if (!input.available.includes(input.configured)) {
      return { ok: false, error: `defaultSecretBackend='${input.configured}' is not registered (available: ${input.available.join(", ") || "<none>"})` };
    }
    if (ro.has(input.configured)) {
      return { ok: false, error: `${input.configured}: scheme is read-only; export the variable in your shell instead, or pick a writable backend` };
    }
    return { ok: true, scheme: input.configured };
  }

  if (writable.length === 1) {
    return { ok: true, scheme: writable[0]! };
  }

  if (writable.length === 0) {
    return { ok: false, error: "no writable secrets backend registered. Install kaizen-secrets-keychain (or another backend) or set the env var in your shell." };
  }

  return { ok: false, error: `multiple writable backends registered (${writable.join(", ")}); set /config:set kaizen-config defaultSecretBackend=<scheme>` };
}
