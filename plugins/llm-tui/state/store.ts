import type {
  ToolCallStatus,
  UiPromptOptionsRequest,
  UiPromptTextRequest,
} from "llm-contracts/public";

export type PromptSlice =
  | null
  | {
      kind: "options";
      request: UiPromptOptionsRequest;
      selectedIndex: number;
      expanded: { id: string; text: string } | null;
      resolve: (result: { id: string; text?: string }) => void;
    }
  | {
      kind: "text";
      request: UiPromptTextRequest;
      text: string;
      resolve: (text: string) => void;
    };
export type { ToolCallStatus };
export type TranscriptKind = "output" | "notice" | "user" | "thoughts" | "tool_call";

export interface PlainTranscriptLine {
  id: number;
  kind: "output" | "notice" | "user" | "thoughts";
  text: string;
  /** Set on `kind: "user"` lines that were seeded by a session:handoff. */
  handoffFrom?: string;
  /**
   * Whether to render the text through renderMarkdown in the UI.
   * Undefined means "use the kind's default" (output → true, notice/user → false).
   * Thoughts ignore this field — they are governed by theme.thoughtsMarkdown.
   */
  markdown?: boolean;
}

export interface ToolCallEntry {
  id: number;
  kind: "tool_call";
  callId: string;
  name: string;
  args: unknown;
  status: ToolCallStatus;
  stdout: string;
  result?: string;
  errorMessage?: string;
}

export type TranscriptLine = PlainTranscriptLine | ToolCallEntry;
export interface BusyState {
  active: boolean;
  message?: string;
  /** Wall-clock ms when the current busy period started (set on turn:start). */
  startedAt?: number;
  /** Completion tokens streamed/observed so far during this busy period. */
  deltaTokens?: number;
}
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
  /** Tool calls currently in flight (started but not finalized). Rendered outside <Static>. */
  liveToolCalls: ReadonlyMap<string, ToolCallEntry>;
  viewMode: ViewMode;
  historyView: HistoryViewState;
  prompt: PromptSlice;
}

export class TuiStore {
  private _transcript: TranscriptLine[] = [];
  private _busy: BusyState = { active: false };
  private _input: InputState = { value: "", cursor: 0 };
  private _popup: PopupState | null = null;
  private _status: Record<string, string> = {};
  private _history: string[] = [];
  private _liveThinking: string | null = null;
  private _liveToolCalls: Map<string, ToolCallEntry> = new Map();
  private _viewMode: ViewMode = "chat";
  private _historyView: HistoryViewState = { focusIdx: -1, expanded: new Set() };
  private _prompt: PromptSlice = null;
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

  /**
   * Return the text of the most recent `kind: "output"` transcript entry,
   * or null if no output has been written yet. Used by the Ctrl+X copy
   * shortcut to pluck the latest assistant message.
   */
  latestOutputText(): string | null {
    for (let i = this._transcript.length - 1; i >= 0; i--) {
      const e = this._transcript[i];
      if (e?.kind === "output") return e.text;
    }
    return null;
  }

  appendOutput(text: string, opts?: { markdown?: boolean }): void {
    const entry: PlainTranscriptLine = { id: ++this._seq, kind: "output", text };
    if (opts?.markdown !== undefined) entry.markdown = opts.markdown;
    this._transcript = [...this._transcript, entry];
    this._emit();
  }

  appendNotice(text: string, opts?: { markdown?: boolean }): void {
    const entry: PlainTranscriptLine = { id: ++this._seq, kind: "notice", text };
    if (opts?.markdown !== undefined) entry.markdown = opts.markdown;
    this._transcript = [...this._transcript, entry];
    this._emit();
  }

  appendUser(text: string, opts?: { handoffFrom?: string; markdown?: boolean }): void {
    const entry: PlainTranscriptLine = { id: ++this._seq, kind: "user", text };
    if (opts?.handoffFrom) entry.handoffFrom = opts.handoffFrom;
    if (opts?.markdown !== undefined) entry.markdown = opts.markdown;
    this._transcript = [...this._transcript, entry];
    this._emit();
  }

  appendLiveToolCall(callId: string, name: string, args: unknown): void {
    const entry: ToolCallEntry = {
      id: ++this._seq,
      kind: "tool_call",
      callId,
      name,
      args,
      status: "running",
      stdout: "",
    };
    this._liveToolCalls = new Map(this._liveToolCalls).set(callId, entry);
    this._emit();
  }

  updateLiveToolCall(callId: string, patch: {
    result?: string;
    errorMessage?: string;
    stdoutDelta?: string;
  }): void {
    const cur = this._liveToolCalls.get(callId);
    if (!cur) return;
    const next: ToolCallEntry = {
      ...cur,
      ...(patch.result !== undefined ? { result: patch.result } : {}),
      ...(patch.errorMessage !== undefined ? { errorMessage: patch.errorMessage } : {}),
      stdout: patch.stdoutDelta !== undefined ? cur.stdout + patch.stdoutDelta : cur.stdout,
    };
    this._liveToolCalls = new Map(this._liveToolCalls).set(callId, next);
    this._emit();
  }

  finalizeLiveToolCall(callId: string, finalStatus: "done" | "error"): void {
    const cur = this._liveToolCalls.get(callId);
    if (!cur) return;
    const finalized: ToolCallEntry = { ...cur, status: finalStatus };
    const nextMap = new Map(this._liveToolCalls);
    nextMap.delete(callId);
    this._liveToolCalls = nextMap;
    this._transcript = [...this._transcript, finalized];
    this._emit();
  }

  hasLiveToolCall(callId: string): boolean {
    return this._liveToolCalls.has(callId);
  }

  appendToolCallToTranscript(
    callId: string,
    name: string,
    args: unknown,
    status: "done" | "error",
    result?: string,
    errorMessage?: string,
  ): void {
    const entry: ToolCallEntry = {
      id: ++this._seq,
      kind: "tool_call",
      callId,
      name,
      args,
      status,
      stdout: "",
      ...(result !== undefined ? { result } : {}),
      ...(errorMessage !== undefined ? { errorMessage } : {}),
    };
    this._transcript = [...this._transcript, entry];
    this._emit();
  }

  clearLiveToolCalls(): void {
    if (this._liveToolCalls.size === 0) return;
    this._liveToolCalls = new Map();
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
    const blocks = this._transcript.filter((e) => e.kind === "thoughts" || e.kind === "tool_call");
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
    const blocks = this._transcript.filter((e) => e.kind === "thoughts" || e.kind === "tool_call");
    if (blocks.length === 0) { this._historyView = { ...this._historyView, focusIdx: -1 }; this._emit(); return; }
    const cur = this._historyView.focusIdx < 0 ? 0 : this._historyView.focusIdx;
    const n = blocks.length;
    const next = ((cur + delta) % n + n) % n;
    this._historyView = { ...this._historyView, focusIdx: next };
    this._emit();
  }

  historyToggleFocused(): void {
    if (this._viewMode !== "history") return;
    const blocks = this._transcript.filter((e) => e.kind === "thoughts" || e.kind === "tool_call");
    const block = blocks[this._historyView.focusIdx];
    if (!block) return;
    const next = new Set(this._historyView.expanded);
    if (next.has(block.id)) next.delete(block.id); else next.add(block.id);
    this._historyView = { ...this._historyView, expanded: next };
    this._emit();
  }

  historySetAllExpanded(expanded: boolean): void {
    if (this._viewMode !== "history") return;
    const blocks = this._transcript.filter((e) => e.kind === "thoughts" || e.kind === "tool_call");
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

  /** Set the start time for the current busy period (called on turn:start). */
  setBusyTiming(startedAt: number): void {
    this._busy = { ...this._busy, active: true, startedAt, deltaTokens: 0 };
    this._emit();
  }

  /** Set the absolute completion-token count for the current busy period. */
  updateBusyTokens(deltaTokens: number): void {
    this._busy = { ...this._busy, deltaTokens };
    this._emit();
  }

  /** Increment the completion-token count by `n` (used during streaming). */
  incrementBusyTokens(n: number = 1): void {
    const cur = this._busy.deltaTokens ?? 0;
    this._busy = { ...this._busy, deltaTokens: cur + n };
    this._emit();
  }

  /** Clear busy timing data (called on turn:end). */
  clearBusyTiming(): void {
    this._busy = { active: false };
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

  openOptionsPrompt(
    request: UiPromptOptionsRequest,
    resolve: (result: { id: string; text?: string }) => void,
  ): void {
    const defaultId = request.defaultId ?? request.options[0]?.id;
    const idx = Math.max(0, request.options.findIndex((o) => o.id === defaultId));
    this._prompt = { kind: "options", request, selectedIndex: idx, expanded: null, resolve };
    this._emit();
  }

  openTextPrompt(
    request: UiPromptTextRequest,
    resolve: (text: string) => void,
  ): void {
    this._prompt = { kind: "text", request, text: request.defaultValue ?? "", resolve };
    this._emit();
  }

  moveSelection(delta: number): void {
    const p = this._prompt;
    if (!p || p.kind !== "options") return;
    const len = p.request.options.length;
    if (len === 0) return;
    const next = Math.max(0, Math.min(len - 1, p.selectedIndex + delta));
    if (next === p.selectedIndex) return;
    this._prompt = { ...p, selectedIndex: next };
    this._emit();
  }

  tabExpand(): void {
    const p = this._prompt;
    if (!p || p.kind !== "options") return;
    const opt = p.request.options[p.selectedIndex];
    if (!opt?.expandsTo) return;
    this._prompt = {
      ...p,
      expanded: { id: opt.id, text: opt.expandsTo.defaultValue ?? "" },
    };
    this._emit();
  }

  collapseExpansion(): void {
    const p = this._prompt;
    if (!p || p.kind !== "options" || !p.expanded) return;
    this._prompt = { ...p, expanded: null };
    this._emit();
  }

  setExpandedText(text: string): void {
    const p = this._prompt;
    if (!p || p.kind !== "options" || !p.expanded) return;
    this._prompt = { ...p, expanded: { ...p.expanded, text } };
    this._emit();
  }

  setStandaloneText(text: string): void {
    const p = this._prompt;
    if (!p || p.kind !== "text") return;
    this._prompt = { ...p, text };
    this._emit();
  }

  submitPrompt(result: { id: string; text?: string } | string): void {
    const p = this._prompt;
    if (!p) return;
    let noticeText: string;
    if (p.kind === "options") {
      if (typeof result === "string") return;
      const opt = p.request.options.find((o) => o.id === result.id);
      const label = opt?.label ?? result.id;
      noticeText = result.text
        ? `? ${p.request.title} → ${label}: ${result.text}`
        : `? ${p.request.title} → ${label}`;
      const resolve = p.resolve;
      this._prompt = null;
      this.appendNotice(noticeText, { markdown: false });
      resolve(result);
    } else {
      if (typeof result !== "string") return;
      noticeText = `? ${p.request.title} → ${result === "" ? "(skipped)" : result}`;
      const resolve = p.resolve;
      this._prompt = null;
      this.appendNotice(noticeText, { markdown: false });
      resolve(result);
    }
  }

  escapePrompt(): void {
    const p = this._prompt;
    if (!p) return;
    if (p.kind === "options") {
      const cancelId = p.request.cancelId ?? p.request.options.at(-1)?.id;
      if (cancelId === undefined) {
        this._prompt = null;
        this._emit();
        return;
      }
      this.submitPrompt({ id: cancelId });
    } else {
      this.submitPrompt("");
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
      liveToolCalls: new Map(this._liveToolCalls),
      viewMode: this._viewMode,
      historyView: this._historyView,
      prompt: this._prompt,
    };
  }

  private _emit(): void {
    this._snapshot = this._build();
    for (const fn of this._listeners) fn();
  }
}
