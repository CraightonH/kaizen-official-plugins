1. Investigation: Sometimes an LLM chooses to attempt tool calls with:
```json
[some json object]
```
which then just outputs to the terminal, not run as a tool. Is this a tool call code problem or an LLM system prompt issue?
2. LLM is unable to distinguish between tool call responses and user responses. This causes confusion when asked to recall previous turns. Maybe need more metadata packaging tool calls?
