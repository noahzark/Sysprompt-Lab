"""Card → GEPAAdapter. Rollouts + feedback only; search stays inside gepa.optimize."""

from __future__ import annotations

from typing import Any

from gepa.core.adapter import EvaluationBatch

from sysprompt_gepa.llm import chat_completion
from sysprompt_gepa.metric import case_user_text, score_case, synthesize_feedback

COMPONENT = "system_prompt"


class PromptCardAdapter:
    """Minimal GEPAAdapter: one system-prompt component + suite metric + feedback."""

    def __init__(self, student: dict[str, str], metric_kind: str):
        self.student = student
        self.metric_kind = metric_kind

    def evaluate(
        self,
        batch: list[dict[str, Any]],
        candidate: dict[str, str],
        capture_traces: bool = False,
    ) -> EvaluationBatch:
        system = candidate.get(COMPONENT) or candidate.get("prompt") or ""
        outputs: list[str] = []
        scores: list[float] = []
        trajectories: list[dict[str, Any]] | None = [] if capture_traces else None

        for example in batch:
            user = case_user_text(example.get("input", example))
            gold = example.get("gold", example.get("answer"))
            case_feedback = example.get("feedback")
            try:
                output = chat_completion(
                    self.student,
                    [
                        {"role": "system", "content": system},
                        {"role": "user", "content": user},
                    ],
                    temperature=0.0,
                )
                quality, note = score_case(self.metric_kind, output, gold)
            except Exception as exc:
                output = ""
                quality, note = 0.0, f"rollout failed: {exc}"

            outputs.append(output)
            scores.append(float(quality))
            if trajectories is not None:
                feedback = synthesize_feedback(
                    kind=self.metric_kind,
                    quality=quality,
                    note=note,
                    output=output,
                    gold=gold,
                    case_feedback=case_feedback if isinstance(case_feedback, str) else None,
                )
                trajectories.append(
                    {
                        "input": user,
                        "gold": gold,
                        "output": output,
                        "score": quality,
                        "feedback": feedback,
                    }
                )

        return EvaluationBatch(
            outputs=outputs,
            scores=scores,
            trajectories=trajectories,
        )

    def make_reflective_dataset(
        self,
        candidate: dict[str, str],
        eval_batch: EvaluationBatch,
        components_to_update: list[str],
    ) -> dict[str, list[dict[str, Any]]]:
        del candidate
        rows: list[dict[str, Any]] = []
        trajectories = eval_batch.trajectories or []
        for traj, score, output in zip(
            trajectories,
            eval_batch.scores,
            eval_batch.outputs,
            strict=False,
        ):
            if isinstance(traj, dict):
                feedback = traj.get("feedback") or f"Score: {score}"
                inputs = {"user": traj.get("input", "")}
                generated = traj.get("output", output)
            else:
                feedback = f"Score: {score}"
                inputs = {"user": ""}
                generated = output
            rows.append(
                {
                    "Inputs": inputs,
                    "Generated Outputs": generated,
                    "Feedback": feedback,
                }
            )
        out: dict[str, list[dict[str, Any]]] = {}
        for name in components_to_update or [COMPONENT]:
            out[name] = rows
        return out
