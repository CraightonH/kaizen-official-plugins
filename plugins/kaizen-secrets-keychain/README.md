# kaizen-secrets-keychain

macOS Keychain backend for `kaizen-config`'s `secrets:registry`. Registers
the `keychain:` resolver scheme so secret-marked fields can be stored in
the user's login keychain.

## Requirements

- macOS (the `security` CLI must be available on `PATH`).
- A `kaizen-config` version that provides `secrets:registry`.

## How it works

When a plugin's schema marks a string field as `secret: true`, `kaizen-config`
stores it on disk as a pointer (`{ "$ref": "keychain:<plugin>/<field>" }`)
and routes the actual value through the registered keychain resolver. This
plugin shells out to `security` for every read/write.

## First-use prompt

The first time `security find-generic-password` reads a value created by
this plugin, macOS may show an "Always Allow / Allow / Deny" dialog. Pick
"Always Allow" for silent subsequent reads. This is normal Keychain UX and
cannot be suppressed by a CLI caller.

## Service constant

All entries created by this plugin use the keychain service
`kaizen-secrets`. Account names take the form `<plugin>/<field>`. You can
inspect entries with:

```
security dump-keychain | grep '"svce"<blob>="kaizen-secrets"'
```
