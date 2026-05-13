import React from "react";
import { Box, Text } from "ink";
import type { UiToolRenderer } from "llm-contracts/public";

function lineCount(code: string): number {
  if (!code) return 0;
  return code.split("\n").length;
}

export const codemodeRenderer: UiToolRenderer = {
  toolName: "execute_typescript",
  collapsedSummary(args) {
    const n = lineCount(((args as any)?.code as string) ?? "");
    return `exec ${n} line${n === 1 ? "" : "s"}`;
  },
  expandedView(args, result, _status, stdout) {
    const code = ((args as any)?.code as string) ?? "";
    return (
      <Box flexDirection="column">
        <Text dimColor>code:</Text>
        {code.split("\n").map((l, i) => (
          <Text key={`c${i}`}>{`  ${l}`}</Text>
        ))}
        {stdout && (
          <>
            <Text dimColor>stdout:</Text>
            {stdout.split("\n").map((l, i) => (
              <Text key={`s${i}`} dimColor>{`  ${l}`}</Text>
            ))}
          </>
        )}
        {result && (
          <>
            <Text dimColor>result:</Text>
            {result.split("\n").map((l, i) => (
              <Text key={`r${i}`}>{`  ${l}`}</Text>
            ))}
          </>
        )}
      </Box>
    );
  },
};
