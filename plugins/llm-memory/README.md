# llm-memory

File-backed persistent memory for the openai-compatible harness. Reads/writes
Claude-Code-compatible markdown memories under `<project>/.kaizen/memory/` and
`~/.kaizen/memory/`, injects the merged `MEMORY.md` blocks into every LLM
request via `llm:before-call`, and exposes a `memory:store` service plus the
`memory_recall` and `memory_save` tools.

Add `.kaizen/memory/` to your project's `.gitignore` if you do not want
project memory committed. Auto-extraction is OFF by default — see the
`autoExtract` setting and the privacy notes below before enabling.
