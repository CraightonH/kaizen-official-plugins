export type LogTone = "output" | "notice";
export interface LogEntry { id: number; text: string; tone: LogTone; }
export interface StatusItem { id: string; text: string; tone?: "info" | "warn" | "err"; priority?: number; }
export interface BusyState { on: boolean; msg?: string; }

export interface TuiSnapshot {
  log: LogEntry[];
  status: Map<string, StatusItem>;
  busy: BusyState;
  history: string[];
}

export class TuiStore {
  private _log: LogEntry[] = [];
  private _status = new Map<string, StatusItem>();
  private _busy: BusyState = { on: false };
  private _history: string[] = [];
  private _pending: ((line: string) => void) | null = null;
  private _listeners = new Set<() => void>();
  private _seq = 0;
  private _snapshot: TuiSnapshot = this._build();

  subscribe(fn: () => void): () => void {
    this._listeners.add(fn);
    return () => { this._listeners.delete(fn); };
  }

  snapshot(): TuiSnapshot { return this._snapshot; }

  appendOutput(text: string): void {
    this._log = [...this._log, { id: ++this._seq, text, tone: "output" }];
    this._emit();
  }

  appendNotice(text: string): void {
    this._log = [...this._log, { id: ++this._seq, text, tone: "notice" }];
    this._emit();
  }

  clearLog(): void {
    this._log = [];
    this._emit();
  }

  setBusy(on: boolean, msg?: string): void {
    this._busy = { on, msg };
    this._emit();
  }

  upsertStatus(item: StatusItem): void {
    const next = new Map(this._status);
    next.set(item.id, item);
    this._status = next;
    this._emit();
  }

  clearStatus(id: string): void {
    if (!this._status.has(id)) return;
    const next = new Map(this._status);
    next.delete(id);
    this._status = next;
    this._emit();
  }

  awaitInput(): Promise<string> {
    return new Promise((resolve) => { this._pending = resolve; });
  }

  submit(line: string): void {
    this._history = [...this._history, line];
    const r = this._pending;
    this._pending = null;
    this._emit();
    r?.(line);
  }

  private _build(): TuiSnapshot {
    return { log: this._log, status: this._status, busy: this._busy, history: this._history };
  }

  private _emit(): void {
    this._snapshot = this._build();
    for (const fn of this._listeners) fn();
  }
}
