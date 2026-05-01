export class BareNamePluginError extends Error {
  readonly bareName: string;
  constructor(name: string) {
    super(
      `Plugin-registered slash command "${name}" must be namespaced as ` +
      `<source>:<name> (e.g. "mcp:reload", "skills:list"). Bare names are ` +
      `reserved for built-ins, driver-coupled commands, and user/project ` +
      `markdown files.`,
    );
    this.name = "BareNamePluginError";
    this.bareName = name;
  }
}

export class ReentrantSlashEmitError extends Error {
  readonly event: string;
  constructor(event: string) {
    super(`Slash-command handler attempted to emit "${event}" — not allowed inside a slash dispatch.`);
    this.name = "ReentrantSlashEmitError";
    this.event = event;
  }
}

export class DuplicateRegistrationError extends Error {
  readonly duplicateName: string;
  constructor(name: string) {
    super(`Slash command "${name}" is already registered.`);
    this.name = "DuplicateRegistrationError";
    this.duplicateName = name;
  }
}

export class InvalidNameError extends Error {
  readonly invalidName: string;
  constructor(name: string) {
    super(`Slash command name "${name}" is invalid; each segment must match [a-z][a-z0-9-]*.`);
    this.name = "InvalidNameError";
    this.invalidName = name;
  }
}
