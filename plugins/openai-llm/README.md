# openai-llm

OpenAI-compatible LLM provider plugin. Provides the `llm:complete` service
backed by any OpenAI-compatible HTTP endpoint (OpenAI, LM Studio, vLLM, Ollama,
etc.) with streaming SSE parsing, tool-call accumulation, retry, and abort
handling. Reads its config from `~/.kaizen/plugins/openai-llm/config.json`.
