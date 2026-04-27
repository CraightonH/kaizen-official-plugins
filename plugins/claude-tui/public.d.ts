export interface UiChannel {
  readInput(): Promise<string>;
  writeOutput(chunk: string): void;
  writeNotice(line: string): void;
  setBusy(busy: boolean, message?: string): void;
}
