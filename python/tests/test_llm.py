import unittest

from sysprompt_gepa.llm import extract_content, parse_chat_completion


class ParseChatCompletionTest(unittest.TestCase):
    def test_string_content(self) -> None:
        self.assertEqual(
            extract_content({"choices": [{"message": {"content": "hello"}}]}),
            "hello",
        )

    def test_reasoning_content_is_not_scored(self) -> None:
        parsed = parse_chat_completion(
            {
                "choices": [
                    {
                        "finish_reason": "stop",
                        "message": {"content": "hello", "reasoning_content": "think"},
                    }
                ],
                "usage": {"completion_tokens_details": {"reasoning_tokens": 4}},
            }
        )
        self.assertEqual(parsed["content"], "hello")
        self.assertEqual(parsed["reasoning"], "think")
        self.assertEqual(parsed["finish_reason"], "stop")
        self.assertEqual(parsed["reasoning_tokens"], 4)

    def test_empty_content_with_reasoning_succeeds(self) -> None:
        parsed = parse_chat_completion(
            {"choices": [{"message": {"content": None, "reasoning": "only thoughts"}}]}
        )
        self.assertEqual(parsed["content"], "")
        self.assertEqual(parsed["reasoning"], "only thoughts")
        self.assertEqual(extract_content({"choices": [{"message": {"content": "", "reasoning_content": "x"}}]}), "")

    def test_missing_content_without_reasoning_raises(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "empty message content"):
            extract_content({"choices": [{"message": {"content": None}}]})


if __name__ == "__main__":
    unittest.main()
