import type { KaizenPlugin } from "kaizen/types";
import type { UiChannel } from "./public";
import type { StatusItem } from "./render";
import { renderPrompt, renderStatusRow } from "./render.ts";
import { createInputReader } from "./input.ts";

const SLASH_COMMANDS = new Set(["/exit", "/clear"]);

const plugin: KaizenPlugin = {
  name: "claude-tui",
  apiVersion: "3.0.0",
  permissions: { tier: "unscoped" },
  services: {
    provides: ["claude-tui:channel"],
    consumes: ["claude-events:vocabulary"],
  },

  async setup(ctx) {
    ctx.consumeService("claude-events:vocabulary");
    ctx.defineService("claude-tui:channel", { description: "Terminal UI channel: input + output + status bar." });

    const items = new Map<string, StatusItem>();
    let busy = false;
    let busyMessage: string | undefined;

    function repaint() {
      const cols = process.stdout.columns ?? 80;
      const prompt = renderPrompt({ width: Math.min(cols, 100), busy, busyMessage });
      const status = renderStatusRow([...items.values()], cols);
      // Clear current line region, redraw. Simple approach: write CR + ANSI clear.
      process.stdout.write("\x1b[2K\r");
      process.stdout.write(prompt + "\n" + status + "\n");
    }

    const input = createInputReader({
      onSigInt: () => {
        if (busy) {
          ctx.emit("turn:cancel").catch(() => {});
        } else {
          process.exit(0);
        }
      },
    });

    // Status items accumulate silently; the bar redraws on the next setBusy()
    // transition or readInput() so we don't spam the terminal with repainted
    // prompt boxes for every incoming item.
    ctx.on("status:item-update", async (payload: any) => {
      if (!payload?.id) return;
      items.set(payload.id, payload as StatusItem);
    });
    ctx.on("status:item-clear", async (payload: any) => {
      if (!payload?.id) return;
      items.delete(payload.id);
    });

    const ui: UiChannel = {
      async readInput() {
        repaint();
        while (true) {
          const line = await input.readLine();
          if (line === "") return ""; // EOF
          if (SLASH_COMMANDS.has(line.trim())) {
            if (line.trim() === "/exit") return "";
            if (line.trim() === "/clear") {
              process.stdout.write("\x1b[2J\x1b[H");
              repaint();
              continue;
            }
          }
          return line;
        }
      },
      writeOutput(chunk: string) {
        process.stdout.write(chunk);
      },
      writeNotice(line: string) {
        process.stdout.write(`\x1b[2m${line}\x1b[0m\n`);
      },
      setBusy(b: boolean, message?: string) {
        busy = b;
        busyMessage = message;
        repaint();
      },
    };

    ctx.provideService<UiChannel>("claude-tui:channel", ui);
  },

  async stop() {
    // readline close happens at process exit; nothing to do.
  },
};

export default plugin;
