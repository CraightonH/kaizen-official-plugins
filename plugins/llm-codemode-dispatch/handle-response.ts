import type { ChatMessage, LLMResponse, ToolsRegistryService } from "llm-events/public";
import type { CodeModeConfig } from "./config.ts";
import type { SandboxRunResult } from "./sandbox-host.ts";
import { extractCodeBlocks } from "./extractor.ts";
import { formatResultMessage } from "./serialize.ts";

export type RunInSandbox = (
  code: string,
  registry: ToolsRegistryService,
  signal: AbortSignal,
  config: CodeModeConfig,
  emit?: (event: string, payload: unknown) => Promise<void>,
  turnId?: string,
  sessionId?: string,
) => Promise<SandboxRunResult>;

export interface HandleResponseInput {
  response: LLMResponse;
  registry: ToolsRegistryService;
  signal: AbortSignal;
  emit: (event: string, payload: unknown) => Promise<void>;
  turnId: string;
  sessionId: string;
}

export function makeHandleResponse(config: CodeModeConfig, runner: RunInSandbox) {
  return async function handleResponse(input: HandleResponseInput): Promise<ChatMessage[]> {
    const { code, ignoredCount } = extractCodeBlocks(input.response.content ?? "", config.maxBlocksPerResponse);
    if (!code) return [];

    const scoped = { turnId: input.turnId, sessionId: input.sessionId };
    await input.emit("codemode:code-emitted", { code, language: "typescript", ...scoped });

    const beforeExec: { code: string; turnId: string; sessionId: string } = { code, ...scoped };
    await input.emit("codemode:before-execute", beforeExec);
    const finalCode = beforeExec.code;

    let result: SandboxRunResult;
    try {
      result = await runner(finalCode, input.registry, input.signal, config, input.emit, input.turnId, input.sessionId);
    } catch (err) {
      // AbortError or unexpected — rethrow so driver handles cancellation
      throw err;
    }

    if (result.ok) {
      await input.emit("codemode:result", { stdout: result.stdout, returnValue: result.returnValue, ...scoped });
      const content = formatResultMessage(
        { ok: true, returnValue: result.returnValue, stdout: result.stdout, ignoredBlocks: ignoredCount },
        { maxStdoutBytes: config.maxStdoutBytes, maxReturnBytes: config.maxReturnBytes, maxBlocksPerResponse: config.maxBlocksPerResponse },
      );
      return [{ role: "user", content }];
    } else {
      await input.emit("codemode:error", { message: `${result.errorName}: ${result.errorMessage}`, stdout: result.stdout, ...scoped });
      const content = formatResultMessage(
        { ok: false, errorName: result.errorName, errorMessage: result.errorMessage, stdout: result.stdout, ignoredBlocks: ignoredCount },
        { maxStdoutBytes: config.maxStdoutBytes, maxReturnBytes: config.maxReturnBytes, maxBlocksPerResponse: config.maxBlocksPerResponse },
      );
      return [{ role: "user", content }];
    }
  };
}
