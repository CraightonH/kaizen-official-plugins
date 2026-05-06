1. Bug fix: If the TUI is streaming thinking, the user cannot scroll up in the terminal because their scroll bar always gets pulled down back to the bottom, presumably because TUI is redrawing the screen
2. Investigation: Sometimes an LLM chooses to attempt tool calls with:
```json
[some json object]
```
which then just outputs to the terminal, not run as a tool. Is this a tool call code problem or an LLM system prompt issue?
3. Word wrapping doesn't work in input box. When wrapping, we lose cursor and formatting.
4. Cannot paste into input box. Paste inserts above box and is not submitted on Enter.
5. LLM is unable to distinguish between tool call responses and user responses. This causes confusion when asked to recall previous turns. Maybe need more metadata packaging tool calls?
