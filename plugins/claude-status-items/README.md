# claude-status-items

Default status items for the claude-wrapper harness:
- `cwd` — basename of `process.cwd()` (priority 80)
- `git.branch` — `git rev-parse --abbrev-ref HEAD` (priority 90, omitted if not a git repo)

Both items emitted once on `session:start`.

## Permissions

Tier: `scoped`. Grants: `exec.binaries: ["git"]`.

## Development

```sh
bun install
bun test
```
