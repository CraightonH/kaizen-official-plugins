export type CopyVia = "pbcopy" | "xclip" | "xsel" | "clip" | "osc52" | "none";

export interface CopyResult {
  ok: boolean;
  via: CopyVia;
  error?: string;
}

export interface ClipboardDeps {
  platform?: NodeJS.Platform;
  spawn?: (cmd: string[], stdin: string) => Promise<{ exitCode: number; missing?: boolean }>;
  writeStdout?: (s: string) => void;
}

async function realSpawn(cmd: string[], stdin: string): Promise<{ exitCode: number; missing?: boolean }> {
  try {
    const proc = Bun.spawn(cmd, { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
    proc.stdin.write(stdin);
    await proc.stdin.end();
    const code = await proc.exited;
    return { exitCode: code ?? 0 };
  } catch (err: any) {
    return { exitCode: 1, missing: true };
  }
}

function platformCandidates(platform: NodeJS.Platform): Array<{ via: CopyVia; cmd: string[] }> {
  if (platform === "darwin") return [{ via: "pbcopy", cmd: ["pbcopy"] }];
  if (platform === "win32") return [{ via: "clip", cmd: ["clip.exe"] }];
  return [
    { via: "xclip", cmd: ["xclip", "-selection", "clipboard"] },
    { via: "xsel", cmd: ["xsel", "--clipboard", "--input"] },
  ];
}

function emitOsc52(text: string, writeStdout: (s: string) => void): void {
  const b64 = Buffer.from(text, "utf8").toString("base64");
  writeStdout(`\x1B]52;c;${b64}\x07`);
}

export async function copyToClipboard(text: string, deps?: ClipboardDeps): Promise<CopyResult> {
  const platform = deps?.platform ?? process.platform;
  const spawn = deps?.spawn ?? realSpawn;
  const writeStdout = deps?.writeStdout ?? ((s: string) => process.stdout.write(s));

  const candidates = platformCandidates(platform);
  let lastError = "";
  for (const c of candidates) {
    const { exitCode, missing } = await spawn(c.cmd, text);
    if (exitCode === 0) return { ok: true, via: c.via };
    if (!missing) lastError = `${c.via} exited ${exitCode}`;
  }

  try {
    emitOsc52(text, writeStdout);
    return { ok: true, via: "osc52" };
  } catch (err: any) {
    return { ok: false, via: "none", error: lastError || String(err?.message ?? err) };
  }
}
