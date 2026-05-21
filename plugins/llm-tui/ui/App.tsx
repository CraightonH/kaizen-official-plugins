import React, { useSyncExternalStore } from "react";
import { Box, Static, Text, useInput } from "ink";
import type { CopyResult } from "../clipboard.ts";
import type { TuiStore, TranscriptLine } from "../state/store.ts";
import type { CompletionRegistry } from "../completion/registry.ts";
import type { TuiTheme } from "../theme/loader.ts";
import { SpinnerLine } from "./SpinnerLine.tsx";
import { StatusBar } from "./StatusBar.tsx";
import { InputBox } from "./InputBox.tsx";
import { ThinkingBox } from "./ThinkingBox.tsx";
import { ThoughtsBlock } from "./ThoughtsBlock.tsx";
import { HistoryView } from "./HistoryView.tsx";
import { ToolCallBlock } from "./ToolCallBlock.tsx";
import { LiveToolCalls } from "./LiveToolCalls.tsx";
import { PromptBox } from "./PromptBox.tsx";
import { renderMarkdown } from "./markdown.ts";
import type { ToolRendererRegistry } from "../tool-renderers/registry.ts";
import type { CompletionSource } from "llm-contracts/public";

export interface AppProps {
  store: TuiStore;
  registry: CompletionRegistry;
  toolRenderers: ToolRendererRegistry;
  sources: Map<string, CompletionSource>;
  theme: TuiTheme;
  onSubmit: (text: string) => void;
  onCancel?: () => void;
  onExit?: () => void;
  copyToClipboard?: (text: string) => Promise<CopyResult>;
}

export const App: React.FC<AppProps> = ({ store, registry, toolRenderers, sources, theme, onSubmit, onCancel, onExit, copyToClipboard }) => {
  const snap = useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => store.snapshot(),
  );

  // Ctrl+R opens the /history audit view. The chat transcript is rendered
  // through Ink's <Static>, which prints each entry once to terminal
  // scrollback and never redraws it — that's what stops streaming-thinking
  // from yanking the user's scrollbar back to the bottom on every delta.
  // The trade-off is that committed entries become immutable from the UI's
  // perspective: there is no inline expand/collapse anymore, and Ctrl+R can
  // no longer toggle them in place. /history is the canonical place to
  // re-open past thought blocks; this Ctrl+R chord just jumps the user
  // there directly so the muscle memory still works.
  useInput((input, key) => {
    if (snap.viewMode !== "chat") return;
    if (key.ctrl && (input === "r" || input === "R")) {
      store.enterHistoryMode();
    }
  });

  // Whether a transcript entry should be rendered through marked-terminal.
  // output defaults true (back-compat); notice/user default false; thoughts/tool_call
  // always false here (HistoryView handles thoughts; tool_call has its own renderer).
  const shouldRenderMarkdown = (e: TranscriptLine): boolean => {
    if (e.kind === "output") return e.markdown !== false;
    if (e.kind === "notice" || e.kind === "user") return e.markdown === true;
    return false;
  };

  // Render the committed transcript entry. Pulled out so <Static> can call it
  // per item; React keys are owned by Static itself.
  const renderEntry = (e: TranscriptLine) => {
    if (e.kind === "user") {
      const body = shouldRenderMarkdown(e) ? renderMarkdown(e.text) : e.text;
      return (
        <Text>
          {e.handoffFrom && (
            <Text color={theme.noticeColor} dimColor>
              {`[handoff from ${e.handoffFrom}] `}
            </Text>
          )}
          <Text color={theme.promptColor} bold>{"❯ "}</Text>
          <Text color={theme.outputColor} backgroundColor="#2a2a2a">{body}</Text>
        </Text>
      );
    }
    if (e.kind === "thoughts") {
      // Always render collapsed in chat. Use /history (or Ctrl+R) to expand.
      return <ThoughtsBlock text={e.text} color={theme.noticeColor} />;
    }
    if (e.kind === "tool_call") {
      return <ToolCallBlock entry={e} registry={toolRenderers} theme={theme} />;
    }
    if (e.kind === "output") {
      // Render assistant output through marked-terminal by default. Caller can
      // opt out with { markdown: false } (e.g., raw stdout passthrough).
      // Raw markdown stays in the store for the Ctrl+X copy shortcut.
      const body = shouldRenderMarkdown(e) ? renderMarkdown(e.text) : e.text;
      return <Text color={theme.outputColor}>{body}</Text>;
    }
    // notice
    const isMd = shouldRenderMarkdown(e);
    const body = isMd ? renderMarkdown(e.text) : e.text;
    return (
      <Text color={theme.noticeColor} dimColor={!isMd}>
        {body}
      </Text>
    );
  };

  // <Static> is rendered unconditionally and at a stable tree position so it
  // does NOT unmount when toggling history mode. If we conditionally returned
  // a different tree for history, Ink would tear down Static and re-emit every
  // committed item to stdout on the way back, duplicating the transcript on
  // each round-trip.
  return (
    <Box flexDirection="column">
      <Static items={snap.transcript}>
        {(e: TranscriptLine) => (
          <Box key={e.id} marginBottom={1}>
            {renderEntry(e)}
          </Box>
        )}
      </Static>
      {snap.viewMode === "history" ? (
        <HistoryView store={store} theme={theme} />
      ) : (
        <>
          <LiveToolCalls store={store} registry={toolRenderers} theme={theme} />
          {snap.busy.active && snap.liveThinking && (
            <ThinkingBox text={snap.liveThinking} color={theme.noticeColor} />
          )}
          {snap.busy.active && (
            <SpinnerLine
              color={theme.busyColor}
              message={snap.busy.message}
              startedAt={snap.busy.startedAt}
              deltaTokens={snap.busy.deltaTokens}
            />
          )}
          <PromptBox store={store} theme={theme} />
          <InputBox
            store={store}
            registry={registry}
            sources={sources}
            theme={theme}
            onSubmit={onSubmit}
            onCancel={onCancel}
            onExit={onExit}
            copyToClipboard={copyToClipboard}
          />
          <StatusBar items={snap.status} color={theme.statusBarColor} />
        </>
      )}
    </Box>
  );
};
