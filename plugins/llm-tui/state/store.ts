export type TranscriptKind = "output" | "notice" | "user" | "thoughts";
export interface TranscriptLine {
  id: number;
  kind: TranscriptKind;
  text: string;
  /** thoughts kind: whether the block is currently expanded. Toggleable via Ctrl+R for the most recent block. */
  expanded?: boolean;
}
export interface BusyState { active: boolean; message?: string; }
export interface InputState { value: string; cursor: number; }

export interface CompletionItem {
  label: string;
  detail?: string;
  insertText: string;
  sortWeight?: number;
}

export interface PopupState {
  trigger: string;
  query: string;
  items: CompletionItem[];
  selectedIndex: number;
  // Position in the input value where the trigger character sits. Used by
  // InputBox to compute the substring to replace on accept.
  triggerPos: number;
}

export interface TuiSnapshot {
  transcript: TranscriptLine[];
  busy: BusyState;
  input: InputState;
  popup: PopupState | null;
  status: Record<string, string>;
  history: string[];
  /** Live reasoning text accumulating during the current turn; null when idle. */
  liveThinking: string | null;
}

export class TuiStore {
  private _transcript: TranscriptLine[] = [];
  private _busy: BusyState = { active: false };
  private _input: InputState = { value: "", cursor: 0 };
  private _popup: PopupState | null = null;
  private _status: Record<string, string> = {};
  private _history: string[] = [];
  private _liveThinking: string | null = null;
  private _seq = 0;

  private _pending: ((line: string) => void) | null = null;
  private _queue: string[] = [];
  private _listeners = new Set<() => void>();
  private _snapshot: TuiSnapshot = this._build();

  subscribe(fn: () => void): () => void {
    this._listeners.add(fn);
    return () => { this._listeners.delete(fn); };
  }

  snapshot(): TuiSnapshot { return this._snapshot; }

  appendOutput(text: string): void {
    this._transcript = [...this._transcript, { id: ++this._seq, kind: "output", text }];
    this._emit();
  }

  appendNotice(text: string): void {
    this._transcript = [...this._transcript, { id: ++this._seq, kind: "notice", text }];
    this._emit();
  }

  appendUser(text: string): void {
    this._transcript = [...this._transcript, { id: ++this._seq, kind: "user", text }];
    this._emit();
  }

  appendReasoning(delta: string): void {
    this._liveThinking = (this._liveThinking ?? "") + delta;
    this._emit();
  }

  /** Move the accumulated reasoning into the transcript as a collapsed thoughts block. */
  finalizeReasoning(): void {
    if (!this._liveThinking) { this._liveThinking = null; return; }
    const text = this._liveThinking.trim();
    this._liveThinking = null;
    if (!text) { this._emit(); return; }
    this._transcript = [
      ...this._transcript,
      { id: ++this._seq, kind: "thoughts", text, expanded: false },
    ];
    this._emit();
  }

  clearLiveThinking(): void {
    if (this._liveThinking === null) return;
    this._liveThinking = null;
    this._emit();
  }

  toggleLatestThoughts(): void {
    // Walk transcript from the end and flip the most recent thoughts block.
    let idx = -1;
    for (let i = this._transcript.length - 1; i >= 0; i--) {
      if (this._transcript[i]!.kind === "thoughts") { idx = i; break; }
    }
    if (idx < 0) return;
    const cur = this._transcript[idx]!;
    const next = { ...cur, expanded: !(cur.expanded ?? false) };
    this._transcript = [
      ...this._transcript.slice(0, idx),
      next,
      ...this._transcript.slice(idx + 1),
    ];
    this._emit();
  }

  setBusy(active: boolean, message?: string): void {
    this._busy = active ? { active: true, message } : { active: false };
    this._emit();
  }

  setInput(value: string, cursor: number): void {
    this._input = { value, cursor };
    this._emit();
  }

  upsertStatus(key: string, value: string): void {
    this._status = { ...this._status, [key]: value };
    this._emit();
  }

  clearStatus(key: string): void {
    if (!(key in this._status)) return;
    const next = { ...this._status };
    delete next[key];
    this._status = next;
    this._emit();
  }

  openPopup(trigger: string, query: string, triggerPos = 0): void {
    this._popup = { trigger, query, items: [], selectedIndex: 0, triggerPos };
    this._emit();
  }

  setPopupItems(items: CompletionItem[]): void {
    if (!this._popup) return;
    const max = Math.max(0, items.length - 1);
    const sel = Math.min(this._popup.selectedIndex, max);
    this._popup = { ...this._popup, items, selectedIndex: items.length === 0 ? 0 : sel };
    this._emit();
  }

  setPopupQuery(query: string): void {
    if (!this._popup) return;
    this._popup = { ...this._popup, query, selectedIndex: 0 };
    this._emit();
  }

  movePopup(delta: number): void {
    if (!this._popup || this._popup.items.length === 0) return;
    const n = this._popup.items.length;
    const nextIdx = ((this._popup.selectedIndex + delta) % n + n) % n;
    this._popup = { ...this._popup, selectedIndex: nextIdx };
    this._emit();
  }

  closePopup(): void {
    if (this._popup === null) return;
    this._popup = null;
    this._emit();
  }

  awaitInput(): Promise<string> {
    if (this._queue.length > 0) {
      const next = this._queue.shift()!;
      return Promise.resolve(next);
    }
    return new Promise((resolve) => { this._pending = resolve; });
  }

  submit(line: string): void {
    this._history = [...this._history, line];
    this._emit();
    const r = this._pending;
    this._pending = null;
    if (r) {
      r(line);
    } else {
      this._queue.push(line);
    }
  }

  private _build(): TuiSnapshot {
    return {
      transcript: this._transcript,
      busy: this._busy,
      input: this._input,
      popup: this._popup,
      status: this._status,
      history: this._history,
      liveThinking: this._liveThinking,
    };
  }

  private _emit(): void {
    this._snapshot = this._build();
    for (const fn of this._listeners) fn();
  }
}
