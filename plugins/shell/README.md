# shell

TTY passthrough shell for the minimum harness

## Installation

```sh
kaizen install <marketplace>/shell@<version>
```

## Configuration

_No configuration keys defined._


## Harness

Add to your `kaizen.json`:

```json
{
  "plugins": ["<marketplace>/shell@0.1.0"]
}
```

## Permissions

Tier: `unscoped`

_No additional grants required._

## Development

```sh
bun install
bun test
kaizen plugin validate .
```
