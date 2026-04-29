import React, { useSyncExternalStore } from "react";
import { Box, Static, Text } from "ink";
import type { TuiStore, LogEntry } from "../state/store.ts";
import { SpinnerLine } from "./SpinnerLine.tsx";
import { StatusBar } from "./StatusBar.tsx";
import { InputBox } from "./InputBox.tsx";

export interface AppProps {
  store: TuiStore;
  onCtrlC?: () => void;
}

export const App: React.FC<AppProps> = ({ store, onCtrlC }) => {
  const snap = useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => store.snapshot(),
  );

  return (
    <Box flexDirection="column">
      <Static items={snap.log}>
        {(e: LogEntry) => (
          <Text key={e.id} dimColor={e.tone === "notice"}>
            {e.text}
          </Text>
        )}
      </Static>
      {snap.busy.on && <SpinnerLine msg={snap.busy.msg} />}
      <InputBox store={store} history={snap.history} onCtrlC={onCtrlC} />
      <StatusBar items={snap.status} />
    </Box>
  );
};
