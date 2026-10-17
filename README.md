# Sysprompt Lab

English | [简体中文](README.zh-CN.md)

A cross-model system-prompt workbench: ingest an existing system prompt → optimize it on a rung (R0 rewrite / R1 eval loop / R2 GEPA wrap) → run it on the model you choose → verify with the same eval suite, and promote only when it is better.

## Positioning

This is not another "paste → prettier prompt" tool, and it does not make you rewrite your prompt as DSPy modules first. It fills the gap between vendor consoles that lock you to one model and compiler frameworks that force a new object model on you.

The unit of work is a **Prompt Card**, not a chat.

## Rungs at a glance

| Rung | When | What |
|---|---|---|
| **R0** | No dataset / one-shot | Meta-prompt rewrite or structured patch, unified diff, human accepts |
| **R1** | Literal system prompt + eval suite | Baseline → failure evidence → a few candidates → adopt only if the score rises |
| **R2** | Same Card + suite; needs Python | Wrap official `gepa.optimize` (sidecar): train mutates, val selects |

All three rungs share one acceptance gate: execute → verify on the same metric (including the val hold-out) → auto-promote only when val mean quality strictly rises.

See [docs/plan.md](docs/plan.md) for the phased plan and [AGENTS.md](AGENTS.md) for durable conventions for coding agents.

## Layout

npm workspaces. Public imports use `@sysprompt-lab/<name>` (the root package `sysprompt-lab` re-exports the same surface).

```
packages/core      Card / suite schemas, .spl I/O
packages/llm       OpenAI-compatible client + LLM_API_* env
packages/eval      Score, splits, promote / adopt gate
packages/rewrite   Full rewrite + patch apply + R0/R1 meta-prompts
packages/rungs     R0 / R1 / R2 orchestration (R2 calls python/)
packages/cli       sysprompt / spl bins and commands
packages/suite-viewer  localhost Suite Viewer (inspect / label suites)
python/            GEPA sidecar (not inside a TS package)
schemas/           JSON Schema draft-07 sources of truth
examples/          Ingestable cards (support-bot)
docs/              Product plan
```

## Install

Node 20+. From the repo root:

```bash
npm install
npm run build    # optional; compiles dist/ and refreshes schemas/
npm test
```

Development CLI (no global install):

```bash
npm run sysprompt -- --help
# aliases: npm run spl -- …    or    npx tsx packages/cli/src/cli.ts …
```

After `npm run build`, the bins are `sysprompt` and `spl` (`npx sysprompt` / `npx spl` from this package).

## Quickstart

End to end on the bundled example: ingest a prompt → bind an eval suite → optimize on a rung → same-metric eval → promote → export. Every step except 4 runs offline with no API keys.

```bash
# 1. Ingest: examples/support-bot/system.md (+ tools.json) → draft Prompt Card
npm run sysprompt -- ingest examples/support-bot

# 2. Check the suite, then bind it to the card (status: bound)
npm run sysprompt -- validate examples/support-bot/suite.yaml
npm run sysprompt -- bind support-bot examples/support-bot/suite.yaml

# 3. Optimize + eval on a rung (offline stub; no API keys, no Python)
npm run sysprompt -- run support-bot --rung R1 --dry-run

# 4. Live: copy .env.example → .env, fill LLM_API_BASE / LLM_API_MODEL / LLM_API_TOKEN
cp .env.example .env
npm run sysprompt -- run support-bot --rung R1     # or R0, or R2 (needs the Python sidecar)

# 5. Promote: automatic only when val strictly improves; otherwise accept by hand
npm run sysprompt -- promote support-bot           # latest non-baseline version
npm run sysprompt -- promote support-bot ver_…     # or a specific version id

# 6. Export the promoted prompt (falls back to the baseline if nothing is promoted)
npm run sysprompt -- export support-bot            # → .spl/export/support-bot/system.promoted.md
```

Each live `run` scores the baseline and the candidate(s) on the **same** suite and metric and prints a train / val table. Workspace state lives under `.spl/` in the current directory (or `--root <dir>`); never commit it:

| Path | What |
|---|---|
| `.spl/cards/<card>.json` | Prompt Card (all versions) |
| `.spl/suites/<suite>.json` | Normalized eval suite (written by `bind`) |
| `.spl/runs/<run>/` | Per-run artifacts: `run.json`, `candidates.json`, `r0.diff` / `r1.diff` / `r2.diff`, `scores.json` (live eval), plus the rung-specific files below |
| `.spl/export/<card>/` | `card.json` + `system.promoted.md` |

## Prompt Card format

`ingest <path>` reads a directory (or a `system.md` path inside one):

| File | Required | Content |
|---|---|---|
| `system.md` | yes | The literal system prompt, used verbatim as the baseline version |
| `tools.json` | no | `[{ "id", "name", "description" }]` or `{ "tools": [...] }` |

The card id defaults to the directory name (slugified); override with `--id`. The stored card (`schemas/prompt-card.json`) looks like:

```jsonc
{
  "id": "support-bot",
  "source": "/abs/path/examples/support-bot",
  "rung": "R0",                       // last rung run: R0 | R1 | R2
  "status": "draft",                  // draft → bound → optimizing → verifying → promoted → exported (or rejected)
  "suite_id": "support-bot",          // set by `bind`
  "versions": [
    { "id": "ver_…", "system_prompt": "…", "is_baseline": true, "promoted": false },
    { "id": "ver_…", "system_prompt": "…", "hypothesis": "…", "is_baseline": false, "promoted": true, "parent": "ver_…" }
  ],
  "tools": [{ "id": "lookup_order", "name": "lookup_order", "description": "…" }],
  "models": []
}
```

Every rung appends versions; nothing overwrites the baseline. `promote` flips `promoted` on one version, and `export` writes that version (or the baseline).

## Eval suite format

YAML or JSON (`schemas/eval-suite.json`). See [`examples/support-bot/suite.yaml`](examples/support-bot/suite.yaml):

```yaml
id: support-bot
name: Support bot offline suite
metric:
  id: string_contains
  kind: custom            # exact | custom (llm_judge is not implemented yet)
  returns_feedback: false
splits:                   # case ids; a case may sit in only one split
  train: [greet-hello, refund-ask, hours-ask, unknown-order]
  val: [greet-hi, escalate-angry]   # may be empty; train-only suites never auto-promote on R0
cases:
  - id: refund-ask
    input:
      user: I want a refund for my last purchase.
      # image: / image_path: local jpeg/png/webp for vision cases
    gold: 30-day
    feedback: optional note shown to the rewriter
temperature: 0            # optional, student eval only
max_tokens: 512           # optional, student eval only
```

Scoring per `metric`:

| `kind` / `id` | Pass when |
|---|---|
| `exact` | trimmed output equals `gold` |
| `custom` (any id) | output contains `gold` (case-insensitive) |
| `custom` + `id: nsfw_severity_tag` | one JSON `tags[]` severity label matches gold (see [Vision cases](#vision-cases)) |

Splits may also be written as `{ name: train, case_ids: [...] }`.

## Commands

All commands accept the global `--root <dir>` (workspace that holds `.spl/`, default: cwd). `<card>` is a card id or a path to a card JSON.

| Command | What |
|---|---|
| `ingest <path> [--id <id>]` | `system.md` (+ `tools.json`) → draft card |
| `validate <path>` | Check a card JSON or suite YAML/JSON against the schemas |
| `bind <card> <suite.yaml>` | Attach a suite; status `bound` |
| `run <card> --rung R0\|R1\|R2 [flags]` | Optimize + eval; see the rungs and flags below |
| `promote <card> [version]` | Human accept; does not re-run the gate |
| `export <card> [-o <dir>]` | `card.json` + `system.promoted.md` (default `.spl/export/<card>`) |
| `suite-viewer <suite.yaml> [flags]` | Localhost WebUI; see [Suite Viewer](#suite-viewer-local-webui) |

`ingest` / `bind` / `export` / `validate` / `promote` / `run --dry-run` / `suite-viewer` need no LLM env.

## Rungs

**R0** (`run --rung R0`) calls the configured OpenAI-compatible API, writes a candidate + unified diff under `.spl/runs/<id>/r0.diff`, scores **train** and **val** (if the suite has val cases) with the same metric, and auto-promotes **only** when val mean quality strictly rises. Otherwise the new version stays `promoted=false`. Train-only suites never auto-promote.

On large system prompts (`auto` when length ≥ 1500 characters, or `--rewrite-mode patch`) R0 asks for a **structured patch** (JSON edits or a unified diff) and applies it to the current prompt. Tiny prompts still get a full rewrite. Artifacts include `sections.json` (section map) and `patch.json`.

**R1** (`run --rung R1`, same `.env`; the card must be bound) scores the baseline, shows the rewriter train failures + scores + history, and proposes a few candidates. On large prompts (`auto` ≥ 1500 chars, or `--rewrite-mode patch`) those candidates are **patches** — JSON `edits` or a unified diff — not a full rewrite; the rewriter is told to patch only what the failures implicate. Tiny prompts still use a full rewrite. Each candidate is eval'd on the same suite and adopted only if the score rises (val first, train as a val-tie break; train-only if the suite has no val cases). After the loop it writes `.spl/runs/<id>/candidates.jsonl`, `scores.json`, `sections.json`, and `r1.diff` (baseline → best). Auto-promote happens only if the **final** val (or train if there is no val) strictly beats the original baseline; otherwise the run stays unpromoted and the CLI says so.

**R2** wraps official GEPA (same `.env`, plus optional `LLM_REFLECTION_MODEL`). Install the Python sidecar first (Python 3.10+; this downloads `gepa`):

```bash
pip install -r python/requirements.txt   # or: pip install -e python/
npm run sysprompt -- run support-bot --rung R2 --budget light
```

`--rung R2` writes a job (seed prompt + suite cases + metric + API env), runs `python -m sysprompt_gepa` which calls `gepa.optimize`, then writes the best instruction back onto the Card. Artifacts: `.spl/runs/<id>/r2.diff`, `sidecar.json`, `scores.json`, `candidates.jsonl`, `summary.md`. Train mutates, val selects. Auto-promote uses the same gate as R1 (val must strictly beat the original baseline; train-only suites may promote if train rises). `--dry-run` skips Python and writes a stub candidate (what CI uses). `--budget light|medium|heavy` (default `light` = 24 metric calls; `medium` 60; `heavy` 150) or a positive integer. Do not call R0/R1 “GEPA”. R2 still optimizes the whole instruction via the GEPA sidecar; large-prompt patch mode is R0/R1 only.

### `run` flags

| Flag | Effect |
|---|---|
| `--dry-run` | No LLM / Python GEPA calls. R0/R1 apply a tiny fake patch; R2 writes a stub candidate (used by tests) |
| `--no-eval` | R0/R1: rewrite only. R2: skip auto-promote after the wrap |
| `--rounds <n>` | R1 max search rounds (default `3`, or `SYSPROMPT_R1_ROUNDS`) |
| `--candidates <n>` | R1 candidates per round (default `3`, or `SYSPROMPT_R1_CANDIDATES`) |
| `--pass-streak <n>` | R1 stop after N consecutive adopts (default `1`, or `SYSPROMPT_R1_PASS_STREAK`) |
| `--budget <value>` | R1: max candidate evals (int, default `rounds × candidates`). R2: `light` / `medium` / `heavy` or max metric calls (default `light`, or `SYSPROMPT_R2_BUDGET`) |
| `--rewrite-mode <mode>` | R0/R1: `patch` \| `full` \| `auto` (default `auto`). `auto` uses `patch` when the prompt is ≥ 1500 chars (`SYSPROMPT_PATCH_THRESHOLD`), else `full` |
| `--max-patch-ratio <n>` | R0/R1: reject a patch that changes more than this fraction of characters (default `0.8` on R0, `0.5` on R1) |
| `--allow-full-rewrite` / `--no-allow-full-rewrite` | If a patch cannot be applied, retry once, then optionally fall back to a full rewrite. Default: on for R0; off for R1 on large/`patch` prompts |
| `--temperature <n>` | R0/R1 **student** eval temperature (default `0`, or `suite.temperature`). Rewriter stays colder |
| `--max-tokens <n>` | R0/R1 **student** eval `max_tokens` (omit by default, or `suite.max_tokens`) |

More detail: [examples/support-bot/README.md](examples/support-bot/README.md).

### Vision cases

Vision cases are supported in the framework (`input.image` / `input.image_path`, student `--temperature` / `--max-tokens`, custom metric `nsfw_severity_tag`) but **do not commit** image binaries or a real tagging bench. Keep the suite and files on your machine; point images at a local directory or `SYSPROMPT_IMAGE_DIR`. Gold for `nsfw_severity_tag` may list multiple acceptable severities (`accept` or a `severity` array) for borderline images. Gold with no tier passes when the model also emits no severity tag.

### Suite Viewer (local WebUI)

Inspect a suite, preview local images, and write gold / notes back to the YAML on disk. Optionally overlay one saved eval run (`--run report.json|scores.json`) to inspect misses — gold vs model output, plus reasoning when the file has it. Binds **localhost only** (`127.0.0.1:8787` by default). No cloud deploy, no auth, no model eval from the UI.

```bash
npm run suite-viewer -- examples/support-bot/suite.yaml
npm run suite-viewer -- /path/to/private/suite.yaml --port 8787 --image-dir /path/to/images
npm run suite-viewer -- examples/support-bot/suite.yaml --run /path/to/report.json
# same via the CLI:
npm run sysprompt -- suite-viewer /path/to/private/suite.yaml --run scores.json --runs-dir .spl/runs
```

Flags: `--port <n>` (default `8787`), `--host <host>` (default `127.0.0.1`), `--image-dir <dir>` (or `SYSPROMPT_IMAGE_DIR`), `--run <file>` (read-only overlay), `--runs-dir <dir>` (folder of run files the UI can switch between).

Point this at a **private** suite path. Save is atomic (temp + rename) and refuses to write an invalid NSFW severity. If the file changed on disk, the UI asks before overwrite. Saving gold does not mutate the run file. See [`packages/suite-viewer/README.md`](packages/suite-viewer/README.md).

## Where to configure

Copy `.env.example` in the repo root (or in the directory you run the CLI from) to `.env` and fill in three variables:

| Variable | Meaning |
|---|---|
| `LLM_API_BASE` | OpenAI-compatible API root. `/v1` is appended when missing, then the client POSTs `{base}/chat/completions` |
| `LLM_API_MODEL` | Model / API id (for example `gpt-4o-mini`, `deepseek-chat`) |
| `LLM_API_TOKEN` | Secret. Keep it in `.env` only and never commit it. Logs mask it and never print the raw value |

```bash
cp .env.example .env
```

`ingest` / `bind` / `export` / `validate` / `promote` / `run --dry-run` / `suite-viewer` need none of these. Live `run --rung R0` / `R1` / `R2` calls `getLlmConfig()`, which fails with a hint to copy `.env.example` when any variable is missing.

Optional overrides (CLI flags win):

| Variable | Meaning |
|---|---|
| `SYSPROMPT_R1_ROUNDS` / `SYSPROMPT_R1_CANDIDATES` / `SYSPROMPT_R1_PASS_STREAK` / `SYSPROMPT_R1_BUDGET` | R1 loop knobs |
| `SYSPROMPT_REWRITE_MODE` | R0/R1 rewrite mode: `patch` / `full` / `auto`. Large prompts are patched by default so a whole rewrite does not get truncated |
| `SYSPROMPT_PATCH_THRESHOLD` | `auto` switches to patch mode at this many characters (default `1500`) |
| `LLM_REFLECTION_MODEL` | R2 reflection model; defaults to `LLM_API_MODEL` |
| `SYSPROMPT_R2_BUDGET` | R2 budget: `light` / `medium` / `heavy` or max metric calls |
| `SYSPROMPT_PYTHON` | Python 3.10+ executable for the R2 sidecar |
| `SYSPROMPT_IMAGE_DIR` | Directory of local images for vision cases |

## Library

```ts
import { ingest, bind, exportCard, runR0, runR1, runR2, promoteVersion, loadCard, loadSuite } from "sysprompt-lab";
```

JSON Schema (draft-07) for every entity lives in [`schemas/`](schemas/). Zod sources in [`packages/core`](packages/core) are the runtime validators and can re-emit those files (`npm run emit-schemas`). Package READMEs document each workspace’s public surface and non-goals.

## Status

Phase 3: schemas + offline ingest / bind / validate / export + R0 rewrite, R1 eval-loop (both with large-prompt patch mode), R2 GEPA wrap (`python -m sysprompt_gepa`), multimodal eval cases, and the local Suite Viewer. Live R2 needs `pip install -r python/requirements.txt`.

## License

MIT
