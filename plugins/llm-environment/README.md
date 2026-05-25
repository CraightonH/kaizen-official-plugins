# llm-environment

Adds an `Environment` section to the assembled system prompt for the
local harness. Lets the LLM see the current working directory,
host platform, and git branch.

## Rendered output

```
## Environment

- Working directory: /Users/you/projects/app
- Platform: darwin (Darwin 25.4.0)
- Git branch: main
```

In a non-git directory, the `Git branch:` line is omitted. In a detached-HEAD
state, the line reads `Git branch: (detached HEAD)`.

## Slash command

- `/env:refresh` — re-captures the snapshot. Use after `cd` or branch checkout.

## Tool

When `tools:registry` is present, the plugin registers:

- `environment_refresh` — re-captures the snapshot. Tagged
  `["environment", "diagnostic", "synthetic"]`.

## Configuration

Stored in the harness config file under the `llm-environment` key
(`~/.kaizen/harnesses/<key>/config.json`).

| Field   | Type    | Default | Notes |
|---------|---------|---------|-------|
| enabled | boolean | `true`  | When `false`, the section renders empty and is dropped. |

## Kill switches

Three layers, in increasing finality:

1. Set `enabled: false` in the harness config for `llm-environment` — the
   section renders empty and is dropped (requires harness restart).
2. `prompt:disable llm-environment:env` — per-session toggle via the
   `llm-system-prompt` slash command.
3. Uninstall the plugin from the harness manifest.

## Future fields

The snapshot is the natural home for timezone, locale, and language hints;
none are shipped in v0.1.0.
