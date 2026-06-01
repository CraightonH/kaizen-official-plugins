import type { WorkflowPhase } from "llm-contracts/public";

// host → worker
export interface BootMsg {
  type: "BOOT";
  runId: string;
  source: string;
  args: unknown;
  metaPhases: WorkflowPhase[];
  budgetTotal: number | null;
}
export interface CallResultMsg {
  type: "CALL_RESULT";
  callId: number;
  value: unknown;
}
export interface CallErrorMsg {
  type: "CALL_ERROR";
  callId: number;
  error: { name: string; message: string; stack?: string };
}
export interface CancelMsg {
  type: "CANCEL";
  reason: string;
}

// worker → host
export interface ReadyMsg { type: "READY"; }
export interface CallMsg {
  type: "CALL";
  callId: number;
  kind: "agent" | "log" | "phase" | "workflow" | "budgetRead";
  payload: unknown;
}
export interface DoneMsg {
  type: "DONE";
  value: unknown;
}
export interface WorkerErrorMsg {
  type: "WORKER_ERROR";
  error: { name: string; message: string; stack?: string };
}

export type HostToWorker = BootMsg | CallResultMsg | CallErrorMsg | CancelMsg;
export type WorkerToHost = ReadyMsg | CallMsg | DoneMsg | WorkerErrorMsg;

// Payload shapes for `CallMsg.payload` per `kind`:
export interface AgentCallPayload {
  prompt: string;
  label?: string;
  phase?: string;
  model?: string;
  agentType?: string;
  schema?: object;        // reserved (v1.1)
  isolation?: "worktree"; // reserved (v1.1)
}
export interface LogCallPayload { message: string; }
export interface PhaseCallPayload { phase: string; }
export interface WorkflowCallPayload { nameOrRef: string | { scriptPath: string }; args: unknown; }
export interface BudgetReadPayload { what: "spent" | "remaining" | "total"; }
