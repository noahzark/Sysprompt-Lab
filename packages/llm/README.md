# `@sysprompt-lab/llm`

OpenAI-compatible client and `LLM_API_*` environment loading.

## Purpose

One place for “talk to a chat/completions server” and “read the three required env vars.” Tokens are masked in logs and never written to artifacts.

## Public surface

- `loadEnvFiles`, `getLlmConfig`, `readLlmConfig`, `formatLlmTarget`, `maskToken`, `peekRootFlag`
- `chatCompletion`, `normalizeLlmApiBase`, `chatCompletionsUrl`

```ts
import { chatCompletion, getLlmConfig } from "@sysprompt-lab/llm";
```

`POST {base}/v1/chat/completions` — `/v1` is appended when the base has no `/v1` suffix.

## Dependencies

`dotenv`. No `@sysprompt-lab/*` dependencies (leaf package beside `core`).

## Must not live here

- Card / suite I/O or Zod entities (`@sysprompt-lab/core`)
- Metric scoring or promote gate (`@sysprompt-lab/eval`)
- Rewriter prompts or patch apply (`@sysprompt-lab/rewrite`)
- Rung orchestration or Python sidecar (`@sysprompt-lab/rungs`)
- CLI commands (`@sysprompt-lab/cli`)
