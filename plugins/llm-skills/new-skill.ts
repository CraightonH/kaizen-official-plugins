import { lstat, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ToolSchema } from "llm-contracts/public";
import type { SkillsRegistryService } from "./public";
import { estimateTokens } from "./tokens.ts";

export const NEW_SKILL_SCHEMA: ToolSchema = {
  name: "new_skill",
  description:
    "Author a new kaizen-native skill from this conversation. Writes a SKILL.md " +
    "file with the supplied frontmatter and body into either the project's " +
    ".kaizen/skills/ directory or the user's ~/.kaizen/skills/ directory. Refuses " +
    "if a skill with that name already exists in the target scope. The new skill " +
    "is registered before the tool returns.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description:
          "Skill name. Single segment, lowercase, [a-z0-9_-], starting with [a-z0-9]. " +
          "Becomes the directory name under the scope's root.",
      },
      description: {
        type: "string",
        description:
          "One-line description shown to the LLM in the Available skills prompt section. " +
          "≤200 chars, no newlines.",
      },
      body: {
        type: "string",
        description:
          "Markdown body of the skill (the part after the frontmatter). Non-empty.",
      },
      scope: {
        type: "string",
        enum: ["project", "user"],
        description:
          "Where to write: 'project' for <cwd>/.kaizen/skills/, 'user' for ~/.kaizen/skills/.",
      },
    },
    required: ["name", "description", "body", "scope"],
    additionalProperties: false,
  },
  tags: ["skills", "synthetic", "mutating"],
};

export interface NewSkillInput {
  name: string;
  description: string;
  body: string;
  scope: "project" | "user";
}

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
const NAME_MAX = 64;
const DESCRIPTION_MAX = 200;

/**
 * Validate the shape and values of a new_skill input. Throws on the first
 * violation with a message naming the field and the rule. Does not touch the
 * filesystem.
 */
export function validateNewSkillInput(raw: unknown): asserts raw is NewSkillInput {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("new_skill: args must be an object");
  }
  const { name, description, body, scope } = raw as Record<string, unknown>;

  if (typeof name !== "string") throw new Error("new_skill: 'name' is required and must be a string");
  if (!NAME_RE.test(name)) {
    throw new Error("new_skill: name must match [a-z0-9_-], starting with [a-z0-9]");
  }
  if (name.length > NAME_MAX) {
    throw new Error(`new_skill: name must be ≤ ${NAME_MAX} chars (got ${name.length})`);
  }

  if (typeof description !== "string") {
    throw new Error("new_skill: 'description' is required and must be a string");
  }
  if (description.trim().length === 0) {
    throw new Error("new_skill: description must be non-empty");
  }
  if (description.includes("\n") || description.includes("\r")) {
    throw new Error("new_skill: description must be single-line (no \\n or \\r)");
  }
  if (description.length > DESCRIPTION_MAX) {
    throw new Error(`new_skill: description must be ≤ ${DESCRIPTION_MAX} chars (got ${description.length})`);
  }

  if (typeof body !== "string") {
    throw new Error("new_skill: 'body' is required and must be a string");
  }
  if (body.trim().length === 0) {
    throw new Error("new_skill: body must be non-empty");
  }

  if (scope !== "project" && scope !== "user") {
    throw new Error("new_skill: 'scope' must be \"project\" or \"user\"");
  }
}

export interface ResolveTargetPathArgs {
  name: string;
  scope: "project" | "user";
  projectRoot: string;
  userRoot: string;
}

export interface ResolvedTargetPath {
  /** Absolute path to the skill's directory (will be created). */
  baseDir: string;
  /** Absolute path to the SKILL.md file (will be written). */
  file: string;
}

/**
 * Compute the on-disk target for a new skill. Pure — no filesystem access.
 */
export function resolveTargetPath(args: ResolveTargetPathArgs): ResolvedTargetPath {
  const root = args.scope === "project" ? args.projectRoot : args.userRoot;
  const baseDir = join(root, args.name);
  const file = join(baseDir, "SKILL.md");
  return { baseDir, file };
}

/**
 * Refuse to write if anything exists at `baseDir`. Uses `lstat` so a symlink at
 * the target is treated as a collision (not followed). Throws on collision;
 * resolves with `undefined` if the path is free.
 */
export async function assertNoCollision(baseDir: string, name: string): Promise<void> {
  try {
    await lstat(baseDir);
  } catch (err: any) {
    if (err && err.code === "ENOENT") return;
    throw err;
  }
  throw new Error(`new_skill: skill '${name}' already exists at ${baseDir}`);
}

export interface ComposeSkillFileInput {
  name: string;
  description: string;
  body: string;
}

/**
 * Build the canonical SKILL.md file text. The frontmatter `name:` is
 * informational only — the path-derived name is canonical in the registry.
 */
export function composeSkillFile(input: ComposeSkillFileInput): string {
  const body = input.body.endsWith("\n") ? input.body : `${input.body}\n`;
  return `---\nname: ${input.name}\ndescription: ${input.description}\n---\n\n${body}`;
}

export interface MakeNewSkillHandlerDeps {
  projectRoot: string;
  userRoot: string;
  registry: SkillsRegistryService;
}

export type ToolHandlerFn = (
  args: unknown,
  ctx: { signal: AbortSignal; callId: string; turnId?: string; log: (m: string) => void },
) => Promise<unknown>;

export interface NewSkillResult {
  name: string;
  path: string;
  scope: "project" | "user";
  tokens: number;
}

/**
 * Build the new_skill handler. Pure factory; no module-scope state.
 *
 * Behaviour on success:
 *   1. Validate input (throws on violation).
 *   2. Resolve target path under the chosen scope's root.
 *   3. Refuse if anything exists at the target dir (lstat — does not follow symlinks).
 *   4. Compose SKILL.md text; mkdir -p the skill directory.
 *   5. Atomic write: writeFile to `SKILL.md.tmp-<pid>-<nonce>`, then rename to `SKILL.md`.
 *   6. await registry.rescan() — the registry's onChange callback fires the
 *      prompt-section bump and the skill:available-changed emit.
 *   7. Return { name, path, scope, tokens }, with tokens read from the freshly
 *      rescanned registry entry (heuristic fallback if absent).
 */
export function makeNewSkillHandler(deps: MakeNewSkillHandlerDeps): ToolHandlerFn {
  return async (args) => {
    validateNewSkillInput(args);

    const { name, description, body, scope } = args;

    const { baseDir, file } = resolveTargetPath({
      name,
      scope,
      projectRoot: deps.projectRoot,
      userRoot: deps.userRoot,
    });

    await mkdir(dirname(baseDir), { recursive: true });   // ensure scope root exists
    await assertNoCollision(baseDir, name);
    await mkdir(baseDir, { recursive: true });             // create skill dir

    const text = composeSkillFile({ name, description, body });
    const nonce = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
    const tmp = `${file}.tmp-${nonce}`;
    await writeFile(tmp, text, { encoding: "utf8", mode: 0o644 });
    await rename(tmp, file);

    try {
      await deps.registry.rescan();
    } catch (err: any) {
      throw new Error(
        `new_skill: SKILL.md was written to ${file} but registry rescan failed: ${err?.message ?? String(err)}. The skill will be picked up on the next turn:start.`,
      );
    }

    const entry = deps.registry.list().find(m => m.name === name);
    const tokens = typeof entry?.tokens === "number" ? entry.tokens : estimateTokens(body);

    const result: NewSkillResult = { name, path: file, scope, tokens };
    return result;
  };
}
