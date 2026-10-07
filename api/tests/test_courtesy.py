"""Greetings, thanks and "what can you do?" are answered, not refused."""

from __future__ import annotations

import pytest

from app.conversations.titles import title_for_turn
from app.graph import courtesy
from app.graph.answer import run_answer_graph


@pytest.mark.parametrize("text,kind", [
    ("hi", "greeting"), ("Hello!", "greeting"), ("hey there", "greeting"), ("good morning", "greeting"),
    ("thanks!", "thanks"), ("thank you so much", "thanks"), ("ok", "thanks"),
    ("what can you do?", "help"), ("How does this work?", "help"), ("who are you", "help"),
    ("write me a poem about tax", "creative"), ("tell me a joke", "creative"),
])
def test_small_talk_is_recognised(text, kind):
    assert courtesy.detect(text) == kind


@pytest.mark.parametrize("text", [
    "hi, what do I owe on a salary of 250,000 a month?",
    "How does APIT work for a salaried employee?",
    "thanks, and what if I also earn 500,000 from freelancing?",
    "What is the personal relief?",
])
def test_tax_questions_are_not_small_talk(text):
    assert courtesy.detect(text) is None


def test_a_greeting_skips_the_router(monkeypatch):
    from app.graph import intent as intent_mod

    def no_model(*_a, **_k):
        raise AssertionError("a greeting must not reach the router")

    monkeypatch.setattr(intent_mod, "route", no_model)
    from app.core import llm

    monkeypatch.setattr(llm, "available", lambda: False)
    r = run_answer_graph(None, "hi")
    assert (r.kind, r.intent) == ("answer", "conversation")
    assert "Citetax" in r.prose and r.suggestions
    assert all(c.called is False for c in r.llm_budget.calls)


def test_a_chat_that_opens_with_a_greeting_is_titled_new_chat():
    assert title_for_turn("conversation", "answer", None, None, None, [], "hi") == "New chat"


class _Call:
    def __init__(self, finish="stop"):
        self.finish_reason = finish


def _model_says(monkeypatch, text, finish="stop"):
    from app.core import llm

    monkeypatch.setattr(llm, "available", lambda: True)
    monkeypatch.setattr(llm, "complete", lambda *a, **k: (text, _Call(finish)))


def test_the_model_writes_the_reply(monkeypatch):
    _model_says(monkeypatch, "Hey again! What would you like to work out next?")
    text, by_model = courtesy.compose("greeting", "hey", ("hi",))
    assert by_model and text.startswith("Hey again")


def test_a_reply_with_a_figure_is_replaced(monkeypatch):
    _model_says(monkeypatch, "Hi! The personal relief is 1,800,000 a year.")
    text, by_model = courtesy.compose("greeting", "hi")
    assert not by_model and "1,800,000" not in text


def test_year_labels_are_allowed_in_a_reply(monkeypatch):
    from app.core import years

    ya = years.supported()[0]
    _model_says(monkeypatch, f"Hello! I can work out your tax for {ya}.")
    assert courtesy.compose("greeting", "hello")[1]


def test_a_cut_off_reply_is_replaced(monkeypatch):
    _model_says(monkeypatch, "Hello! I can", finish="length")
    assert not courtesy.compose("greeting", "hello")[1]


def test_a_second_greeting_is_not_a_second_introduction():
    assert "I'm Citetax" not in courtesy.reply("greeting", ("hi",))
    assert courtesy.suggestions("greeting", ("hi",)) == []
    assert courtesy.suggestions("greeting") and courtesy.suggestions("help", ("hi",))
