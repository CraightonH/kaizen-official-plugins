1. Cleanup tool call messages in TUI. Don't need full JSON object, just show the args - more human readable. *example* from claude code:
`Bash(cd ~/.kaizen/marketplaces/official/plugins/llm-session-manager@0.1.0 && bun -e 'import { makeStore } from "./store.ts";…)`
Don't treat that as gospel truth and implement exactly this, just use it as an example of the kind of content that could be included in tool messages.
