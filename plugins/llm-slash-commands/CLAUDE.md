# Working in `llm-slash-commands`

Notes for agents editing this plugin. See `README.md` for the user-facing contract.

## Module map

```
index.ts          Plugin lifecycle: builds registry, registers built-ins, loads file commands,
                  provides slash:registry (defineService is in llm-contracts), subscribes
                  input:submit at priority 100, optionally registers a ui:completion-source.
                  Only file that touches `ctx`.
registry.ts       createRegistry() → SlashRegistryService. Pure logic. In-memory Map keyed by
                  name. Validates name shape and the bare-name-vs-plugin rule on every register.
parser.ts         parse(text) → { name, args } | null. Pure function. Single regex; treats a
                  line as a slash command iff it starts with "/" + [a-z] + valid name shape.
dispatcher.ts     makeOnInputSubmit({ registry, bus }) → onInputSubmit handler. Owns the
                  per-dispatch inSlashDispatch guard, builds SlashCommandContext, wraps emit
                  to reject re-entrant input:submit, emits input:handled exactly once per claim.
builtins.ts       registerBuiltins(registry). Defines /help, /exit (emits
                  harness:exit-requested), and /history (emits tui:enter-history).
                  Session-management commands (/clear, /session:*) live in
                  llm-session-manager and register against this registry as peers.
file-loader.ts    loadFileCommands({ home, cwd, registry, readDir, readFile, getDriver }) →
                  warnings[]. Walks user dir then project dir; project shadows user (same-name
                  user file is unregistered before re-registering). Builds per-file handlers
                  that substitute {{args}} and call driver:run-conversation if available.
frontmatter.ts    parseMarkdownCommandFile(path, raw). Pure. Validates YAML frontmatter shape
                  and returns either { ok: true, ...} or { ok: false, reason }.
completion.ts     buildCompletionSource(registry) → { trigger: "/", list(input, cursor) }.
                  Pure; sorts built-ins first, then files, then plugin-namespaced; alpha within rank.
errors.ts         Typed errors: BareNamePluginError, ReentrantSlashEmitError,
                  DuplicateRegistrationError, InvalidNameError.
public.d.ts       Re-exports of the public types and error classes.
```

Boundaries:
- Only `index.ts` imports from `kaizen/types` or touches `ctx`. Every other module takes its dependencies via plain function parameters and is unit-testable in isolation.
- `registry.ts` is the only module with mutable state visible to the outside world. `dispatcher.ts` has one closure-scoped boolean (`inSlashDispatch`); `file-loader.ts` has a transient `userOffs` map confined to one call.
- Tests live alongside under `test/` and run independently with `bun test`.

## Invariants

- **Parse miss → silence.** If `parse()` returns `null`, the subscriber returns without emitting anything. The driver's lower-priority subscriber is responsible for treating the line as a normal user message. Do not emit `input:handled` on parse miss.
- **Every claimed dispatch emits `input:handled` exactly once.** Matched command, unknown command, and handler-threw all go through the same `await deps.bus.emit("input:handled", { by: "llm-slash-commands" })` in the `try` block's tail. If you add new branches, route them through the same emit.
- **`inSlashDispatch` is set for the entire dispatch.** Set before the wrapped emit/handler runs; cleared in `finally`. Nested `input:submit` events delivered to the subscriber while set must return immediately.
- **Re-entrant `input:submit` from handlers throws.** The wrapped `emit` checks the event name and throws `ReentrantSlashEmitError`. Do not relax this — markdown bodies and plugin handlers must use `conversation:user-message` + `driver:run-conversation` to push synthetic input.
- **Plugin-source bare names are forbidden at registration time.** `source: "plugin"` + name without `:` throws `BareNamePluginError`. Built-in and file sources are exempt. Don't add a back door.
- **Project shadows user; built-ins shadow both.** File loader processes user dir then project dir, and only the project pass passes `allowReplace: true`. The replacement path explicitly only replaces an existing entry whose `source === "file"` — never a built-in or plugin command.
- **Names are case-sensitive.** Parser regex is `[a-z]`-anchored; `/Foo` parses as not-a-command and falls through.

## Adding a built-in / plugin command

Built-ins shipped by this plugin go in `builtins.ts` and use `source: "builtin"`. They may use bare names but should not collide with the reserved driver names (`clear`, `model`).

Other plugins register namespaced commands via the service:

```typescript
const slash = ctx.useService<SlashRegistryService>("slash:registry");
const off = slash.register(
  {
    name: "myplugin:do-thing",          // MUST contain ":" when source: "plugin"
    description: "Does the thing",
    usage: "<target>",
    source: "plugin",
  },
  async (cmdCtx) => {
    if (!cmdCtx.args.trim()) {
      await cmdCtx.print("Usage: /myplugin:do-thing <target>");
      return;
    }
    // Use cmdCtx.emit (NOT ctx.emit) so re-entrancy guards apply.
    await cmdCtx.emit("conversation:user-message", { message: { role: "user", content: ... } });
  },
);
// On teardown: off();
```

**Markdown output.** `cmdCtx.print(text, { markdown: true })` forwards a `markdown: true` marker on the `conversation:system-message` payload; the driver bridges that into `writeNotice(text, { markdown: true })`, and `llm-tui` renders the body through marked-terminal (and drops `dimColor`). Omit the opt for plain notices.

The service lookup is optional — guard with try/catch and no-op if the registry is absent so your plugin still loads in harnesses without slash commands.

## Editing file-loader behavior

The format is intentionally narrow: YAML frontmatter (`description` required, `usage` optional, `arguments.required` optional boolean) plus a body with `{{args}}` substitution. Treat extensions as user-visible — update `frontmatter.ts` validation, the file-loader handler, and the spec in lockstep, and add fixtures under `test/fixtures/`.

The substitution token is exactly `{{args}}` (no whitespace tolerance, no escape syntax). Do not add Mustache-style helpers here; if a real use case appears, lift it into a separate templating module.

## Testing

```bash
cd plugins/llm-slash-commands && bun test
```

Tests use `bun:test` only. Each module has a focused test file; `integration.test.ts` exercises the full setup path with a fake bus, a fake registry consumer, and fixture markdown commands. Use the fake-bus pattern from `dispatcher.test.ts` rather than spinning up a real Kaizen runtime.

## Local deploy

Build from the source directory (where workspace deps resolve), then sync into the install dir:

```bash
PLUGIN=llm-slash-commands
VERSION=$(jq -r .version plugins/$PLUGIN/package.json)
INSTALL_DIR=~/.kaizen/marketplaces/official/plugins/${PLUGIN}@${VERSION}
(cd plugins/$PLUGIN && bun build --target=bun --outfile=dist/index.js index.ts)
mkdir -p "$INSTALL_DIR/dist"
cp plugins/$PLUGIN/dist/index.js "$INSTALL_DIR/dist/index.js"
rsync -a --exclude='node_modules' --exclude='dist' plugins/$PLUGIN/ "$INSTALL_DIR/"
```

If you also need the harness manifest to pick up changes, sync the local marketplace repo (`~/.kaizen/marketplaces/official/repo/`) — it tracks upstream `main` and `kaizen marketplace update` will overwrite local edits.
