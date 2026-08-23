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

## Phase 2 — R1 eval-loop

Promptfoo-sized honest loop on a literal system prompt. Configurable; defaults inspired by Promptfoo:

- `--rounds` default 3 (`SYSPROMPT_R1_ROUNDS`)
- `--candidates` default 3 (`SYSPROMPT_R1_CANDIDATES`)
- `--pass-streak` default 1 (stop after N consecutive adopts; 1 = normal)
- `--budget` default `rounds × candidates`

Steps:

1. Require card status bound + suite
2. Baseline eval on train (and val if present) with the current baseline + LLM from `.env`
3. For each round up to `--rounds`:
   - Build evidence: current prompt, up to ~6 train failures + ~3 successes (truncated / sanitized; no secrets), prior search history, hypotheses
   - Rewriter returns JSON `{ candidates: [{ hypothesis, prompt }] }` — full system-prompt rewrites, preserve intent
   - Dedupe / drop unchanged; keep up to `--candidates`
   - Eval each candidate on train (and val if present)
   - Adopt if score rises: val must strictly rise when val exists (train is the tie-break); otherwise train must strictly rise
   - On adopt: update the seed, refresh failures, append history; increment pass-streak on consecutive adopt, else reset
   - Stop early if the rewriter returns no new candidates, pass-streak is reached, or budget is exhausted
4. After the loop: write scores; auto-promote only if final val (or train if no val) strictly beats the original baseline
5. Persist under `.spl/runs/<id>/`: `candidates.jsonl`, `scores.json`, `r1.diff` (baseline → best), optional `summary.md`

`--dry-run` writes fake candidates without network. `--no-eval` rewrites once and skips the loop. R0 is unchanged. R2 stays rejected.

## Phase 3 — R2 wrap GEPA

- Wrap an existing GEPA implementation behind the same Card / Suite / Run types
- Do not reimplement GEPA. Do not fork AGPL code.
