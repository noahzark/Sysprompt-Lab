# `@sysprompt-lab/rewrite`

Full-prompt rewrite, section split / structured patch apply, and the meta-prompts shared by R0 and R1.

## Purpose

Turn model output into a new `system_prompt` without owning the optimize loop. Large prompts default to **patch mode** (JSON `edits` or a unified diff). Tiny prompts still get a full rewrite.

Defaults (overridable): `auto` → patch when length ≥ 1500 chars; R0 max patch ratio `0.8`; R1 `0.5`; R0 may fall back to a full rewrite, R1 on large/`patch` prompts does not.

## Public surface

- R0-style: `rewriteSystemPrompt`, `parseRewriteResponse`, `parsePatchResponse`
- Patch engine: `splitSections`, `applyEdits`, `applyUnifiedDiff`, `applyPromptPatch`, `dryRunPatch`, `parseRewriteMode`
- R1 proposals: `proposeR1Candidates`, `parseR1Candidates`, `parseR1RawCandidates`, `materializeR1Proposals`, `dedupeProposals`

```ts
import { rewriteSystemPrompt, applyPromptPatch } from "@sysprompt-lab/rewrite";
```

## Dependencies

`@sysprompt-lab/core`, `@sysprompt-lab/llm`. Does **not** depend on `eval` or `rungs`.

## Must not live here

- Train/val scoring or promote/adopt **decisions** (`@sysprompt-lab/eval`)
- R1 evidence pack assembly / search history (`@sysprompt-lab/rungs`)
- `.spl` run directories, GEPA spawn, CLI flags
- R2 / whole-instruction GEPA — patch mode is R0/R1 only
