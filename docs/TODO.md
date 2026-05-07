1. Update thinking message -> `* Honking… (2m 0s · ↓ 856 tokens)`

## Recently completed

- **codemode tool-pivot** — replaced `llm-codemode-dispatch` (prose-fence) with `llm-codemode` plugin registering `execute_typescript` as a normal OpenAI tool; results round-trip via standard `tool` role messages through `llm-native-dispatch`. Closes the prior TODO #2 (LLM emitting tool-call JSON to terminal instead of executing). Smoke test results: all four checks (3a–3d) passed via Esc-cancel. Tested 2026-05-07 against local LM Studio.
