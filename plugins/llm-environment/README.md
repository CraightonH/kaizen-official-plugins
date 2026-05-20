# llm-environment

Adds an `Environment` section to the assembled system prompt for the
openai-compatible harness. Lets the LLM see the current working directory,
host platform, and git branch.

## Rendered output

```
## Environment

- Working directory: /Users/you/projects/app
- Platform: darwin (Darwin 25.4.0)
- Git repo: main
```

In a non-git directory, the `Git repo:` line is omitted. In a detached-HEAD
state, the line reads `Git repo: yes`.

## Slash command

- `/env:refresh` — re-captures the snapshot. Use after `cd` or branch checkout.

## Tool

When `tools:registry` is present, the plugin registers:

- `environment_refresh` — re-captures the snapshot. Tagged
  `["environment", "diagnostic", "synthetic"]`.

## Kill switches

Three layers, in increasing finality:

1. `KAIZEN_ENVIRONMENT_DISABLE=1` — the section renders empty and is dropped.
2. `prompt:disable llm-environment:env` — per-session toggle via the
   `llm-system-prompt` slash command.
3. Uninstall the plugin from the harness manifest.

## Future fields

The snapshot is the natural home for timezone, locale, and language hints;
none are shipped in v0.1.0.
