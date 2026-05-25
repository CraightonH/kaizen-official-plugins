// plugins/kaizen-secrets-keychain/public.d.ts
export interface KaizenSecretsKeychainConfig {
  /**
   * macOS Keychain "service" (svce) attribute used for every entry this
   * plugin creates. Account names remain `<plugin>/<field>`. Changing
   * this orphans pre-existing entries — users must re-enter secrets or
   * migrate keychain items manually.
   */
  keychainService: string;
}
