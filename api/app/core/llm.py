"""One door to the hosted model.

Every LLM call in Citetax goes through here so three things hold everywhere:

1. Nothing that identifies a person is sent. Callers pass redacted text or
   structured facts; this module never sees a raw user message.
2. Structured output is parsed and validated, never trusted. A model that
   returns malformed JSON degrades to the caller's fallback, not to a 500.
3. Every call is logged with token usage, so cost per answer is measurable
   (spec section 10, under LKR 5 per answer).

gpt-oss-120b is a reasoning model: reasoning tokens draw from max_tokens. Budget
generously and check finish_reason, because a truncated answer can end mid
figure and read as a different number.
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any, TypeVar

from pydantic import BaseModel, ValidationError

from app.core.config import get_settings

logger = logging.getLogger(__name__)

T = TypeVar("T", bound=BaseModel)


@dataclass
class LLMCall:
    """What happened on one call, for the trace and the cost ledger."""

    model: str
    called: bool = False
    ok: bool = False
    ms: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    finish_reason: str | None = None
    error: str | None = None
    raw: str | None = None

    def to_json(self) -> dict[str, Any]:
        return {
            "model": self.model,
            "called": self.called,
            "ok": self.ok,
            "ms": self.ms,
            "tokens": {"in": self.prompt_tokens, "out": self.completion_tokens},
            "finish_reason": self.finish_reason,
            "error": self.error,
        }


@dataclass
class LLMBudget:
    """Accumulates usage across the calls one request makes."""

    calls: list[LLMCall] = field(default_factory=list)

    def add(self, call: LLMCall) -> None:
        self.calls.append(call)

    @property
    def total_tokens(self) -> int:
        return sum(c.prompt_tokens + c.completion_tokens for c in self.calls)

    @property
    def total_ms(self) -> int:
        return sum(c.ms for c in self.calls)

    def to_json(self) -> dict[str, Any]:
        return {
            "calls": [c.to_json() for c in self.calls],
            "total_tokens": self.total_tokens,
            "total_ms": self.total_ms,
        }


class LLMUnavailable(Exception):
    """No key, or the provider refused. Callers fall back to deterministic code."""


def available() -> bool:
    return get_settings().llm_enabled


def _client():
    from groq import Groq

    return Groq(api_key=get_settings().groq_api_key)


def complete(
    system: str,
    user: str,
    *,
    json_mode: bool = False,
    max_tokens: int = 2000,
    temperature: float = 0.1,
    budget: LLMBudget | None = None,
) -> tuple[str, LLMCall]:
    """Plain completion. Raises LLMUnavailable when the model cannot be used."""
    settings = get_settings()
    call = LLMCall(model=settings.groq_model)

    if not settings.llm_enabled:
        call.error = "GROQ_API_KEY not set"
        if budget:
            budget.add(call)
        raise LLMUnavailable(call.error)

    kwargs: dict[str, Any] = {
        "model": settings.groq_model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "max_tokens": max_tokens,
        "temperature": temperature,
    }
    if json_mode:
        kwargs["response_format"] = {"type": "json_object"}
        # Classification should be repeatable. A reasoning model at temperature
        # zero still drifts between runs; a fixed seed narrows that.
        kwargs["seed"] = 7

    t0 = time.perf_counter()
    try:
        resp = _client().chat.completions.create(**kwargs)
        call.called = True
        call.ms = int((time.perf_counter() - t0) * 1000)
        choice = resp.choices[0]
        call.finish_reason = choice.finish_reason
        if resp.usage:
            call.prompt_tokens = resp.usage.prompt_tokens or 0
            call.completion_tokens = resp.usage.completion_tokens or 0
        content = choice.message.content or ""
        call.raw = content

        if choice.finish_reason == "length":
            call.error = "truncated at max_tokens"
            if budget:
                budget.add(call)
            raise LLMUnavailable(call.error)

        call.ok = True
        if budget:
            budget.add(call)
        return content, call
    except LLMUnavailable:
        raise
    except Exception as exc:  # noqa: BLE001
        call.called = True
        call.ms = int((time.perf_counter() - t0) * 1000)
        call.error = str(exc)[:300]
        if budget:
            budget.add(call)
        logger.warning("llm call failed: %s", call.error)
        raise LLMUnavailable(call.error) from exc


def structured(
    schema: type[T],
    system: str,
    user: str,
    *,
    max_tokens: int = 2000,
    temperature: float = 0.0,
    budget: LLMBudget | None = None,
    retry_once: bool = True,
) -> tuple[T, LLMCall]:
    """JSON mode completion parsed into a pydantic model.

    The schema's JSON shape is appended to the system prompt so the model knows
    the exact keys. A validation failure retries once with the error quoted;
    a second failure raises so the caller can fall back.
    """
    shape = json.dumps(schema.model_json_schema(), indent=None)
    sys_prompt = (
        f"{system}\n\nRespond with a single JSON object and nothing else. "
        f"It must validate against this JSON schema:\n{shape}"
    )

    content, call = complete(
        sys_prompt, user, json_mode=True, max_tokens=max_tokens,
        temperature=temperature, budget=budget,
    )
    try:
        return schema.model_validate_json(content), call
    except ValidationError as exc:
        if not retry_once:
            call.error = f"schema validation failed: {str(exc)[:200]}"
            raise LLMUnavailable(call.error) from exc

        repair = (
            f"{user}\n\nYour previous answer did not validate:\n{str(exc)[:600]}\n"
            f"Previous answer was:\n{content[:1500]}\n\nReturn corrected JSON only."
        )
        content2, call2 = complete(
            sys_prompt, repair, json_mode=True, max_tokens=max_tokens,
            temperature=0.0, budget=budget,
        )
        try:
            return schema.model_validate_json(content2), call2
        except ValidationError as exc2:
            call2.error = f"schema validation failed twice: {str(exc2)[:200]}"
            raise LLMUnavailable(call2.error) from exc2
