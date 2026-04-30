# OpenAI-Compatible Harness (A-tier) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the A-tier `openai-compatible` harness — the harness JSON file, marketplace catalog entries, and README updates — so a user can run `kaizen --harness official/openai-compatible@0.1.0` and chat against any OpenAI-compatible server (LM Studio, Ollama, vLLM, etc.) end-to-end with streaming, lifecycle events, and cancellation.

**Architecture:** This plan is integration-and-glue only. It assumes Specs 0/1/2/13 plugins (`llm-events`, `openai-llm`, `llm-driver`, `llm-tui`) are already published in `plugins/` at `0.1.0` per their own plans. We add `harnesses/openai-compatible.json` listing those four plugins, register them and the harness in `.kaizen/marketplace.json`, update top-level `README.md`, then validate and run an end-to-end smoke test against LM Studio.

**Tech Stack:** JSON (harness file + marketplace), Markdown (README), Bun (validation), `kaizen` CLI (harness/plugin validate, run).

---

## Prerequisites

Before starting Task 1, confirm the following are true. If any check fails, stop and finish the upstream plan first.

- `plugins/llm-events/` exists and contains a valid `package.json` at version `0.1.0`. Already shipped per commit `d5a97bd`.
- `plugins/openai-llm/` exists and contains a valid `package.json` at version `0.1.0`. Already shipped per commit `d5a97bd`.
- `plugins/llm-driver/` exists and contains a valid `package.json` at version `0.1.0`. **Owned by Spec 2's plan; must merge before this plan runs.**
- `plugins/llm-tui/` exists and contains a valid `package.json` at version `0.1.0`. **Owned by Spec 13's plan; must merge before this plan runs.**
- `kaizen` CLI is on `$PATH` and `kaizen --version` reports `0.3+`.
- `bun --version` reports `1.x`.
- LM Studio (or another OpenAI-compatible server) is installable on the developer's workstation for the smoke test (Task 7).

Verification command:

```sh
test -f plugins/llm-events/package.json && \
test -f plugins/openai-llm/package.json && \
test -f plugins/llm-driver/package.json && \
test -f plugins/llm-tui/package.json && \
echo OK
```

Expected: `OK`

If `plugins/llm-driver` or `plugins/llm-tui` is missing, **stop**. Do not invent stubs. Their plans (`docs/superpowers/plans/2026-04-30-llm-driver.md`, `docs/superpowers/plans/2026-04-30-llm-tui.md`) are responsible for them.

---

## File Structure

This plan touches only three files; everything else is verification/smoke:

```
harnesses/
  openai-compatible.json      # NEW — A-tier harness, lists the 4 plugin@version refs

.kaizen/
  marketplace.json            # MODIFIED — add llm-driver + llm-tui plugin entries,
                              # add openai-compatible harness entry,
                              # sync llm-events + openai-llm entries to Spec 3 wording

README.md                     # MODIFIED — add llm-driver/llm-tui plugin bullets,
                              # add openai-compatible harness bullet,
                              # add "Choosing a harness" subsection,
                              # update Layout block
```

No plugin source code is created or modified by this plan.

---

## Task 1: Create the harness file

**Files:**
- Create: `harnesses/openai-compatible.json`

The harness file mirrors `harnesses/claude-wrapper.json`'s shape exactly: a single top-level `plugins` array of `name@version` strings. No conditionals, no profiles. Order is incidental — kaizen resolves load order from `services.consumes`.

- [ ] **Step 1: Read the reference file to confirm shape**

Run: `cat harnesses/claude-wrapper.json`

Expected output (verbatim):

```json
{
  "plugins": [
    "official/claude-events@0.1.1",
    "official/claude-tui@0.2.0",
    "official/claude-status-items@0.1.2",
    "official/claude-driver@0.1.2"
  ]
}
```

If the shape has drifted from this, stop and reconcile — the new file must match the same key/structure.

- [ ] **Step 2: Write `harnesses/openai-compatible.json`**

Create the file with exactly this content (single trailing newline):

```json
{
  "plugins": [
    "official/llm-events@0.1.0",
    "official/openai-llm@0.1.0",
    "official/llm-driver@0.1.0",
    "official/llm-tui@0.1.0"
  ]
}
```

- [ ] **Step 3: Validate the JSON parses**

Run:

```sh
bun -e "JSON.parse(require('node:fs').readFileSync('harnesses/openai-compatible.json','utf8'))"
```

Expected: exit code 0, no output, no error.

- [ ] **Step 4: Confirm exactly four plugin refs and all required versions present**

Run:

```sh
bun -e "const j=JSON.parse(require('node:fs').readFileSync('harnesses/openai-compatible.json','utf8')); if(j.plugins.length!==4)throw new Error('expected 4 plugins, got '+j.plugins.length); const want=['official/llm-events@0.1.0','official/openai-llm@0.1.0','official/llm-driver@0.1.0','official/llm-tui@0.1.0']; for(const w of want){if(!j.plugins.includes(w))throw new Error('missing: '+w);} console.log('OK');"
```

Expected: `OK`

- [ ] **Step 5: Commit**

```sh
git add harnesses/openai-compatible.json
git commit -m "feat(harness): add openai-compatible A-tier harness file"
```

---

## Task 2: Add `llm-driver` and `llm-tui` plugin entries to marketplace

**Files:**
- Modify: `.kaizen/marketplace.json`

The marketplace already has entries for `llm-events` and `openai-llm` (commit `d5a97bd`). This task adds the two new plugin entries that Specs 2 and 13 published. We do NOT touch the existing four `claude-*` entries.

- [ ] **Step 1: Re-read the current marketplace to confirm state**

Run: `cat .kaizen/marketplace.json`

Verify: the `entries` array contains entries with `name` of `claude-events`, `claude-tui`, `claude-status-items`, `claude-driver`, `llm-events`, `openai-llm`, and `claude-wrapper` (in that order). If `llm-driver` or `llm-tui` already appears, skip Step 2 for whichever exists; do NOT duplicate.

- [ ] **Step 2: Insert the two new plugin entries**

Insert immediately after the `openai-llm` entry and before the `claude-wrapper` harness entry. After the trailing comma of the `openai-llm` entry's closing `}`, add:

```jsonc
    {
      "kind": "plugin",
      "name": "llm-driver",
      "description": "Turn loop and conversation state. Provides `driver:run-conversation`.",
      "categories": ["driver", "llm"],
      "versions": [{ "version": "0.1.0", "source": { "type": "file", "path": "plugins/llm-driver" } }]
    },
    {
      "kind": "plugin",
      "name": "llm-tui",
      "description": "Generic LLM-chat TUI primitives: input, output, status bar, completion popup, theme.",
      "categories": ["tui", "llm"],
      "versions": [{ "version": "0.1.0", "source": { "type": "file", "path": "plugins/llm-tui" } }]
    },
```

- [ ] **Step 3: Validate the JSON parses**

Run:

```sh
bun -e "JSON.parse(require('node:fs').readFileSync('.kaizen/marketplace.json','utf8'))"
```

Expected: exit code 0, no output.

- [ ] **Step 4: Confirm both new entries are present**

Run:

```sh
bun -e "const j=JSON.parse(require('node:fs').readFileSync('.kaizen/marketplace.json','utf8')); const names=j.entries.filter(e=>e.kind==='plugin').map(e=>e.name); for(const n of ['llm-driver','llm-tui']){if(!names.includes(n))throw new Error('missing plugin entry: '+n);} console.log('OK');"
```

Expected: `OK`

- [ ] **Step 5: Commit**

```sh
git add .kaizen/marketplace.json
git commit -m "chore(marketplace): publish llm-driver@0.1.0 and llm-tui@0.1.0"
```

---

## Task 3: Sync existing `llm-events` and `openai-llm` entry text to Spec 3 wording

**Files:**
- Modify: `.kaizen/marketplace.json`

Spec 3 specifies exact text for the existing `llm-events` and `openai-llm` entries. The current entries (from commit `d5a97bd`) drift slightly. Sync them so the catalog matches the spec verbatim — this prevents marketplace-text churn when downstream readers pull the spec.

Spec 3 §"Marketplace catalog updates" requires:
- `llm-events` description: `"Event vocabulary and shared types for openai-compatible harnesses."` (current ends `"...for the openai-compatible harness."`)
- `openai-llm` description: `"OpenAI-compatible LLM provider. Provides \`llm:complete\`."` (current: `"OpenAI-compatible LLM provider plugin (llm:complete service)."`)
- `openai-llm` categories: `["llm", "openai"]` (current: `["llm", "provider"]`)

- [ ] **Step 1: Update the `llm-events` description**

In `.kaizen/marketplace.json`, locate the entry whose `"name"` is `"llm-events"`. Replace its `"description"` value with:

```
"Event vocabulary and shared types for openai-compatible harnesses."
```

- [ ] **Step 2: Update the `openai-llm` description and categories**

In `.kaizen/marketplace.json`, locate the entry whose `"name"` is `"openai-llm"`.

Replace its `"description"` value with:

```
"OpenAI-compatible LLM provider. Provides `llm:complete`."
```

Replace its `"categories"` value with:

```json
["llm", "openai"]
```

- [ ] **Step 3: Validate JSON**

Run:

```sh
bun -e "JSON.parse(require('node:fs').readFileSync('.kaizen/marketplace.json','utf8'))"
```

Expected: exit code 0.

- [ ] **Step 4: Confirm spec-matching text is present**

Run:

```sh
bun -e "const j=JSON.parse(require('node:fs').readFileSync('.kaizen/marketplace.json','utf8')); const e=j.entries.find(x=>x.name==='llm-events'); if(e.description!=='Event vocabulary and shared types for openai-compatible harnesses.')throw new Error('llm-events desc drift: '+e.description); const o=j.entries.find(x=>x.name==='openai-llm'); if(o.description!=='OpenAI-compatible LLM provider. Provides \`llm:complete\`.')throw new Error('openai-llm desc drift: '+o.description); if(JSON.stringify(o.categories)!==JSON.stringify(['llm','openai']))throw new Error('openai-llm cats drift: '+JSON.stringify(o.categories)); console.log('OK');"
```

Expected: `OK`

- [ ] **Step 5: Commit**

```sh
git add .kaizen/marketplace.json
git commit -m "chore(marketplace): sync llm-events/openai-llm entry text to Spec 3"
```

---

## Task 4: Add the `openai-compatible` harness entry to marketplace

**Files:**
- Modify: `.kaizen/marketplace.json`

Add the harness catalog entry that pins `harnesses/openai-compatible.json` at version `0.1.0`.

- [ ] **Step 1: Insert the harness entry**

In `.kaizen/marketplace.json`, locate the existing `claude-wrapper` harness entry (the last entry in `entries`). Add a comma after its closing `}` and append:

```jsonc
    {
      "kind": "harness",
      "name": "openai-compatible",
      "description": "OpenAI-compatible LLM harness: chat against any OpenAI-compatible endpoint (LM Studio, Ollama, vLLM, etc.).",
      "categories": ["harness", "llm", "openai"],
      "versions": [{ "version": "0.1.0", "path": "harnesses/openai-compatible.json" }]
    }
```

- [ ] **Step 2: Validate JSON**

Run:

```sh
bun -e "JSON.parse(require('node:fs').readFileSync('.kaizen/marketplace.json','utf8'))"
```

Expected: exit code 0.

- [ ] **Step 3: Confirm the harness entry is present and points at the file**

Run:

```sh
bun -e "const j=JSON.parse(require('node:fs').readFileSync('.kaizen/marketplace.json','utf8')); const h=j.entries.find(e=>e.kind==='harness' && e.name==='openai-compatible'); if(!h)throw new Error('openai-compatible harness entry missing'); if(h.versions[0].version!=='0.1.0')throw new Error('wrong version: '+h.versions[0].version); if(h.versions[0].path!=='harnesses/openai-compatible.json')throw new Error('wrong path: '+h.versions[0].path); console.log('OK');"
```

Expected: `OK`

- [ ] **Step 4: Confirm the file the entry points at exists**

Run: `test -f harnesses/openai-compatible.json && echo OK`

Expected: `OK`

- [ ] **Step 5: Commit**

```sh
git add .kaizen/marketplace.json
git commit -m "feat(marketplace): publish openai-compatible@0.1.0 harness"
```

---

## Task 5: Update top-level README

**Files:**
- Modify: `README.md`

Update the four sections specified in Spec 3 §"README updates": Plugins, Harnesses, add a "Choosing a harness" subsection, and the Layout block.

- [ ] **Step 1: Replace the Plugins section**

In `README.md`, locate the heading `## Plugins` and the four bullet lines below it (ending at the line before `## Harnesses`). Replace the entire bullet list (preserving the `## Plugins` heading) with:

```markdown
- **claude-events** — event vocabulary for the claude-wrapper harness.
- **claude-tui** — terminal UI: rounded "kaizen" prompt box + status bar. Provides `ui:channel`. Backs the `claude-wrapper` harness.
- **claude-status-items** — emits `cwd` and `git.branch` status items.
- **claude-driver** — session driver; wraps the local `claude` CLI in headless stream-json mode.
- **llm-events** — event vocabulary and shared types for openai-compatible harnesses.
- **openai-llm** — OpenAI-compatible LLM provider. Provides `llm:complete`. Configure at `~/.kaizen/plugins/openai-llm/config.json`; see the plugin's README for the schema.
- **llm-driver** — turn loop and conversation state for openai-compatible harnesses. Provides `driver:run-conversation`.
- **llm-tui** — generic LLM-chat TUI primitives (input, output, status bar, completion popup, theme). Distinct from `claude-tui`; backs the `openai-compatible` harness and any future LLM harnesses.
```

- [ ] **Step 2: Replace the Harnesses section and add "Choosing a harness"**

Locate the `## Harnesses` heading. Replace it and the single bullet under it (up to but not including `## Usage`) with:

```markdown
## Harnesses

- **claude-wrapper** — Claude Code wrapper UI over `claude -p`. Requires the `claude` binary on `$PATH` and an authenticated Claude Code login (Pro/Max/Team/Enterprise OAuth, or API key).
- **openai-compatible** — chat with any OpenAI-compatible LLM endpoint (LM Studio, Ollama, vLLM, llama.cpp, hosted providers). No `claude` binary required. Configuration lives in `~/.kaizen/plugins/openai-llm/config.json`.

### Choosing a harness

- Use **claude-wrapper** if you have a Claude Code login and want the existing Claude UX over `claude -p`.
- Use **openai-compatible** for everything else: local LLMs (LM Studio, Ollama, vLLM) and any third-party OpenAI-compatible endpoint.

```

- [ ] **Step 3: Add an `openai-compatible` invocation example to Usage**

Locate the `## Usage` section. After the existing `claude-wrapper` invocation block (the one that runs from a local checkout via `./harnesses/claude-wrapper.json`), append:

```markdown

For the OpenAI-compatible harness:

```sh
kaizen --harness official/openai-compatible@0.1.0
```

Or run from a local checkout:

```sh
kaizen --harness ./harnesses/openai-compatible.json
```
```

- [ ] **Step 4: Update the Layout block**

Locate the fenced code block under `## Layout`. Replace its contents with:

```
.
├── .kaizen/
│   └── marketplace.json      # catalog: plugin + harness entries
├── plugins/
│   ├── claude-events/
│   ├── claude-tui/
│   ├── claude-status-items/
│   ├── claude-driver/
│   ├── llm-events/
│   ├── openai-llm/
│   ├── llm-driver/
│   └── llm-tui/
└── harnesses/
    ├── claude-wrapper.json
    └── openai-compatible.json
```

- [ ] **Step 5: Render-check the README**

Run:

```sh
grep -nE '^(## |### )' README.md
```

Expected (in order): `## Plugins`, `## Harnesses`, `### Choosing a harness`, `## Usage`, `## Layout`, `## Development`, `## Contributing a plugin`, `## Standards`. No duplicate or missing headings.

Run:

```sh
grep -c 'openai-compatible' README.md
```

Expected: `>= 4` (Plugins reference, Harnesses bullet, Choosing-a-harness bullet, Usage block — Layout file ref).

- [ ] **Step 6: Commit**

```sh
git add README.md
git commit -m "docs: document openai-compatible harness and llm-* plugins"
```

---

## Task 6: Plugin and harness validation

**Files:** none modified.

Run the kaizen CLI validators specified in Spec 3 §"Validation". This is the automated gate before the manual smoke test.

- [ ] **Step 1: Validate each plugin in the harness**

Run each, separately, so failures are easy to attribute:

```sh
kaizen plugin validate plugins/llm-events
kaizen plugin validate plugins/openai-llm
kaizen plugin validate plugins/llm-driver
kaizen plugin validate plugins/llm-tui
```

Expected: each command exits 0 and prints a success line (exact wording is `kaizen` version-dependent; treat anything containing `valid` or `OK` and exit code 0 as pass).

If any plugin fails to validate, stop. The fix belongs to that plugin's plan, not this one.

- [ ] **Step 2: Validate the harness file**

Run:

```sh
kaizen harness validate harnesses/openai-compatible.json
```

Expected: exit 0. The validator MUST resolve all four `name@version` refs against `.kaizen/marketplace.json` and confirm the dependency graph is satisfiable (every consumed service has a provider).

If validation fails with "unknown plugin", verify Tasks 2–4 were committed. If it fails with "service X has no provider", verify Spec 0/1/2/13 plans completed — a missing service is an upstream bug.

- [ ] **Step 3: Run the repo-wide test sweep**

Run:

```sh
bun install && bun test
```

Expected: every plugin's unit tests pass. No new tests are added by this plan; this re-runs the existing suites to catch any regression a service-name typo in the harness could surface.

- [ ] **Step 4: `claude-wrapper` regression check**

Spec 3 §"Acceptance criteria" requires that `claude-wrapper` continues to work end-to-end. Run the harness validator on it:

```sh
kaizen harness validate harnesses/claude-wrapper.json
```

Expected: exit 0. (We do not run an interactive Claude session here — that would require a Claude login. The validator confirms the marketplace entry edits in Tasks 2–4 did not break the existing harness's plugin graph.)

---

## Task 7: A-tier smoke test against LM Studio (acceptance)

**Files:** none modified. This is the acceptance gate — the run that proves the integration works end-to-end.

Pre-conditions:
- LM Studio is installed locally (alternative: Ollama with the OpenAI compat shim, vLLM, or `llama.cpp`'s `server`).
- A small instruction-tuned chat model is available locally (e.g. `Qwen3-4B-Instruct`, `Llama-3.2-3B-Instruct`, or any model ≤ 8B that comfortably fits the developer's RAM).

The exact ID strings shown below assume LM Studio defaults; substitute as appropriate for your loader.

- [ ] **Step 1: Start the LM Studio server**

In LM Studio: load the chosen model in the chat tab once to confirm it generates output. Then open the **Local Server** tab, verify the port is `1234` (the default), and click **Start Server**.

Confirm reachability from the shell:

```sh
curl -sS http://localhost:1234/v1/models | bun -e "let buf=''; process.stdin.on('data',c=>buf+=c); process.stdin.on('end',()=>{const j=JSON.parse(buf); if(!Array.isArray(j.data)||j.data.length<1)throw new Error('no models loaded'); console.log('model id:',j.data[0].id);});"
```

Expected output (model id will vary):

```
model id: qwen/qwen3-8b
```

Note the printed model id — you will paste it into the config file in the next step.

- [ ] **Step 2: Write the `openai-llm` config file**

Create the per-user config directory and config (substitute the model id you saw in Step 1):

```sh
mkdir -p ~/.kaizen/plugins/openai-llm
cat > ~/.kaizen/plugins/openai-llm/config.json <<'JSON'
{
  "baseUrl": "http://localhost:1234/v1",
  "model": "qwen/qwen3-8b",
  "apiKey": "lm-studio"
}
JSON
```

Expected: file exists at `~/.kaizen/plugins/openai-llm/config.json`. Verify:

```sh
cat ~/.kaizen/plugins/openai-llm/config.json
```

If your model id differs from `qwen/qwen3-8b`, edit the file and replace the value of `"model"` before continuing.

- [ ] **Step 3: Launch kaizen with the local harness file**

From the repo root:

```sh
kaizen --harness ./harnesses/openai-compatible.json
```

Expected: a TUI takes over the terminal. The screen shows:
- A rounded prompt box at the bottom (provided by `llm-tui`).
- A status bar showing `cwd` (the current directory) and `git.branch` (the active branch — `main` for a fresh checkout).
- An empty output pane above the prompt.

If the TUI does not render or the process exits immediately, capture stderr:

```sh
kaizen --harness ./harnesses/openai-compatible.json 2>/tmp/kaizen-aterr.log; cat /tmp/kaizen-aterr.log
```

Common failures and where they belong:
- `service not found: llm:complete` → upstream openai-llm bug.
- `service not found: ui:channel` or similar TUI service → upstream llm-tui bug.
- `cannot read config` → fix the path or JSON in Step 2; not a plugin bug.
- `ECONNREFUSED 127.0.0.1:1234` → LM Studio server is not running; redo Step 1.

- [ ] **Step 4: Send a one-token prompt and confirm streaming**

In the TUI prompt, type:

```
hi
```

Press `Enter`.

Expected:
- Tokens appear in the output pane progressively (not all at once after a long wait). Streaming is visible.
- A short greeting completes within a few seconds.
- The prompt returns ready for input.

Per Spec 0 vocabulary, the following events fire (visible only with a debug subscriber, not normally rendered): `input:submit`, `turn:start`, `llm:before-call`, `llm:request`, multiple `llm:token`, `llm:done`, `turn:end`. You do NOT need to confirm each event individually for this gate — visible streaming + completion is the acceptance signal.

- [ ] **Step 5: Cancellation test**

Type a prompt that elicits a long answer:

```
Write a 500-word explanation of how TCP congestion control works.
```

Press `Enter`. Wait until tokens are actively streaming, then press `Ctrl-C`.

Expected:
- Token streaming halts within ~1 second.
- The prompt returns ready for input (the session does NOT exit).
- No traceback or error banner is displayed.

If `Ctrl-C` exits the entire TUI instead of cancelling the turn, that is an upstream bug in `llm-driver` or `llm-tui`'s signal handling — file against the relevant plugin, not this plan.

- [ ] **Step 6: Conversation memory test**

Type:

```
my favorite color is octarine. remember this.
```

Press `Enter`, wait for response.

Then type:

```
what is my favorite color?
```

Press `Enter`.

Expected: the model responds with `octarine` (or quotes the prior message). This proves the driver's conversation state correctly carries the prior user/assistant pair into the second LLM call.

- [ ] **Step 7: `/clear` and `/exit`**

Type `/clear` and press `Enter`.

Expected: the output pane is cleared; the TUI redraws cleanly; the prompt returns.

Type `/exit` and press `Enter`.

Expected: the TUI exits cleanly back to the shell. Exit code is 0:

```sh
echo $?
```

Expected: `0`

- [ ] **Step 8: Sign-off**

If Steps 1–7 all produced their expected outputs, the A-tier acceptance criteria from Spec 3 are satisfied:
- Streaming chat works end-to-end (Step 4).
- Cancellation works (Step 5).
- Conversation state persists across turns (Step 6).
- `/clear` and `/exit` work (Step 7).
- `claude-wrapper` regression validated (Task 6 Step 4).

No commit for this task — it is a gate, not a code change.

---

## Spec coverage summary

| Spec section | Task |
|---|---|
| Plugin roster (4 plugins at 0.1.0) | Tasks 1, 2 |
| Harness file `harnesses/openai-compatible.json` | Task 1 |
| Single-harness-file decision (one file at 0.1.0) | Task 1 |
| Marketplace entries — `llm-driver` + `llm-tui` plugins | Task 2 |
| Marketplace entries — sync existing `llm-events` + `openai-llm` text | Task 3 |
| Marketplace entry — `openai-compatible` harness | Task 4 |
| User setup flow (config + invocation) | Tasks 5, 7 |
| README updates (Plugins, Harnesses, Choosing-a-harness, Usage, Layout) | Task 5 |
| Validation (`kaizen plugin validate`, `kaizen harness validate`) | Task 6 |
| Repo-level `bun install && bun test` | Task 6 |
| Smoke test against LM Studio (full Spec 3 test plan) | Task 7 |
| `claude-wrapper` regression | Task 6 Step 4 |
| Lifecycle events fire end-to-end | Task 7 Step 4 |

## Risks and out-of-scope

- **Upstream plugin readiness.** This plan can only succeed if Specs 1, 2, 13 are fully implemented and at version `0.1.0`. The Prerequisites gate catches this; do not stub-fill missing plugins.
- **Plugin config UX.** Hand-editing `~/.kaizen/plugins/openai-llm/config.json` is the only supported flow at A-tier (Spec 3 §"Open questions"). A `kaizen config` subcommand or first-run wizard is deferred.
- **Provider plugins beyond OpenAI-compatible.** Anthropic-direct, Bedrock, Vertex, Ollama-native are deferred. Each is a future `*-llm` plugin satisfying `llm:complete`.
- **Dispatch-strategy choice.** A-tier has no tools, so no dispatch strategy. C-tier will pin one; runtime selection is a future kaizen-core feature.
- **Telemetry / observability.** Events fire but no default subscriber aggregates them. A future `llm-telemetry` plugin can consume `llm:done`.
