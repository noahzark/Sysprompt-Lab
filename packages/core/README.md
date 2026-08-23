# `@sysprompt-lab/core`

Prompt Card / eval-suite **types**, Zod parsers, `.spl` workspace I/O, and prompt-diff helpers.

## Purpose

This is the data plane. Every other TypeScript package depends on it. JSON Schema files at repo-root `schemas/` are the published contract; Zod here is the runtime source and can re-emit those files.

## Public surface

- Schemas and parsers: `parseCard`, `parseSuite`, `normalizeSuite`, `namedSchemas`, …
- Version helpers: `baselineVersion`, `exportVersion`
- Workspace: `openWorkspace`, `loadCard`, `writeCard`, `writeSuite`, `writeRun`, `findRepoRoot`
- `unifiedPromptDiff` — unified diff of two system prompts
- `emitSchemas` / `jsonSchemaFor` — draft-07 emit used by `npm run emit-schemas`

```ts
import { loadCard, openWorkspace, parseSuite } from "@sysprompt-lab/core";
```

## Dependencies

`zod`, `yaml`, `diff`. Depends on **no** other `@sysprompt-lab/*` package.

## Must not live here

- LLM HTTP or `.env` loading (`@sysprompt-lab/llm`)
- Scoring, splits execution, promote **decisions** (`@sysprompt-lab/eval`)
- Rewrite / patch apply (`@sysprompt-lab/rewrite`)
- R0/R1/R2 loops or GEPA spawn (`@sysprompt-lab/rungs`)
- Commander / bins (`@sysprompt-lab/cli`)
- A second copy of `schemas/` — keep JSON Schema at the repo root
