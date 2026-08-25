"""OpenAI-compatible chat/completions. Never logs the raw token."""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any


def normalize_api_base(api_base: str) -> str:
    base = api_base.rstrip("/")
    return base if base.endswith("/v1") else f"{base}/v1"


def chat_completions_url(api_base: str) -> str:
    return f"{normalize_api_base(api_base)}/chat/completions"


def redact(text: str, token: str) -> str:
    if not token:
        return text
    return text.replace(token, "[redacted]")


def mask_token(token: str) -> str:
    if len(token) <= 4:
        return "****"
    return f"{token[:3]}…{token[-2:]}"


def extract_content(data: Any) -> str:
    return parse_chat_completion(data)["content"]


def parse_chat_completion(data: Any) -> dict[str, Any]:
    """Parse an OpenAI-compatible chat/completions body.

    Visible ``content`` is what metrics score. ``reasoning`` is diagnostic only.
    Empty content is allowed when reasoning is present (thinking models).
    """
    if not isinstance(data, dict):
        raise RuntimeError("LLM chat/completions returned a non-object body")
    choices = data.get("choices")
    if not isinstance(choices, list) or not choices:
        raise RuntimeError("LLM chat/completions returned no choices")
    choice = choices[0] if isinstance(choices[0], dict) else None
    message = choice.get("message") if isinstance(choice, dict) else None
    raw = message.get("content") if isinstance(message, dict) else None
    text, present = _visible_content(raw)
    reasoning = _message_reasoning(message if isinstance(message, dict) else None, raw)
    if not present and not reasoning:
        raise RuntimeError("LLM chat/completions returned empty message content")
    parsed: dict[str, Any] = {"content": text if present else ""}
    if reasoning:
        parsed["reasoning"] = reasoning
    finish_reason = _finish_reason(choice if isinstance(choice, dict) else None)
    if finish_reason:
        parsed["finish_reason"] = finish_reason
    reasoning_tokens = _reasoning_tokens(data)
    if reasoning_tokens is not None:
        parsed["reasoning_tokens"] = reasoning_tokens
    return parsed


_MESSAGE_REASONING_KEYS = (
    "reasoning_content",
    "reasoning",
    "thinking",
    "thinking_content",
    "reasoning_text",
)


def _as_non_empty_str(value: Any) -> str | None:
    if isinstance(value, str) and value:
        return value
    if isinstance(value, dict):
        content = value.get("content")
        if isinstance(content, str) and content:
            return content
        text = value.get("text")
        if isinstance(text, str) and text:
            return text
    return None


def _part_type(part: dict[str, Any]) -> str:
    raw = part.get("type")
    return raw.lower() if isinstance(raw, str) else ""


def _is_reasoning_part(type_name: str) -> bool:
    return type_name in {"reasoning", "thinking", "thought"}


def _visible_content(raw: Any) -> tuple[str, bool]:
    if isinstance(raw, str):
        return raw, True
    if isinstance(raw, list):
        parts: list[str] = []
        for part in raw:
            if isinstance(part, str):
                parts.append(part)
            elif isinstance(part, dict) and not _is_reasoning_part(_part_type(part)):
                text = part.get("text")
                if isinstance(text, str):
                    parts.append(text)
        return "".join(parts), True
    return "", False


def _message_reasoning(message: dict[str, Any] | None, content: Any) -> str | None:
    if message:
        for key in _MESSAGE_REASONING_KEYS:
            found = _as_non_empty_str(message.get(key))
            if found:
                return found
    if isinstance(content, list):
        from_parts: list[str] = []
        for part in content:
            if not isinstance(part, dict) or not _is_reasoning_part(_part_type(part)):
                continue
            found = _as_non_empty_str(part.get("text")) or _as_non_empty_str(part.get("thinking"))
            if found:
                from_parts.append(found)
        if from_parts:
            return "".join(from_parts)
    return None


def _finish_reason(choice: dict[str, Any] | None) -> str | None:
    if not choice:
        return None
    return _as_non_empty_str(choice.get("finish_reason")) or _as_non_empty_str(choice.get("finishReason"))


def _reasoning_tokens(data: dict[str, Any]) -> float | int | None:
    usage = data.get("usage")
    if not isinstance(usage, dict):
        return None
    details = usage.get("completion_tokens_details")
    if isinstance(details, dict):
        nested = details.get("reasoning_tokens", details.get("reasoning"))
        if isinstance(nested, (int, float)):
            return nested
    top = usage.get("reasoning_tokens")
    if isinstance(top, (int, float)):
        return top
    return None


def chat_completion(
    cfg: dict[str, str],
    messages: list[dict[str, str]],
    *,
    temperature: float = 0.0,
    timeout: float = 120.0,
) -> str:
    token = cfg.get("token") or ""
    url = chat_completions_url(cfg["api_base"])
    body = json.dumps(
        {"model": cfg["model"], "messages": messages, "temperature": temperature}
    ).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
            status = getattr(resp, "status", 200)
    except urllib.error.HTTPError as exc:
        snippet = redact(exc.read().decode("utf-8", errors="replace").replace("\n", " ")[:400], token)
        raise RuntimeError(f"LLM chat/completions failed: HTTP {exc.code} at {url} — {snippet}") from None
    except Exception as exc:
        detail = redact(str(exc), token)
        raise RuntimeError(
            f"LLM request failed for {cfg.get('model')} @ {normalize_api_base(cfg['api_base'])} "
            f"(token {mask_token(token)}): {detail}"
        ) from None
    if status >= 400:
        raise RuntimeError(f"LLM chat/completions failed: HTTP {status} at {url}")
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"LLM chat/completions returned non-JSON at {url}") from exc
    return extract_content(data)


def as_messages(prompt: Any) -> list[dict[str, str]]:
    if isinstance(prompt, str):
        return [{"role": "user", "content": prompt}]
    if isinstance(prompt, list):
        out: list[dict[str, str]] = []
        for item in prompt:
            if isinstance(item, dict) and isinstance(item.get("content"), str):
                role = item.get("role") if isinstance(item.get("role"), str) else "user"
                out.append({"role": role, "content": item["content"]})
            elif isinstance(item, str):
                out.append({"role": "user", "content": item})
        if out:
            return out
    raise TypeError(f"reflection_lm expected str or list of messages, got {type(prompt).__name__}")


def make_reflection_lm(cfg: dict[str, str]):
    """gepa.optimize reflection_lm: (str) -> str. Also accepts a message list."""

    def reflection_lm(prompt: Any, **_kwargs: Any) -> str:
        return chat_completion(cfg, as_messages(prompt), temperature=0.4)

    return reflection_lm
