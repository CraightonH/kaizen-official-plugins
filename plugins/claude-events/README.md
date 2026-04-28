# claude-events

Event vocabulary for the claude-wrapper harness. Pure vocab plugin: defines event names and provides them as the `claude-events:vocabulary` service.

## Events

- `session:start`, `session:end`, `session:error`
- `turn:before`, `turn:after`, `turn:cancel`
- `status:item-update`, `status:item-clear`

## Permissions

Tier: `trusted`. No I/O.

## Development

```sh
bun install
bun test
```
