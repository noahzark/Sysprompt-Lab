# Phased plan

Sysprompt Lab is a cross-model system-prompt workbench. The core unit is a **Prompt Card**, not a chat.

Flow: ingest an existing system prompt → optimize → execute on chosen models → verify on the **same** evals → promote only if better.

## Three rungs

| Rung | When | What |
|---|---|---|
| **R0** | No dataset | Meta-prompt rewrite, emit a diff, human accepts |
| **R1** | Literal system prompt + eval suite | Baseline → failure evidence → few candidates → swap only if score rises |
| **R2** | Task schema + feedback metric + examples | Wrap `gepa` / `dspy.GEPA` for train / rewrite / verify / select |

All three rungs share one acceptance gate: execute → verify on the same metric (including hold-out) → quality / cost / latency → promote only if better.

Do not reimplement GEPA. Do not fork AGPL code.

## Phase 0 — Data model and offline CLI

Ship the contracts and a round-trip that needs no network:

- JSON schemas (and Zod parsers) for PromptCard, PromptVersion, ToolSpec, Model, EvalSuite, EvalCase, Metric, Split, Run, Candidate, Score
- Library load/validate of Card + Suite from disk
- CLI: `ingest`, `bind`, `export` (and `validate`)
- Example `examples/support-bot/`
- Tests for schema validation and ingest → bind → export

## Phase 1 — R0 rewrite

Meta-prompt rewrite of the baseline, unified diff, same-suite eval, promote only if val improves.

- OpenAI-compatible client: `POST {LLM_API_BASE}/v1/chat/completions` (`/v1` appended when missing)
- `run --rung R0` rewrites the system prompt, writes `.spl/runs/<id>/r0.diff`, scores train (and val if present)
- Auto-promote only when val mean quality strictly rises; train-only suites refuse auto-promote
- `--dry-run` keeps the Phase 0 stub (no network); `--no-eval` rewrites only
- Human accept: `promote <card> [version]` then `export`

## Phase 2 — R1 eval-loop and R2 wrap GEPA

- R1: bind a suite, score the baseline, propose a few candidates from failure evidence, promote only if val is better
- R2: wrap an existing GEPA implementation behind the same Card / Suite / Run types

R1 and R2 are out of scope until Phase 0 is solid and the R0 stub is real.
