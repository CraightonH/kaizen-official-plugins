// Filled in by Task 11. Placeholder so `bun install` resolves the workspace.
export interface TuiChannelService {
  writeOutput(chunk: string): void;
  writeNotice(text: string): void;
  setBusy(state: boolean, message?: string): void;
  readInput(): Promise<string>;
}
