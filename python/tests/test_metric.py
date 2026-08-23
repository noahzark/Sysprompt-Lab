"""Stdlib-only tests for the sidecar metric (no gepa install required)."""

from __future__ import annotations

import unittest

from sysprompt_gepa.metric import (
    case_user_text,
    resolve_max_metric_calls,
    score_case,
    synthesize_feedback,
)


class MetricTests(unittest.TestCase):
    def test_exact_and_contains(self) -> None:
        self.assertEqual(score_case("exact", "hello\n", "hello")[0], 1.0)
        self.assertEqual(score_case("exact", "hello", "Hello")[0], 0.0)
        self.assertEqual(score_case("custom", "Happy to help with that.", "happy to help")[0], 1.0)
        self.assertEqual(score_case("custom", "store opens at noon", "09:00")[0], 0.0)

    def test_user_text_keys(self) -> None:
        self.assertEqual(case_user_text({"user": "Hello"}), "Hello")
        self.assertEqual(case_user_text({"message": "Hi"}), "Hi")
        self.assertEqual(case_user_text({"order": 1}), '{"order": 1}')

    def test_feedback_on_failure(self) -> None:
        quality, note = score_case("custom", "nope", "30-day")
        text = synthesize_feedback(
            kind="custom",
            quality=quality,
            note=note,
            output="nope",
            gold="30-day",
            case_feedback="Do not invent a tracking status.",
        )
        self.assertIn("Incorrect", text)
        self.assertIn("30-day", text)
        self.assertIn("Author note", text)

    def test_budget_presets(self) -> None:
        self.assertEqual(resolve_max_metric_calls("light")[1], 24)
        self.assertEqual(resolve_max_metric_calls("medium")[1], 60)
        self.assertEqual(resolve_max_metric_calls("heavy")[1], 150)
        self.assertEqual(resolve_max_metric_calls(None, 40)[1], 40)
        self.assertEqual(resolve_max_metric_calls("12")[1], 12)
        with self.assertRaises(ValueError):
            resolve_max_metric_calls("turbo")


if __name__ == "__main__":
    unittest.main()
