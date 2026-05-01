// Messages exchanged between sandbox-host (in main process) and sandbox-entry (in Bun Worker).
// host → worker
export interface InitMsg {
  type: "init";
  wrappedCode: string;        // already wrapped by sandbox-host using wrapCode()
  maxStdoutBytes: number;
}
export interface ToolResultMsg {
  type: "tool-result";
  id: string;
  ok: boolean;
  value?: unknown;
  error?: { name: string; message: string };
}

// worker → host
export interface ToolInvokeMsg {
  type: "tool-invoke";
  id: string;
  name: string;
  args: unknown;
}
export interface StdoutMsg {
  type: "stdout";
  chunk: string;
}
export interface DoneMsg {
  type: "done";
  returnValue: unknown;
}
export interface ErrorMsg {
  type: "error";
  name: string;
  message: string;
  stack?: string;
}

export type HostToWorker = InitMsg | ToolResultMsg;
export type WorkerToHost = ToolInvokeMsg | StdoutMsg | DoneMsg | ErrorMsg;
