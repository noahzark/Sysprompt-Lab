# `@sysprompt-lab/rungs`

Thin R0 / R1 / R2 **orchestration**. Product rungs live here; algorithms live in `rewrite` / `eval` / `llm` / `core`.

## Purpose

Load a card, call the right optimizer, write run artifacts (`.spl/runs/<id>/`), and apply the promote gate. File names `r0.ts` / `r1.ts` / `r2.ts` are allowed **only** in this package.

## Public surface

- `runR0` — one rewrite or patch, optional before/after eval, R0 promote gate
- `runR1` / `resolveR1Config` — eval-loop; evidence helpers (`formatEvidence`, `selectEvidenceCases`, …)
- `runR2` / `resolveR2Budget` / `resolvePython` / `parseSidecarResult` — wrap `python -m sysprompt_gepa`

R2 TypeScript stays here. The sidecar stays at repo-root `python/` (JSON job in / JSON result out). Override the interpreter with `SYSPROMPT_PYTHON`. `--dry-run` must not spawn Python.

```ts
import { runR0, runR1, runR2 } from "@sysprompt-lab/rungs";
```

## Dependencies

`@sysprompt-lab/core`, `@sysprompt-lab/llm`, `@sysprompt-lab/eval`, `@sysprompt-lab/rewrite`.

## Must not live here

- Zod schema definitions or JSON Schema emit (`@sysprompt-lab/core`)
- Raw `chat/completions` client (`@sysprompt-lab/llm`)
- Patch apply / rewriter system prompts (`@sysprompt-lab/rewrite`)
- Commander program (`@sysprompt-lab/cli`)
- Python sources — do not bury `sysprompt_gepa` inside this package
