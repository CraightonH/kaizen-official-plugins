# llm-local-tools

> **WARNING — read this first.**
>
> This plugin is **not** sandboxed. It executes whatever shell commands and file writes the LLM emits, with the full privileges of the kaizen process. Do not use it with prompts you did not author, or with LLMs you do not trust to follow instructions. For untrusted contexts, use `llm-local-tools-sandboxed` (planned, not yet shipped).

Built-in local-development toolset for the openai-compatible harness. Registers seven tools into the `tools:registry` service from Spec 4:

| Tool   | Tags             | Purpose                                                          |
| ------ | ---------------- | ---------------------------------------------------------------- |
| read   | local, fs        | Read a file with line-numbered output. Caps: 50 MB hard, 256 KB / 2000 lines returned. Refuses binary files. |
| write  | local, fs        | Overwrite an existing file. Refuses if file does not exist.      |
| create | local, fs        | Create a new file. Refuses if file already exists. No mkdir-p.   |
| edit   | local, fs        | Exact-string replace. Unique-match contract; `replace_all` opt-in. |
| glob   | local, fs        | File listing by pattern. Honors `.gitignore` when in a git repo. |
| grep   | local, fs        | Regex content search. Wraps `rg` if present; JS fallback otherwise. |
| bash   | local, shell     | Shell command exec. Default 120 s timeout, hard cap 600 s. 256 KB middle-truncation. |

## Tag-based filtering

Capability plugins (e.g. `llm-agents`) compose toolsets via the registry filter API:

```ts
registry.list({ tags: ["fs"] })   // five tools, no shell
registry.list({ tags: ["shell"] }) // bash only
registry.list({ tags: ["local"] }) // all seven
```

A "researcher" agent typically uses `toolFilter: { tags: ["fs"] }` to omit `bash`.

## Configuration

This plugin has no configuration file. Behavior is fixed; per-tool caps and timeouts are spec-defined defaults. Working directory is `process.cwd()` at invoke time.

## Working directory

Every tool resolves paths against `process.cwd()` at the moment the LLM calls it. There is no plugin-managed cwd. If the LLM runs `cd foo && ...` inside a `bash` call, only the child shell sees the change — the parent kaizen process does not. This matches Claude Code semantics.

## Safety semantics (per-tool)

- `read`: 50 MB hard refusal; binary-byte refusal; symlinks are followed; no path allow-list.
- `write` / `create`: parent dir must exist; no symlink-target validation; no path allow-list.
- `edit`: unique-match required (or `replace_all`); whitespace-sensitive.
- `glob` / `grep`: read-only listing/search.
- `bash`: full shell, no command allow-list. `run_in_background: true` is rejected in v0.

For untrusted contexts, replace this plugin with `llm-local-tools-sandboxed` (planned).

## Background processes

`run_in_background: true` is reserved in `bash`'s schema but rejected at runtime in v0. A v1 follow-up may add `bash_output({ id })` and `bash_kill({ id })`. Schema reservation now means future addition is non-breaking.

## ripgrep dependency

Soft. On first invocation of `grep`, the plugin probes `which rg`. If absent, it logs a one-line warning and uses a JS fallback (slower; ECMAScript regex flavor instead of Rust regex). Install `ripgrep` for faster searches and richer regex support.
