1. Bug fix: If the TUI is streaming thinking, the user cannot scroll up in the terminal because their scroll bar always gets pulled down back to the bottom, presumably because TUI is redrawing the screen
2. Investigation: Sometimes an LLM chooses to attempt tool calls with:
```json
[some json object]
```
which then just outputs to the terminal, not run as a tool. Is this a tool call code problem or an LLM system prompt issue?
3. Feature request: tui should pop up a list of available slash commands, with filtering as the user types, ie. `/` should show a list of all available slash commands registered, `/p` should filter to ones beginning with `p`, etc.
4. llm-session-manager: session manager that persists sessions to disk, becomes the source of sessions (instead of driver), and allows for the capability to hold multiple sessions at once so a "sub-agent" (unique message history) can be utilized by the driver. This will impact llm-agents as well - agent sessions will be managed by the new plugin.
5. Word wrapping doesn't work in input box. When wrapping, we lose cursor and formatting.
6. I can't use Option + arrow keys to navigate input box per word. Should also implement Command + arrow for line navigation.
7. Cannot paste into input box. Paste inserts above box and is not submitted on Enter.
8. LLM is unable to distinguish between tool call responses and user responses. This causes confusion when asked to recall previous turns. Maybe need more metadata packaging tool calls?
