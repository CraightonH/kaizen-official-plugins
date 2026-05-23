import type { ToolSchema } from "llm-contracts/public";

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
