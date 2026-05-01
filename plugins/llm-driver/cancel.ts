import type { CurrentTurn } from "./state.ts";

export interface CancelCtx {
  on(event: string, handler: (payload: any) => void | Promise<void>): () => void;
}

export function wireCancel(ctx: CancelCtx, getCurrent: () => CurrentTurn | null): () => void {
  const off = ctx.on("turn:cancel", async (payload: { turnId?: string } | undefined) => {
    const current = getCurrent();
    if (!current) return;
    const targeted = payload && typeof payload.turnId === "string";
    if (targeted && payload!.turnId !== current.id) return;
    current.controller.abort();
  });
  return off;
}
