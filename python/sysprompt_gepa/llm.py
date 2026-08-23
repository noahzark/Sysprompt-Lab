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
    if not isinstance(data, dict):
        raise RuntimeError("LLM chat/completions returned a non-object body")
    choices = data.get("choices")
    if not isinstance(choices, list) or not choices:
        raise RuntimeError("LLM chat/completions returned no choices")
    message = choices[0].get("message") if isinstance(choices[0], dict) else None
    raw = message.get("content") if isinstance(message, dict) else None
    if isinstance(raw, str) and raw:
        return raw
    if isinstance(raw, list):
        parts: list[str] = []
        for part in raw:
            if isinstance(part, str):
                parts.append(part)
            elif isinstance(part, dict) and isinstance(part.get("text"), str):
                parts.append(part["text"])
        text = "".join(parts)
        if text:
            return text
    raise RuntimeError("LLM chat/completions returned empty message content")


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
