# Support bot example

Offline Phase 0 walkthrough. No API keys.

From the repository root:

```bash
npm install
npm run sysprompt -- ingest examples/support-bot
npm run sysprompt -- bind support-bot examples/support-bot/suite.yaml
npm run sysprompt -- export support-bot
```

Artifacts land under `.spl/`:

| Path | What |
|---|---|
| `.spl/cards/support-bot.json` | Prompt Card (status `exported` after the last step) |
| `.spl/suites/support-bot.json` | Normalized eval suite |
| `.spl/export/support-bot/card.json` | Exported card |
| `.spl/export/support-bot/system.promoted.md` | Baseline prompt (nothing promoted yet) |

Optional Phase 1 stub (still no LLM calls):

```bash
npm run sysprompt -- ingest examples/support-bot
npm run sysprompt -- run support-bot --rung R0
```

That copies the baseline to a candidate with `hypothesis: stub` and writes a unified diff under `.spl/runs/<run-id>/r0.diff`.
