import type { LogCallPayload, PhaseCallPayload } from "../rpc-types.ts";

export interface PhaseDeps { runId: string; emit: (event: string, payload: unknown) => void; }

export function makePhaseCallback(deps: PhaseDeps): (p: PhaseCallPayload) => void {
  return (p) => deps.emit("workflow:phase", { runId: deps.runId, phase: p.phase });
}

export function makeLogCallback(deps: PhaseDeps): (p: LogCallPayload) => void {
  return (p) => deps.emit("workflow:log", { runId: deps.runId, message: p.message });
}
