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
