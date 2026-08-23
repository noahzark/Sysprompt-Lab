# `@sysprompt-lab/cli`

Published bins `sysprompt` and `spl`, plus library commands (`ingest`, `bind`, `export`, `promoteVersion`).

## Purpose

User-facing entry. The repo root re-exports the same bins so `npm run sysprompt` still works from the workspace root.

## Public surface

Commands (also exported for `import { ingest } from "sysprompt-lab"`):

| Command | Role |
|---|---|
| `ingest` | `system.md` (+ optional `tools.json`) → draft Prompt Card |
| `bind` | Attach a suite; status `bound` |
| `export` | `card.json` + `system.promoted.md` |
| `promote` | Human accept (does not re-run the gate) |
| `run --rung R0\|R1\|R2` | Optimize (forwards patch-mode and R1/R2 flags) |
| `validate` | Card JSON or suite YAML/JSON |

Patch-mode flags (`--rewrite-mode`, `--max-patch-ratio`, `--allow-full-rewrite` / `--no-allow-full-rewrite`) and student-eval flags (`--temperature`, `--max-tokens`) are parsed here and passed through. Do not drop them.

```ts
import { ingest, bind, exportCard, promoteVersion } from "@sysprompt-lab/cli";
```

Dev: `npx tsx packages/cli/src/cli.ts` or `npm run sysprompt` from the repo root.

## Dependencies

`commander`, `@sysprompt-lab/core`, `@sysprompt-lab/llm`, `@sysprompt-lab/rewrite`, `@sysprompt-lab/rungs`.

## Must not live here

- Scoring, patch apply, or GEPA spawn implementations — call the domain packages
- A second copy of schemas or the Python sidecar
- Hidden “utils” that other packages need (put those in `core` / `eval` / `rewrite`)
