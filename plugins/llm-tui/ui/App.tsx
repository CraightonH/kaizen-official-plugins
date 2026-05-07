import React, { useSyncExternalStore } from "react";
import { Box, Static, Text, useInput } from "ink";
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
import type { ToolRendererRegistry } from "../tool-renderers/registry.ts";

export interface AppProps {
  store: TuiStore;
  registry: CompletionRegistry;
  toolRenderers: ToolRendererRegistry;
  triggers: Set<string>;
  theme: TuiTheme;
  onSubmit: (text: string) => void;
  onCancel?: () => void;
}

export const App: React.FC<AppProps> = ({ store, registry, toolRenderers, triggers, theme, onSubmit, onCancel }) => {
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

  // Render the committed transcript entry. Pulled out so <Static> can call it
  // per item; React keys are owned by Static itself.
  const renderEntry = (e: TranscriptLine) => {
    if (e.kind === "user") {
      return (
        <Text>
          <Text color={theme.promptColor} bold>{"❯ "}</Text>
          <Text color={theme.outputColor} backgroundColor="#2a2a2a">{e.text}</Text>
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
    return (
      <Text color={e.kind === "notice" ? theme.noticeColor : theme.outputColor} dimColor={e.kind === "notice"}>
        {e.text}
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
        {(e: TranscriptLine) => <Box key={e.id}>{renderEntry(e)}</Box>}
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
          <InputBox
            store={store}
            registry={registry}
            triggers={triggers}
            theme={theme}
            onSubmit={onSubmit}
            onCancel={onCancel}
          />
          <StatusBar items={snap.status} color={theme.statusBarColor} />
        </>
      )}
    </Box>
  );
};
