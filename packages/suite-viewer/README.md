# `@sysprompt-lab/suite-viewer`

Local **Suite Viewer** WebUI: inspect an eval suite, preview local images, and write gold / notes back to the YAML (or JSON) on disk.

## Purpose

A localhost-only labeler for private suites. No cloud deploy, no auth, no model eval from the UI.

```bash
# from the repo root
npm run suite-viewer -- examples/support-bot/suite.yaml
npm run suite-viewer -- /path/to/private/suite.yaml --port 8787 --image-dir /path/to/images

# same command via the published CLI
npm run sysprompt -- suite-viewer /path/to/private/suite.yaml
```

Opens `http://127.0.0.1:8787` (bind address is localhost by default). Point `--image-dir` or `SYSPROMPT_IMAGE_DIR` at a local image folder. Paths also resolve relative to the suite file.

**Do not commit** vision benches, NSFW binaries, or real tagged images. The viewer is framework only.

## Public surface

- `mergeCaseGold` / `validateGoldForMetric` — apply a gold/notes edit to a suite object
- `tryResolveViewerImage` — resolve `input.image` / `input.image_path` (same roots as eval)
- `saveSuiteCase` — atomic write (temp + rename), then re-parse
- `listenSuiteViewer` / `createSuiteViewerListener` — HTTP app for tests and the CLI
- `registerSuiteViewerCommand` — Commander subcommand used by `sysprompt suite-viewer`

## Dependencies

`@sysprompt-lab/core`, `@sysprompt-lab/eval`, `@sysprompt-lab/llm` (`.env` load), `commander`, `yaml`.

## Must not live here

- Optimize / eval loops (`@sysprompt-lab/rungs`)
- Promote-gate decisions (this UI only edits gold)
- A second schema tree or a committed image bench
