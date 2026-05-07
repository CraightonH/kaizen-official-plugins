export type TranscriptKind = "output" | "notice" | "user" | "thoughts";
export interface TranscriptLine {
  id: number;
  kind: TranscriptKind;
  text: string;
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

export type ViewMode = "chat" | "history";

export interface HistoryViewState {
  /** Index into the *thought-block-only* sub-list of transcript. -1 if none. */
  focusIdx: number;
  /** Set of transcript entry ids whose Thoughts block is currently expanded. */
  expanded: ReadonlySet<number>;
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
  viewMode: ViewMode;
  historyView: HistoryViewState;
}

export class TuiStore {
  private _transcript: TranscriptLine[] = [];
  private _busy: BusyState = { active: false };
  private _input: InputState = { value: "", cursor: 0 };
  private _popup: PopupState | null = null;
  private _status: Record<string, string> = {};
  private _history: string[] = [];
  private _liveThinking: string | null = null;
  private _viewMode: ViewMode = "chat";
  private _historyView: HistoryViewState = { focusIdx: -1, expanded: new Set() };
  private _seq = 0;

  // Bracketed-paste registry: pasted content is stored here keyed by id; the
  // visible buffer holds a short "[Pasted text #N +M lines]" placeholder.
  // resolvePastes() expands placeholders back to the original text on submit.
  private _pastes = new Map<number, string>();
  private _pasteSeq = 0;

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
      { id: ++this._seq, kind: "thoughts", text },
    ];
    this._emit();
  }

  clearLiveThinking(): void {
    if (this._liveThinking === null) return;
    this._liveThinking = null;
    this._emit();
  }

  /**
   * Register a pasted block and return the placeholder string the caller
   * should insert into the visible input buffer. The actual content is held
   * here and substituted back in by resolvePastes() at submit time.
   */
  registerPaste(text: string): { id: number; placeholder: string } {
    const id = ++this._pasteSeq;
    this._pastes.set(id, text);
    const lineCount = text.split("\n").length;
    const placeholder = `[Pasted text #${id} +${lineCount} line${lineCount === 1 ? "" : "s"}]`;
    return { id, placeholder };
  }

  /** Replace any "[Pasted text #N +M lines]" placeholders with their content. */
  resolvePastes(text: string): string {
    if (this._pastes.size === 0) return text;
    return text.replace(/\[Pasted text #(\d+) \+\d+ lines?\]/g, (match, idStr) => {
      const stored = this._pastes.get(Number(idStr));
      return stored ?? match;
    });
  }

  clearPastes(): void {
    this._pastes.clear();
    // _pasteSeq intentionally not reset — keeps placeholder ids stable across
    // a session even after expansion, which helps when reading scrollback.
  }

  enterHistoryMode(): void {
    if (this._viewMode === "history") return;
    const blocks = this._transcript.filter((e) => e.kind === "thoughts");
    this._viewMode = "history";
    this._historyView = {
      focusIdx: blocks.length > 0 ? 0 : -1,
      expanded: new Set(),
    };
    this._emit();
  }

  exitHistoryMode(): void {
    if (this._viewMode === "chat") return;
    this._viewMode = "chat";
    this._emit();
  }

  historyMoveFocus(delta: number): void {
    if (this._viewMode !== "history") return;
    const blocks = this._transcript.filter((e) => e.kind === "thoughts");
    if (blocks.length === 0) { this._historyView = { ...this._historyView, focusIdx: -1 }; this._emit(); return; }
    const cur = this._historyView.focusIdx < 0 ? 0 : this._historyView.focusIdx;
    const n = blocks.length;
    const next = ((cur + delta) % n + n) % n;
    this._historyView = { ...this._historyView, focusIdx: next };
    this._emit();
  }

  historyToggleFocused(): void {
    if (this._viewMode !== "history") return;
    const blocks = this._transcript.filter((e) => e.kind === "thoughts");
    const block = blocks[this._historyView.focusIdx];
    if (!block) return;
    const next = new Set(this._historyView.expanded);
    if (next.has(block.id)) next.delete(block.id); else next.add(block.id);
    this._historyView = { ...this._historyView, expanded: next };
    this._emit();
  }

  historySetAllExpanded(expanded: boolean): void {
    if (this._viewMode !== "history") return;
    const blocks = this._transcript.filter((e) => e.kind === "thoughts");
    this._historyView = {
      ...this._historyView,
      expanded: expanded ? new Set(blocks.map((b) => b.id)) : new Set(),
    };
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
      viewMode: this._viewMode,
      historyView: this._historyView,
    };
  }

  private _emit(): void {
    this._snapshot = this._build();
    for (const fn of this._listeners) fn();
  }
}
