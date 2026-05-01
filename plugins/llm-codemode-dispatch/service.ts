import type { ToolDispatchStrategy } from "llm-events/public";
import type { CodeModeConfig } from "./config.ts";
import { prepareRequest } from "./prepare-request.ts";
import { makeHandleResponse } from "./handle-response.ts";
import { runInSandbox } from "./sandbox-host.ts";

// Spec 0 propagation candidate: prepareRequest is typed sync but DTS rendering
// is async (json-schema-to-typescript). We return a Promise here; the driver
// awaits. If Spec 0 stays strict-sync, switch to a sync DTS renderer.
export function makeStrategy(config: CodeModeConfig, _deps: { log: (m: string) => void }): ToolDispatchStrategy {
  const handleResponse = makeHandleResponse(config, runInSandbox);
  const strategy: ToolDispatchStrategy = {
    // Cast: we return Promise<{...}>; driver MUST await.
    prepareRequest: ((input: any) => prepareRequest(input)) as any,
    handleResponse,
  };
  return strategy;
}
