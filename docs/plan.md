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

## Layout

TypeScript is an npm workspace. Dependency direction is `cli → rungs → rewrite | eval | llm | core` (no cycles). JSON Schema stays at repo-root `schemas/`. The GEPA sidecar stays at `python/` and is invoked from `@sysprompt-lab/rungs` — do not bury Python inside a TS package.

| Path | Role |
|---|---|
| `packages/core` | Card / suite Zod types, `.spl` I/O, prompt diffs, schema emit |
| `packages/llm` | `LLM_API_*` env + OpenAI-compatible `chat/completions` |
| `packages/eval` | Suite run, scoring, train/val, adopt / promote **decisions** |
| `packages/rewrite` | Full rewrite + section/patch apply + R0/R1 meta-prompts |
| `packages/rungs` | R0 / R1 / R2 orchestration only (`r0.ts` / `r1.ts` / `r2.ts`) |
| `packages/cli` | `sysprompt` / `spl` bins, ingest / bind / export / promote / run / suite-viewer |
| `packages/suite-viewer` | Localhost WebUI to inspect / label a suite; optional read-only run overlay (no cloud, no image benches) |
| `python/` | `python -m sysprompt_gepa` sidecar (stdin/stdout JSON job) |
| `schemas/` | draft-07 sources of truth |
| `examples/` | Ingestable cards; `support-bot` must keep working |

See [AGENTS.md](../AGENTS.md) for durable conventions (promote gate, patch-mode defaults, env vars).

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
   - Rewriter returns JSON `{ candidates: [{ hypothesis, edits|diff }] }` on large prompts (patch mode), or `{ hypothesis, prompt }` full rewrites on tiny prompts / `--rewrite-mode full`. Preserve intent. Do not rewrite the entire prompt when patching.
   - Dedupe / drop unchanged; keep up to `--candidates`
   - Eval each candidate on train (and val if present)
   - Adopt if score rises: val must strictly rise when val exists (train is the tie-break); otherwise train must strictly rise
   - On adopt: update the seed, refresh failures, append history; increment pass-streak on consecutive adopt, else reset
   - Stop early if the rewriter returns no new candidates, pass-streak is reached, or budget is exhausted
4. After the loop: write scores; auto-promote only if final val (or train if no val) strictly beats the original baseline
5. Persist under `.spl/runs/<id>/`: `candidates.jsonl`, `scores.json`, `r1.diff` (baseline → best), optional `summary.md`

`--dry-run` writes fake candidates (tiny applied patches) without network. `--no-eval` rewrites once and skips the loop.

## Patch mode (R0 / R1)

Full-prompt rewrite degrades on multi-KB system prompts (truncation, dropped sections, noisy diffs). Default optimize path for large prompts is **patch mode**:

1. Split `system_prompt` into sections (markdown headings, `Rules:`-style headers, or blank-line blocks). Persist the map as `.spl/runs/<id>/sections.json`.
2. Ask the model for structured JSON `edits` (`replace_section` / `replace_range` / `insert_after_section` / `delete_section`) or a unified diff. Apply with `applyEdits` / `applyUnifiedDiff`.
3. Reject patches that apply 0 hunks, empty the prompt, or change more than `--max-patch-ratio` of characters (R0 default 0.8, R1 default 0.5).
4. One retry with the apply error; then fall back to a legacy full rewrite only if `--allow-full-rewrite` (default true on R0; false on R1 when the prompt is large / `patch`).
5. `--rewrite-mode patch|full|auto` (default `auto`): `patch` when length ≥ 1500 chars (`SYSPROMPT_PATCH_THRESHOLD`), else `full`.

R2 is unchanged: the GEPA sidecar still optimizes the whole instruction. Large-SP patch mode is R0/R1 only.

## Phase 3 — R2 wrap GEPA

Wrap the official GEPA stack behind the same Card / Suite / Run types. Do not reimplement Pareto / merge / reflective mutation. Do not fork AGPL code.

- User still works with a **literal system prompt** Card + EvalSuite (ingest-first). Internally, Card → one `system_prompt` component for `gepa.optimize`.
- TypeScript `@sysprompt-lab/rungs` (`r2.ts`) + CLI `--rung R2`: require bound card + train (prefer val), write a temp job dir, spawn `python -m sysprompt_gepa`, read `best_prompt` + scores + lineage, persist `.spl/runs/<id>/r2.diff`, `sidecar.json`, `scores.json`, `summary.md`.
- Python sidecar in `python/`: adapter maps suite cases → train/val; metric returns score + synthesized feedback (exact / custom contains). Calls `gepa.optimize`. Student = `LLM_API_MODEL`; optional `LLM_REFLECTION_MODEL` (same fallback).
- `--budget light|medium|heavy` (default light → 24 / 60 / 150 max metric calls) or a positive integer. `--dry-run` skips Python and writes a stub candidate. `--no-eval` skips auto-promote after the wrap.
- Auto-promote uses the same helper as R1: val must strictly beat the original baseline (train-only suites may promote if train rises).
- Never call R0/R1 "GEPA". Never log raw tokens.
- Tests mock the sidecar / use `--dry-run`. Live install: `pip install -r python/requirements.txt` (needs network for `gepa`).
