# llm-skills

Skills registry plus default file-loader for the openai-compatible harness.
Scans `<project>/.kaizen/skills/` and `~/.kaizen/skills/` for `.md` files with
YAML frontmatter (`name`, `description`, optional `tokens`), exposes them via
the `skills:registry` service, appends an "Available skills" section to
`request.systemPrompt` on `llm:before-call`, and registers a synthetic
`load_skill(name)` tool into `tools:registry` so the LLM can pull a skill body
into its next-turn context.

Permission tier: `trusted` (read-only filesystem access; no writes, no exec, no
network).
