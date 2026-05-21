export class KeychainNotFoundError extends Error {
  constructor(account: string) {
    super(`keychain:${account} not found in keychain`);
    this.name = "KeychainNotFoundError";
  }
}

export class KeychainLockedError extends Error {
  constructor() {
    super("keychain is locked; unlock it and try again");
    this.name = "KeychainLockedError";
  }
}
