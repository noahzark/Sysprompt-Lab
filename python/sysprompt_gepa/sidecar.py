"""Read a TS job dir, call gepa.optimize, write result.json. No GEPA reimplementation."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from sysprompt_gepa.llm import make_reflection_lm, redact
from sysprompt_gepa.metric import resolve_max_metric_calls


def _load_job(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("job.json must be an object")
    return data


def _token(job: dict[str, Any]) -> str:
    student = job.get("student") if isinstance(job.get("student"), dict) else {}
    reflection = job.get("reflection") if isinstance(job.get("reflection"), dict) else {}
    return str(student.get("token") or reflection.get("token") or "")


def _mean(adapter: Any, dataset: list[dict[str, Any]], candidate: dict[str, str]) -> float | None:
    if not dataset:
        return None
    batch = adapter.evaluate(dataset, candidate, capture_traces=False)
    if not batch.scores:
        return 0.0
    return float(sum(batch.scores) / len(batch.scores))


def _best_prompt(result: Any, seed: str) -> str:
    best = getattr(result, "best_candidate", None)
    if isinstance(best, dict):
        text = best.get("system_prompt") or best.get("prompt")
        if isinstance(text, str) and text.strip():
            return text
        for value in best.values():
            if isinstance(value, str) and value.strip():
                return value
    if isinstance(best, str) and best.strip():
        return best
    return seed


def _history(result: Any) -> list[dict[str, Any]]:
    candidates = getattr(result, "candidates", None) or []
    scores = getattr(result, "val_aggregate_scores", None) or []
    rows: list[dict[str, Any]] = []
    for idx, cand in enumerate(candidates):
        text = ""
        if isinstance(cand, dict):
            raw = cand.get("system_prompt") or cand.get("prompt") or ""
            text = raw if isinstance(raw, str) else ""
        elif isinstance(cand, str):
            text = cand
        rows.append(
            {
                "idx": idx,
                "val_score": scores[idx] if idx < len(scores) else None,
                "prompt_chars": len(text),
            }
        )
    return rows


def run_job(job: dict[str, Any]) -> dict[str, Any]:
    # Import gepa only on the live path so metric tests stay dependency-free.
    import gepa

    from sysprompt_gepa.adapter import COMPONENT, PromptCardAdapter

    seed = job.get("seed_prompt")
    if not isinstance(seed, str) or not seed.strip():
        raise ValueError("job.seed_prompt is required")

    metric = job.get("metric") if isinstance(job.get("metric"), dict) else {}
    kind = str(metric.get("kind") or "custom")
    if kind == "llm_judge":
        raise ValueError("Metric kind llm_judge is not implemented. Use exact or custom.")

    train = job.get("train") if isinstance(job.get("train"), list) else []
    val = job.get("val") if isinstance(job.get("val"), list) else []
    if not train:
        raise ValueError("job.train must be a non-empty list")

    student = job.get("student") if isinstance(job.get("student"), dict) else {}
    reflection = job.get("reflection") if isinstance(job.get("reflection"), dict) else student
    for name, cfg in (("student", student), ("reflection", reflection)):
        if not cfg.get("api_base") or not cfg.get("model") or not cfg.get("token"):
            raise ValueError(f"job.{name} needs api_base, model, and token")

    budget_name, max_calls = resolve_max_metric_calls(job.get("budget"), job.get("max_metric_calls"))
    adapter = PromptCardAdapter(student, kind)
    seed_candidate = {COMPONENT: seed}

    result = gepa.optimize(
        seed_candidate=seed_candidate,
        trainset=train,
        valset=val or None,
        adapter=adapter,
        reflection_lm=make_reflection_lm(reflection),
        max_metric_calls=max_calls,
        candidate_selection_strategy="pareto",
        display_progress_bar=False,
        use_wandb=False,
        use_mlflow=False,
    )

    best_prompt = _best_prompt(result, seed)
    best_candidate = {COMPONENT: best_prompt}
    baseline_train = _mean(adapter, train, seed_candidate)
    baseline_val = _mean(adapter, val, seed_candidate)
    train_score = _mean(adapter, train, best_candidate)
    val_score = _mean(adapter, val, best_candidate)

    gepa_val = None
    scores = getattr(result, "val_aggregate_scores", None) or []
    best_idx = getattr(result, "best_idx", None)
    if scores and isinstance(best_idx, int) and 0 <= best_idx < len(scores):
        gepa_val = float(scores[best_idx])

    hypothesis = f"GEPA wrap ({budget_name}, max_metric_calls={max_calls})"
    return {
        "best_prompt": best_prompt,
        "hypothesis": hypothesis,
        "train_score": train_score,
        "val_score": val_score,
        "baseline_train": baseline_train,
        "baseline_val": baseline_val,
        "gepa_val_score": gepa_val,
        "total_metric_calls": getattr(result, "total_metric_calls", None),
        "budget": budget_name,
        "max_metric_calls": max_calls,
        "history": _history(result),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="sysprompt-gepa",
        description="Wrap gepa.optimize for a Sysprompt Lab R2 job directory.",
    )
    parser.add_argument("--job-dir", required=True, help="Directory with job.json; writes result.json")
    parser.add_argument("--job-file", default=None, help="Override path to job.json")
    parser.add_argument("--result-file", default=None, help="Override path to result.json")
    args = parser.parse_args(argv)

    job_dir = Path(args.job_dir)
    job_path = Path(args.job_file) if args.job_file else job_dir / "job.json"
    result_path = Path(args.result_file) if args.result_file else job_dir / "result.json"

    token = ""
    try:
        job = _load_job(job_path)
        token = _token(job)
        payload = run_job(job)
        result_path.parent.mkdir(parents=True, exist_ok=True)
        result_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
        print(f"ok wrote {result_path}", file=sys.stderr)
        return 0
    except Exception as exc:
        message = redact(str(exc), token)
        print(f"sysprompt-gepa failed: {message}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
