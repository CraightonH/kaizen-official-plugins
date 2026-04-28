import type { KaizenPlugin } from "kaizen/types";
import { basename } from "node:path";

const plugin: KaizenPlugin = {
  name: "claude-status-items",
  apiVersion: "3.0.0",
  permissions: { tier: "scoped", exec: { binaries: ["git"] } },
  services: { consumes: ["claude-events:vocabulary"] },

  async setup(ctx) {
    ctx.consumeService("claude-events:vocabulary");

    async function emitItems() {
      const cwd = process.cwd();
      await ctx.emit("status:item-update", {
        id: "cwd",
        content: basename(cwd) || cwd,
        priority: 80,
      });

      try {
        const r = await ctx.exec.run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeoutMs: 1000 });
        if (r.exitCode === 0) {
          const branch = r.stdout.trim();
          if (branch) {
            await ctx.emit("status:item-update", { id: "git.branch", content: branch, priority: 90 });
          }
        }
      } catch {
        // Not a repo, or git missing. Silent.
      }
    }

    ctx.on("session:start", emitItems);
    ctx.log("claude-status-items ready");
  },
};

export default plugin;
