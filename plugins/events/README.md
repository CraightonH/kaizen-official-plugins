# events

Event vocabulary for the minimum shell harness

## Installation

```sh
kaizen install <marketplace>/events@<version>
```

## Configuration

_No configuration keys defined._


## Harness

Add to your `kaizen.json`:

```json
{
  "plugins": ["<marketplace>/events@0.1.0"]
}
```

## Permissions

Tier: `trusted`

_No additional grants required._

## Development

```sh
bun install
bun test
kaizen plugin validate .
```
