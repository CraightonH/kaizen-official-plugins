# OpenAI-Compatible Harness — A-tier (Spec 3)

**Status:** draft
**Date:** 2026-04-30
**Scope:** The A-tier harness file `harnesses/openai-compatible.json`, the marketplace catalog updates that publish it, the user-facing setup story (LM Studio or any OpenAI-compatible server), repo README updates, and validation/test plan. Implementation of `llm-events`, `openai-llm`, and `llm-driver` is covered by their own specs (Specs 0/1/2). This spec composes them into a runnable harness and ratifies plugin reuse.

## Goal

Ship a minimal, runnable harness that lets a user converse with a local OpenAI-compatible LLM through the kaizen TUI. "A-tier" means chat end-to-end: streaming tokens, lifecycle events, cancellation. No tools, no skills, no agents. The artefact is the harness file plus the marketplace entries that make `kaizen --harness official/openai-compatible@0.1.0` work.

## Non-goals

- Implementing or re-specifying `llm-events`, `openai-llm`, or `llm-driver` internals — see their specs.
- Tools, dispatch strategies, sandboxing, skills, agents, MCP, memory — B/C-tier.
- Provider plugins other than `openai-llm`.
- Replacing `claude-wrapper`. Both harnesses coexist.
- Auth flows other than a static API key (`OPENAI_API_KEY` env var or config field). OAuth/Bedrock/etc. are out of scope.

## Plugin roster

The A-tier harness composes five plugins, all consumed via the marketplace catalog:

| Plugin | Version | Status | Role |
|---|---|---|---|
| `official/llm-events` | `0.1.0` | new | Vocabulary + shared types (Spec 0). |
| `official/openai-llm` | `0.1.0` | new | Provides `llm:complete` (Spec 1). |
| `official/llm-driver` | `0.1.0` | new | Turn loop, conversation state, `driver:run-conversation` (Spec 2). |
| `official/claude-tui` | `0.2.0` | reused | TUI: `ui:channel`, status bar, slash commands. |
| `official/claude-status-items` | `0.1.2` | reused | Default `cwd` + `git.branch` status items. |

All A-tier plugins ship at v0.1.0 of their own packages. The harness file itself is published at v0.1.0 in the marketplace.

## Reuse compatibility: claude-tui and claude-status-items

Spec 0 declared these two plugins reusable. Verified:

- `plugins/claude-tui/index.tsx` only emits/subscribes to `status:item-update`, `status:item-clear`, and `turn:cancel`. All three are in the `llm-events` VOCAB with identical names and payload shapes (Spec 0 §Status, §Turn).
- `plugins/claude-status-items/index.ts` subscribes to `session:start` and emits `status:item-update`. Both names are in the `llm-events` VOCAB.
- Neither plugin uses the `claude-events:vocabulary` service value at runtime. They `consumeService("claude-events:vocabulary")` only to enforce load ordering — i.e. so the vocabulary plugin's `defineEvent` calls happen first.

**Decision: option (a) with a one-line edit, no shim.** Update `plugins/claude-tui` and `plugins/claude-status-items` to declare both vocabulary services as consumable and to call `consumeService` for whichever one is present. Concretely:

```ts
services: { consumes: ["claude-events:vocabulary", "llm-events:vocabulary"] }
```

and in `setup`, `consumeService` either name (only one will resolve depending on harness). Bump `claude-tui` to `0.2.1` and `claude-status-items` to `0.1.3`. The `claude-wrapper` harness keeps pinning `claude-tui@0.2.0` / `claude-status-items@0.1.2` until it bumps; the new harness pins the new versions. This avoids a shim plugin and keeps the dependency graph flat.

Justification: the rename surface is two lines of metadata. A shim plugin would add a third package to maintain and a runtime indirection for zero benefit.

## Harness file: `harnesses/openai-compatible.json`

Structure mirrors `harnesses/claude-wrapper.json` exactly: a top-level `plugins` array of `name@version` strings. No conditionals, no profiles. Contents:

```
official/llm-events@0.1.0
official/openai-llm@0.1.0
official/llm-driver@0.1.0
official/claude-tui@0.2.1
official/claude-status-items@0.1.3
```

Order is incidental; kaizen resolves load order from `services.consumes` declarations. `llm-events` will load first by virtue of every other plugin consuming `llm-events:vocabulary`.

## Single-harness-file decision

Spec 0 lists three tiers. Open question: one harness file with toggles, or one file per tier?

**Decision: one harness file per tier, with distinct names.** A-tier ships as `harnesses/openai-compatible.json` (the user-facing identity) and stays at v0.1.x for the duration of the A milestone. When B-tier lands, it overwrites the same file at v0.2.0 (additive: keeps everything from A and adds tools-registry + a default dispatch strategy). C-tier becomes v0.3.0.

Rationale:
- Users always pick `official/openai-compatible@<version>`. Versioning communicates capability.
- B/C-tier are strict supersets of A; shipping them as separate harness names (`-A`, `-B`, `-C`) would force users to migrate harness identity to gain features.
- Plugin authors building against `openai-compatible` track one moving target.
- The dispatch-strategy choice at C-tier (native vs. code-mode) is a harness-level decision baked into the file. Per Spec 0, default is `llm-codemode-dispatch`. If users want to override, they fork the harness file or wait for a config-driven selection mechanism (out of scope here).

The "A-tier file is just for testing" alternative is rejected: we want real users on `0.1.0` so we get feedback before adding tools.

## Marketplace catalog updates (`.kaizen/marketplace.json`)

Add four `plugin` entries and one `harness` entry. Bump two existing plugin entries.

New plugin entries (one `versions[]` element each):

- `llm-events` → `0.1.0`, `source: file plugins/llm-events`. Categories: `["events"]`. Description: "Event vocabulary and shared types for openai-compatible harnesses."
- `openai-llm` → `0.1.0`, `source: file plugins/openai-llm`. Categories: `["llm", "openai"]`. Description: "OpenAI-compatible LLM provider. Provides `llm:complete`."
- `llm-driver` → `0.1.0`, `source: file plugins/llm-driver`. Categories: `["driver", "llm"]`. Description: "Turn loop and conversation state. Provides `driver:run-conversation`."

Bumped existing entries (append a new `versions[]` element; keep prior entries for `claude-wrapper` consumption):

- `claude-tui` → add `0.2.1`. Description unchanged.
- `claude-status-items` → add `0.1.3`. Description unchanged.

New harness entry:

- `openai-compatible` → `0.1.0`, `path: harnesses/openai-compatible.json`. Categories: `["harness", "llm", "openai"]`. Description: "OpenAI-compatible LLM harness: chat against any OpenAI-compatible endpoint (LM Studio, Ollama, vLLM, etc.)."

## User setup flow

The README and the `openai-llm` plugin README together must walk a new user from zero to a working chat. The end-to-end story:

1. **Run a local OpenAI-compatible server.** Recommended: LM Studio. Alternatives: Ollama (with the OpenAI compat shim), vLLM, llama.cpp's `server`, or any hosted endpoint that speaks the OpenAI Chat Completions API. The user starts the server, loads a model, and notes the base URL (LM Studio default: `http://localhost:1234/v1`) and the model id (e.g. `qwen/qwen3-8b`).
2. **Configure the `openai-llm` plugin.** Per Spec 1, configuration lives in `~/.config/kaizen/plugins/openai-llm.json` (or kaizen's standard plugin-config location). Required fields: `baseUrl`, `model`. Optional: `apiKey` (defaults to `OPENAI_API_KEY` env var; `lm-studio` accepts any non-empty string), `temperature`, `maxTokens`. The plugin's README owns the schema and examples.
3. **Run kaizen with the harness.**

   ```sh
   kaizen --harness official/openai-compatible@0.1.0
   ```

   Or from a local checkout:

   ```sh
   kaizen --harness ./harnesses/openai-compatible.json
   ```

4. **Chat.** The kaizen TUI renders the rounded prompt box, status bar shows `cwd` + `git.branch`. User types, presses enter, sees streamed tokens. `Ctrl-C` cancels the in-flight turn (via `turn:cancel`). `/exit` ends the session, `/clear` re-renders.

The README must call out: no Anthropic-specific auth required, no `claude` binary on PATH. The only external dep is the OpenAI-compatible server.

## README updates

Update `/Users/chancock/git/kaizen-official-plugins/README.md`:

- Plugins section: add bullets for `llm-events`, `openai-llm`, `llm-driver`. Note that `claude-tui` and `claude-status-items` are now shared between harnesses.
- Harnesses section: add `openai-compatible` bullet alongside `claude-wrapper`. One-line description plus the `kaizen --harness` invocation.
- Add a short "Choosing a harness" subsection: `claude-wrapper` for users with a Claude Code login; `openai-compatible` for everyone else (local LLMs, third-party providers).
- Layout block: add `plugins/llm-events`, `plugins/openai-llm`, `plugins/llm-driver`, and `harnesses/openai-compatible.json`.

The `openai-llm` plugin README owns the configuration schema. The harness-level README only links to it.

## Validation

Per repo convention (`README.md` step 3 of "Contributing a plugin"):

- `kaizen plugin validate plugins/llm-events`
- `kaizen plugin validate plugins/openai-llm`
- `kaizen plugin validate plugins/llm-driver`
- `kaizen plugin validate plugins/claude-tui` (after the metadata bump)
- `kaizen plugin validate plugins/claude-status-items` (after the metadata bump)

Plus harness-level validation: `kaizen harness validate harnesses/openai-compatible.json` (resolves all plugin@version refs against the marketplace catalog and confirms the dependency graph is satisfiable).

Repo-level: `bun install && bun test` must pass for every plugin in `plugins/`.

## Test plan: A-tier smoke test

Manual end-to-end against LM Studio (the canonical reference server):

1. Start LM Studio, load any small chat model (e.g. Qwen3-4B-Instruct), enable the local server on `:1234`.
2. Write `~/.config/kaizen/plugins/openai-llm.json` with `baseUrl: "http://localhost:1234/v1"` and `model: "<loaded-model-id>"`.
3. From a checkout: `kaizen --harness ./harnesses/openai-compatible.json`.
4. Verify the TUI renders: rounded prompt box, status bar with `cwd` and `git.branch`.
5. Type `hi`, press enter. Expect streamed tokens to appear in the output area.
6. While a longer response is generating, press `Ctrl-C`. Expect the stream to halt promptly and the prompt to return; verify a `turn:end` with `reason: "cancelled"` was emitted (visible via a debug subscriber if added, or in logs).
7. Type a follow-up referencing the prior turn (e.g. "what did I just say?"). Expect the model to have the prior user/assistant pair in context.
8. `/clear` — terminal redraws cleanly.
9. `/exit` — session ends; verify `session:end` emitted.

Automated: each new plugin's own unit tests cover its piece (Spec 0/1/2 acceptance criteria). A harness-level integration test is *not* required at A-tier; the manual smoke test above is the gate. A scripted version using a stub HTTP server that speaks Chat Completions is a stretch goal, owned by the `openai-llm` spec.

## C-tier dispatch-strategy choice (forward reference only)

Mentioned for context; not implemented here. At C-tier the harness file pins exactly one of `llm-native-dispatch` or `llm-codemode-dispatch`. Per Spec 0, default is code-mode for local-LLM reliability. If we want runtime selection, it requires a kaizen feature (harness profiles or per-plugin config gating) that does not exist today. Until then, switching strategies = forking the harness file. The C-tier spec must address this explicitly.

## Acceptance criteria for A-tier

- `harnesses/openai-compatible.json` exists, lists the five plugins at the versions above, and validates with `kaizen harness validate`.
- `.kaizen/marketplace.json` contains entries for `llm-events`, `openai-llm`, `llm-driver`, the bumped `claude-tui` and `claude-status-items`, and the `openai-compatible` harness — all matching the format of existing entries.
- `claude-tui@0.2.1` and `claude-status-items@0.1.3` work unchanged under both `claude-wrapper` (with `claude-events:vocabulary`) and `openai-compatible` (with `llm-events:vocabulary`). Existing `claude-wrapper@0.1.0` continues to work because it pins the older versions.
- README documents both harnesses, the choice between them, and the `openai-llm` configuration entry point.
- The smoke test above passes against LM Studio: user types "hi", gets a streamed response, can cancel, can clear, can exit.
- Lifecycle events fire as defined in Spec 0: `session:start`, `input:submit`, `turn:start`, `llm:before-call`, `llm:token` (multiple), `llm:done`, `turn:end`, `session:end`.
- `claude-wrapper` regression: running `kaizen --harness official/claude-wrapper@0.1.0` still works end-to-end.

## Open questions for downstream specs

- **B-tier harness shape.** Add `llm-tools-registry` + `llm-local-tools` + a single dispatch strategy. Does B-tier pick native or code-mode as default? (Spec 0 commits C-tier to code-mode by default; B-tier is unspecified — recommend native for B-tier as a stepping stone, since local-tools work better with structured tool calls during early integration.)
- **Plugin config UX.** The user has to hand-edit `~/.config/kaizen/plugins/openai-llm.json`. Owned by Spec 1, but a follow-up could add a `kaizen config` subcommand or a first-run wizard. Out of scope here.
- **Harness profiles / runtime strategy selection.** Needed before C-tier can offer "switch native ↔ code-mode without forking". May require a kaizen core change. Track separately.
- **Provider plugins beyond OpenAI-compatible.** Anthropic-direct, Bedrock, Vertex, Ollama-native. Each is a new `*-llm` plugin satisfying `llm:complete`; the harness file gains a variant or a config switch. Defer until there is demand.
- **Telemetry / observability hooks.** A-tier emits the events but ships no default subscriber for usage tracking. A future `llm-telemetry` plugin could consume `llm:done` and aggregate token usage. Track separately.
