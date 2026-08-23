"""Suite metric + textual feedback. Stdlib only — safe to test without installing gepa."""

from __future__ import annotations

import json
from typing import Any

USER_KEYS = ("user", "message", "query", "text", "prompt")
BUDGET_CALLS = {"light": 24, "medium": 60, "heavy": 150}


def case_user_text(inp: Any) -> str:
    if not isinstance(inp, dict):
        return "" if inp is None else str(inp)
    for key in USER_KEYS:
        value = inp.get(key)
        if isinstance(value, str) and value:
            return value
    return json.dumps(inp, ensure_ascii=False)


def gold_text(gold: Any) -> str | None:
    if gold is None:
        return None
    if isinstance(gold, str):
        return gold
    return json.dumps(gold, ensure_ascii=False)


def score_case(kind: str, output: str, gold: Any) -> tuple[float, str]:
    """Match TS `scoreCase`: exact (trim) or custom (case-insensitive contains)."""
    if kind == "llm_judge":
        raise ValueError("Metric kind llm_judge is not implemented. Use exact or custom.")
    expected = gold_text(gold)
    if expected is None:
        return 0.0, "no gold"
    if kind == "exact":
        ok = output.strip() == expected.strip()
        if ok:
            return 1.0, "exact match"
        return 0.0, f"exact mismatch: expected {expected!r}"
    # custom / default: string-contains
    ok = expected.lower() in output.lower()
    if ok:
        return 1.0, "contains gold"
    return 0.0, f"missing gold substring {expected!r}"


def synthesize_feedback(
    *,
    kind: str,
    quality: float,
    note: str,
    output: str,
    gold: Any,
    case_feedback: str | None = None,
) -> str:
    """GEPA-oriented textual feedback. Prefer failure detail; never include secrets."""
    expected = gold_text(gold) or "(none)"
    snippet = output.replace("\n", " ").strip()
    if len(snippet) > 280:
        snippet = snippet[:279] + "…"
    extra = f" Author note: {case_feedback.strip()}" if case_feedback and case_feedback.strip() else ""
    if quality >= 1:
        return f"Correct ({note}). Gold={expected!r}.{extra}".strip()
    return (
        f"Incorrect ({kind}: {note}). Gold={expected!r}. Model output={snippet!r}.{extra}"
    ).strip()


def resolve_max_metric_calls(budget: Any, explicit: Any = None) -> tuple[str, int]:
    if explicit is not None and str(explicit).strip() != "":
        n = int(explicit)
        if n < 1:
            raise ValueError(f"max_metric_calls must be a positive integer, got {explicit!r}")
        return f"calls:{n}", n
    if budget is None or str(budget).strip() == "":
        return "light", BUDGET_CALLS["light"]
    raw = str(budget).strip().lower()
    if raw in BUDGET_CALLS:
        return raw, BUDGET_CALLS[raw]
    if raw.isdigit():
        n = int(raw)
        if n < 1:
            raise ValueError(f"budget must be a positive integer, got {budget!r}")
        return f"calls:{n}", n
    raise ValueError(
        f"budget must be light, medium, heavy, or a positive integer (max metric calls), got {budget!r}"
    )
