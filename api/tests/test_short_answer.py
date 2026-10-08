"""The short answer the chat shows first, above the figures."""

from __future__ import annotations

from app.graph.answer import _split_summary
from app.graph.explain import PROMPTS


def test_the_first_paragraph_is_the_short_answer():
    prose = "You owe LKR 540,000 for 2026/2027.\n\nThe ledger begins with assessable income of LKR 6,000,000 [Act s.5]."
    summary, rest = _split_summary(prose)
    assert summary == "You owe LKR 540,000 for 2026/2027."
    assert rest.startswith("The ledger begins")


def test_without_a_paragraph_break_there_is_no_short_answer():
    prose = "The ledger begins with assessable income of LKR 6,000,000 [Act s.5]."
    assert _split_summary(prose) == (None, prose)


def test_a_long_first_paragraph_is_not_a_short_answer():
    prose = ("word " * 200) + "\n\nThe rest."
    assert _split_summary(prose)[0] is None


def test_computations_and_filing_questions_ask_for_a_short_answer_first():
    assert "short answer" in PROMPTS["compute"] and "short answer" in PROMPTS["obligation"]
    assert "short answer" not in PROMPTS["rule_lookup"]
