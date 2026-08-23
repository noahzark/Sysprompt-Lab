# Support bot example

From the repository root.

## Offline (no API keys)

```bash
npm install
npm run sysprompt -- ingest examples/support-bot
npm run sysprompt -- bind support-bot examples/support-bot/suite.yaml
npm run sysprompt -- export support-bot
```

Artifacts land under `.spl/`:

| Path | What |
|---|---|
| `.spl/cards/support-bot.json` | Prompt Card |
| `.spl/suites/support-bot.json` | Normalized eval suite |
| `.spl/export/support-bot/card.json` | Exported card |
| `.spl/export/support-bot/system.promoted.md` | Promoted prompt, or baseline if nothing is promoted |

## Live R0

Copy `.env.example` → `.env` and set `LLM_API_BASE`, `LLM_API_MODEL`, `LLM_API_TOKEN`. The client POSTs `{base}/v1/chat/completions` (appends `/v1` if you omit it).

```bash
cp .env.example .env
npm run sysprompt -- ingest examples/support-bot
npm run sysprompt -- bind support-bot examples/support-bot/suite.yaml
npm run sysprompt -- run support-bot --rung R0
npm run sysprompt -- export support-bot
```

That rewrites the system prompt, writes `.spl/runs/<id>/r0.diff` plus `scores.json`, and prints train/val quality (and latency). Auto-promote happens only if **val** mean quality strictly rises. To accept a candidate yourself:

```bash
npm run sysprompt -- promote support-bot
npm run sysprompt -- export support-bot
```

No-network stub (same as tests):

```bash
npm run sysprompt -- run support-bot --rung R0 --dry-run
```

## Live R1

Same `.env` as R0. Bind the suite first, then run the eval loop. Search uses **train**; adopt / promote use **val** when the suite has val cases.

```bash
npm run sysprompt -- ingest examples/support-bot
npm run sysprompt -- bind support-bot examples/support-bot/suite.yaml
npm run sysprompt -- run support-bot --rung R1
```

Artifacts under `.spl/runs/<id>/`: `candidates.jsonl` (every tried candidate), `scores.json`, `r1.diff` (baseline → best), `summary.md`. Auto-promote only if final val strictly beats the original baseline.

Optional knobs (flags override `SYSPROMPT_R1_*`):

```bash
npm run sysprompt -- run support-bot --rung R1 --rounds 3 --candidates 3 --pass-streak 1
npm run sysprompt -- run support-bot --rung R1 --dry-run
```
