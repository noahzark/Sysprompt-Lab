# Sysprompt Lab — agent conventions

Stable rules for humans and coding agents. This is not a changelog or sprint board.

## Product

Prompt Card in → R0 / R1 / R2 optimize → same-metric verify → promote-if-better.

The unit of work is a **Prompt Card** (literal `system_prompt` + versions + optional suite), not a chat. Ingest an existing prompt, optimize on a rung, execute on a chosen OpenAI-compatible model, score with the **same** eval suite, and promote only when quality strictly improves.

| Rung | When | What |
|---|---|---|
| **R0** | No dataset / one-shot | Meta-prompt rewrite or structured patch, unified diff, human accepts |
| **R1** | Literal prompt + eval suite | Baseline → failure evidence → few candidates → adopt only if score rises |
| **R2** | Same card + suite; needs Python | Wrap official `gepa.optimize` via the sidecar. Do not call R0/R1 “GEPA” |

Do not reimplement GEPA. Do not fork AGPL tools. Do not invent a second object model (no “first rewrite as DSPy modules”).

## Repo layout

```
/
  AGENTS.md                 # this file — durable conventions
  README.md                 # user-facing; points at packages
  package.json              # npm workspaces root + `sysprompt` / `spl` UX
  packages/
    core/                   # schemas, workspace I/O, versioning helpers
    llm/                    # OpenAI-compatible client + env loading
    eval/                   # run suite, score, splits, promote gate
    rewrite/                # full rewrite + patch split/apply + R0/R1 meta-prompts
    rungs/                  # R0 / R1 / R2 orchestration only
    cli/                    # `sysprompt` / `spl` bin and commands
  python/                   # GEPA sidecar (stdin/stdout JSON job). Not a TS package
  schemas/                  # JSON Schema (draft-07) sources of truth
  examples/                 # ingestable cards (support-bot must keep working)
  docs/                     # product plan, not package internals
```

Public TypeScript imports use package names (`@sysprompt-lab/core`, …). The root package `sysprompt-lab` re-exports the same surface so existing `import { … } from "sysprompt-lab"` keeps working.

JSON Schema files stay at repo-root `schemas/`. Zod sources live in `@sysprompt-lab/core` and re-emit those files (`npm run emit-schemas`). Do not add a second schema tree under a package.

## Package boundaries

Dependency direction (no cycles):

```
cli → rungs → rewrite
            → eval
            → llm
            → core
     rewrite → llm → (none)
             → core
     eval    → llm
             → core
```

| Package | Owns | Must not live here |
|---|---|---|
| `core` | Card/suite Zod types, parsers, `.spl` workspace I/O, prompt diffs, schema emit | LLM HTTP, scoring, rewrite prompts, CLI flags, GEPA spawn |
| `llm` | `.env` load, `LLM_API_*`, OpenAI-compatible `chat/completions` | Card I/O, eval metrics, rung loops, Commander |
| `eval` | Suite execution, case scoring, train/val splits, adopt/promote **decisions** | Rewriter meta-prompts, patch apply, Python sidecar, CLI |
| `rewrite` | Full rewrite + section split/patch apply + R0/R1 meta-prompts shared by both rungs | Rung loops, promote gate, workspace writes, GEPA |
| `rungs` | Thin R0 / R1 / R2 orchestration (job setup, artifact names, calling rewrite/eval/sidecar) | JSON Schema, raw HTTP client, Commander program |
| `cli` | `sysprompt` / `spl` bins, `ingest` / `bind` / `export` / `promote` / `run` / `validate` | Domain algorithms that other packages need |

Rungs are **product** names (R0, R1, R2). File and export names should be domain words (`eval`, `patch`, `promote`, `rewrite`) — not a pile of `r1.ts` at the repo root. Rung *orchestration* files may stay `r0.ts` / `r1.ts` / `r2.ts` **inside** `packages/rungs`.

## TypeScript ↔ Python sidecar

R2 TypeScript lives in `@sysprompt-lab/rungs`. The sidecar stays at repo-root `python/` (`python -m sysprompt_gepa`). Do not bury Python inside a TypeScript package.

Contract:

- Job dir on disk; sidecar reads JSON, writes JSON (`best_prompt`, scores, lineage).
- TypeScript sets `PYTHONPATH` to `python/` (or the user installs editable `pip install -e python/`).
- Override the interpreter with `SYSPROMPT_PYTHON` (must be Python 3.10+).
- `--dry-run` must not spawn Python.
- Wrap `gepa.optimize` only. Do not fork or vendor AGPL GEPA/DSPy internals.

## Environment

Required for live model calls (`run` without `--dry-run`):

| Variable | Meaning |
|---|---|
| `LLM_API_BASE` | OpenAI-compatible API root. `/v1` is appended when missing |
| `LLM_API_MODEL` | Student / execution model id |
| `LLM_API_TOKEN` | Secret. Never log the raw value; never commit `.env` |

Optional:

| Variable | Meaning |
|---|---|
| `LLM_REFLECTION_MODEL` | R2 reflection LM; defaults to `LLM_API_MODEL` |
| `SYSPROMPT_PYTHON` | Python executable for the R2 sidecar |
| `SYSPROMPT_R2_BUDGET` | `light` / `medium` / `heavy` or max metric calls |
| `SYSPROMPT_R1_ROUNDS` / `SYSPROMPT_R1_CANDIDATES` / `SYSPROMPT_R1_PASS_STREAK` / `SYSPROMPT_R1_BUDGET` | R1 loop knobs (CLI flags win) |
| `SYSPROMPT_REWRITE_MODE` | `patch` / `full` / `auto` |
| `SYSPROMPT_PATCH_THRESHOLD` | `auto` uses patch when prompt length ≥ this (default **1500** chars) |
| `SYSPROMPT_IMAGE_DIR` | Directory of local images for multimodal eval (`input.image` / `input.image_path`) |

`ingest` / `bind` / `export` / `validate` / `run --dry-run` must work with no LLM env.

## Multimodal eval

Cases may set `input.image` or `input.image_path`. The student request is system + user text + an OpenAI-compatible `image_url` (local jpeg/png/webp → data URL). Paths resolve relative to the suite file, the card ingest dir, or `SYSPROMPT_IMAGE_DIR`. Keep vision benches and image binaries **local only** — never commit them. R0/R1 rewrite stays text; put `got X want Y` in the scorer note. R2 / GEPA is not vision-aware. Optional suite fields `temperature` / `max_tokens` (or CLI `--temperature` / `--max-tokens`) apply to **student** eval only. Custom metric `id: nsfw_severity_tag` exact-matches one JSON `tags[]` severity label.

## Promote gate

Auto-promote only if **val** mean quality **strictly** improves versus the original baseline.

- R0: train-only suites never auto-promote.
- R1 / R2: if the suite has val cases, val must strictly rise. Mid-loop R1 adopt may use train as a **val-tie** break; end-of-loop promote still requires a strict rise vs the original baseline. Train-only suites may promote when train strictly rises.
- Human accept: `sysprompt promote <card> [version]` — does not re-run the gate.

Never promote because a diff looks nicer, a hypothesis sounds better, or train rose while val did not.

## Patch mode (R0 / R1)

Behavioral contract — keep these defaults unless a flag/env overrides them:

- `--rewrite-mode` default `auto`: **patch** when `system_prompt` length ≥ 1500 characters (`SYSPROMPT_PATCH_THRESHOLD`), else **full**.
- Patch = JSON `edits` or a unified diff, applied to the current prompt. Persist `sections.json` (and `patch.json` on R0).
- Reject empty / zero-hunk / prompt-emptying patches, or patches that change more than `--max-patch-ratio` of characters (R0 default `0.8`, R1 default `0.5`).
- One retry with the apply error; then fall back to a full rewrite only if `--allow-full-rewrite` (default **on** for R0; **off** for R1 on large/`patch` prompts).
- `--dry-run` applies a tiny fake patch; no LLM calls.
- R2 is whole-instruction GEPA. Large-prompt patch mode is R0/R1 only.

## Testing

- `npm test` is **offline** and must stay green (no network, no real API tokens).
- Prefer `--dry-run` and injected `fetch` / sidecar mocks for rung tests.
- `npm run test:python` covers sidecar metric helpers without downloading `gepa`.
- Never commit secrets, `.env`, or `.spl/` workspace artifacts.
- Keep `examples/support-bot` ingest → bind → export working from the repo root.
- Never commit vision-eval images, private suites, or NSFW binaries. Use local paths / `SYSPROMPT_IMAGE_DIR`.

## PR hygiene

- Small, focused PRs. Structure-only changes should not change optimize/eval behavior.
- Keep the published CLI UX: from repo root, `ingest`, `bind`, `export`, `promote`, `run --rung R0|R1|R2` (plus patch-mode flags) still work via `npm run sysprompt`.
- New packages need `package.json` + `README.md` (purpose, exports, deps, non-goals).
- Do not add ephemeral task lists to this file.
