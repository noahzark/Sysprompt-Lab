# sysprompt-gepa

Python sidecar for Sysprompt Lab **R2**. It wraps the official [`gepa.optimize`](https://gepa-ai.github.io/gepa/api/core/optimize/) API. It does not reimplement Pareto selection, merge, or reflective mutation.

## Install

Python 3.10+. From the repository root:

```bash
pip install -r python/requirements.txt
# or, editable:
pip install -e python/
```

The TypeScript CLI sets `PYTHONPATH` to this directory and runs `python -m sysprompt_gepa --job-dir <dir>`.

## Offline tests (no `gepa` download)

Metric / feedback helpers are stdlib-only:

```bash
cd python && python3 -m unittest tests.test_metric
```

Live optimization needs `gepa` plus `LLM_API_*` (and optional `LLM_REFLECTION_MODEL`).
