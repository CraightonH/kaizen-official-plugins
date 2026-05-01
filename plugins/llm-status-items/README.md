# llm-status-items

Optional status-bar plugin for the openai-compatible harness. Surfaces four
items: `model`, `tokens`, `turn-state`, and (if a rate table is provided)
`cost-estimate`.

## Do you want this?

Add it if you want at-a-glance visibility into which model is in use, how many
tokens have been spent this session, and whether the agent is thinking, calling
a tool, or idle. Skip it if you prefer a quiet status bar — none of the events
or services in this plugin affect chat, tools, agents, or memory.

## Configuration

Drop a `~/.kaizen/plugins/llm-status-items/cost-table.json` file to enable cost:

```json
{
  "rates": {
    "gpt-4.1-mini": { "promptCentsPerMTok": 15,  "completionCentsPerMTok": 60 },
    "gpt-4.1":      { "promptCentsPerMTok": 200, "completionCentsPerMTok": 800 }
  }
}
```

If a model is absent from the table, no `cost-estimate` is emitted (and any
prior value is cleared) — better than displaying a misleading `$0.0000`.
