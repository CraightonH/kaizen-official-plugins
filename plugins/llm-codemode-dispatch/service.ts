import type { ToolDispatchStrategy } from "llm-events/public";

export function makeStrategy(_config: unknown, _deps: { log: (m: string) => void }): ToolDispatchStrategy {
  return {
    prepareRequest() { return {}; },
    async handleResponse() { return []; },
  };
}
