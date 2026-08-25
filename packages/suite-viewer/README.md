# `@sysprompt-lab/suite-viewer`

Local **Suite Viewer** WebUI: inspect an eval suite, preview local images, and write gold / notes back to the YAML (or JSON) on disk. Optionally overlay **one already-written eval run** (one model / one traj) to inspect misses.

## Purpose

A localhost-only labeler for private suites. No cloud deploy, no auth, **no model eval from the UI**. The run overlay is a read-only view of a report that already exists on disk.

```bash
# from the repo root
npm run suite-viewer -- examples/support-bot/suite.yaml
npm run suite-viewer -- /path/to/private/suite.yaml --port 8787 --image-dir /path/to/images

# overlay one saved traj (report.json or official scores.json)
npm run suite-viewer -- examples/support-bot/suite.yaml --run /path/to/report.json
npm run suite-viewer -- /path/to/private/suite.yaml --run scores.json --runs-dir .spl/runs

# same command via the published CLI
npm run sysprompt -- suite-viewer /path/to/private/suite.yaml --run /path/to/report.json
```

Opens `http://127.0.0.1:8787` (bind address is localhost by default). Point `--image-dir` or `SYSPROMPT_IMAGE_DIR` at a local image folder. Paths also resolve relative to the suite file.

**Do not commit** vision benches, NSFW binaries, or real tagged images. The viewer is framework only.

## Run overlay (read-only)

`--run <report.json|scores.json>` joins the artifact to suite cases by id:

| Artifact | Shape |
|---|---|
| Official `scores.json` / `evaluatePrompt` rows | `case_id` + `output` + optional `reasoning`, `finish_reason`, `reasoning_tokens`. Aggregate rows (no case id) are used for split means only. |
| Older local `report.json` | `{ model, temperature, splits: { train\|val: { meanQuality, cases: [{ id, gold, quality, note, output, error? }] } } }` |

Missing case ids in the run show as **no prediction**. Extra ids in the run are ignored. Duplicate case ids keep the last row (so a file that writes baseline then candidate overlays the candidate).

`--runs-dir <dir>` lists `report.json` / `scores.json` a few folders down so the UI can switch. You can also paste a path in the Run overlay field. Loading or switching a run never starts an eval.

The case pane shows gold vs predicted output (parsed NSFW `tags[]` severity when the suite metric is `nsfw_severity_tag`, otherwise raw output), **OK / MISS** plus the scorer note, and a collapsible reasoning / `finish_reason` / `reasoning_tokens` panel when those fields exist. The list can filter to misses (and train/val).

**Save still writes the suite file only.** The report is never mutated.

## Public surface

- `mergeCaseGold` / `validateGoldForMetric` — apply a gold/notes edit to a suite object
- `tryResolveViewerImage` — resolve `input.image` / `input.image_path` (same roots as eval)
- `saveSuiteCase` — atomic write (temp + rename), then re-parse
- `parseRunArtifact` / `joinRunToSuite` / `loadRunArtifactFromFile` / `listRunArtifacts` — parse and join a saved traj
- `listenSuiteViewer` / `createSuiteViewerListener` — HTTP app for tests and the CLI (`--run`, `--runs-dir`)
- `registerSuiteViewerCommand` — Commander subcommand used by `sysprompt suite-viewer`

## Dependencies

`@sysprompt-lab/core`, `@sysprompt-lab/eval`, `@sysprompt-lab/llm` (`.env` load), `commander`, `yaml`.

## Must not live here

- Optimize / eval loops (`@sysprompt-lab/rungs`)
- Promote-gate decisions (this UI only edits gold)
- A second schema tree or a committed image bench
