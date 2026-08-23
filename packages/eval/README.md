# `@sysprompt-lab/eval`

Run a suite, score cases, handle train/val splits, and decide adopt / auto-promote.

## Purpose

Same-metric verify. Optimization packages propose a new `system_prompt`; this package scores it and answers “is it strictly better?”

## Public surface

- Execution: `evaluatePrompt`, `casesForSplit`, `scoreCase`, `caseUserText`, `caseUserContent`
- Vision cases: `input.image` / `input.image_path` → multimodal user content (`text` + `image_url` data URL). Paths resolve relative to the suite file, `card.source`, or `SYSPROMPT_IMAGE_DIR`.
- Custom metric `id: nsfw_severity_tag` (kind `custom`): parse JSON `tags[]`, exact-match the single NSFW severity label.
- Aggregation: `mean`, `aggregateScore`, `formatScoreTable`
- Gate: `promotionDecision` (R0), `adoptDecision` (R1 mid-loop), `r1PromotionDecision` (R1/R2 end-of-loop)

**Contract:** auto-promote only when **val** mean quality strictly improves (see root `AGENTS.md`). Train-only R0 never auto-promotes. R1/R2 may promote a train-only suite when train strictly rises.

```ts
import { evaluatePrompt, promotionDecision } from "@sysprompt-lab/eval";
```

## Dependencies

`@sysprompt-lab/core`, `@sysprompt-lab/llm`.

## Must not live here

- Rewrite meta-prompts or `applyPromptPatch` (`@sysprompt-lab/rewrite`)
- Workspace writes / run artifact layout (callers in `rungs` / `cli` use `core`)
- GEPA / Python (`python/` + `@sysprompt-lab/rungs`)
- Commander flags (`@sysprompt-lab/cli`)
- Human `promote <card>` (that is a CLI command; this package only **decides**)
