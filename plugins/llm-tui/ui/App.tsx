import React, { useSyncExternalStore } from "react";
import { Box, Static, Text } from "ink";
import type { TuiStore, TranscriptLine } from "../state/store.ts";
import type { CompletionRegistry } from "../completion/registry.ts";
import type { TuiTheme } from "../theme/loader.ts";
import { SpinnerLine } from "./SpinnerLine.tsx";
import { StatusBar } from "./StatusBar.tsx";
import { InputBox } from "./InputBox.tsx";

export interface AppProps {
  store: TuiStore;
  registry: CompletionRegistry;
  triggers: Set<string>;
  theme: TuiTheme;
  onSubmit: (text: string) => void;
  onCtrlC?: () => void;
}

export const App: React.FC<AppProps> = ({ store, registry, triggers, theme, onSubmit, onCtrlC }) => {
  const snap = useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => store.snapshot(),
  );

  return (
    <Box flexDirection="column">
      <Static items={snap.transcript}>
        {(e: TranscriptLine) => {
          if (e.kind === "user") {
            // User messages: magenta `❯` gutter (bold) and a subtle
            // background highlight on the body so the turn boundary
            // is visible against assistant replies. Rendered as a
            // single Text — wrapping in <Box flexDirection="column">
            // adds an extra row of layout height in Ink's Static.
            return (
              <Text key={e.id}>
                <Text color={theme.promptColor} bold>{"❯ "}</Text>
                <Text color={theme.outputColor} backgroundColor="#2a2a2a">{e.text}</Text>
              </Text>
            );
          }
          return (
            <Text key={e.id} color={e.kind === "notice" ? theme.noticeColor : theme.outputColor} dimColor={e.kind === "notice"}>
              {e.text}
            </Text>
          );
        }}
      </Static>
      {snap.busy.active && <SpinnerLine color={theme.busyColor} message={snap.busy.message} />}
      <InputBox
        store={store}
        registry={registry}
        triggers={triggers}
        theme={theme}
        onSubmit={onSubmit}
        onCtrlC={onCtrlC}
      />
      <StatusBar items={snap.status} color={theme.statusBarColor} />
    </Box>
  );
};
