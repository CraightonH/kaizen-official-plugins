export async function* readSseFrames(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false });
  let buf = "";

  const onAbort = () => { reader.cancel().catch(() => {}); };
  if (signal.aborted) onAbort();
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        buf += decoder.decode();
        const tail = extractFrames(buf, true);
        buf = tail.rest;
        for (const f of tail.frames) {
          yield f;
          if (f === "[DONE]") return;
        }
        return;
      }
      buf += decoder.decode(value, { stream: true });
      const out = extractFrames(buf, false);
      buf = out.rest;
      for (const f of out.frames) {
        yield f;
        if (f === "[DONE]") return;
      }
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    try { reader.releaseLock(); } catch {}
  }
}

function extractFrames(buf: string, flush: boolean): { frames: string[]; rest: string } {
  const frames: string[] = [];
  // Normalize CRLF first, then split on \n\n.
  const normalized = buf.replace(/\r\n/g, "\n");
  const parts = normalized.split("\n\n");
  const rest = flush ? "" : parts.pop()!;
  for (const part of parts) {
    const lines = part.split("\n");
    let payload: string | null = null;
    for (const line of lines) {
      if (line.startsWith(":")) continue;          // comment
      if (line.startsWith("data:")) {
        const suffix = line.slice(5);
        const trimmed = suffix.startsWith(" ") ? suffix.slice(1) : suffix;
        payload = payload === null ? trimmed : payload + "\n" + trimmed;
      }
      // event:, id:, retry: are intentionally ignored.
    }
    if (payload !== null) frames.push(payload);
  }
  return { frames, rest };
}
