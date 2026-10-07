"""Conversation context, figure check, titles and the display envelope.

No database and no model: the builder is pure, and Route is exercised with the
model call replaced, so these run anywhere.
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from app.compute.types import TaxFacts
from app.conversations import envelope, titles
from app.conversations.context import (
    MAX_CONTEXT_CHARS,
    MAX_QUESTION_CHARS,
    ContextRow,
    ConversationContext,
    build_context,
    check_figures,
    stated_amounts,
)
from app.core import llm
from app.graph import answer as answer_mod
from app.graph import intent as intent_mod

SUPPORTED = ("2025/2026", "2026/2027")


def turn(seq: int, question: str, kind: str = "answer", *, reply: str = "",
         intent: str | None = "compute", ya: str | None = "2026/2027",
         facts: dict | None = None, run_id: str | None = None) -> list[ContextRow]:
    return [
        ContextRow(seq=seq, role="user", content=question),
        ContextRow(
            seq=seq + 1, role="assistant", kind=kind, content=reply,
            intent=intent, ya=ya, facts=facts,
            run_id=run_id if kind == "answer" else None,
        ),
    ]


SALARY_FACTS = {"ya": "2026/2027", "employment_income": "5000000", "business_income": "0",
                "epf_employee": None, "apit_withheld": "0", "source": "question"}


# ---------------------------------------------------------------------------
# Builder
# ---------------------------------------------------------------------------

def test_empty_conversation_gives_empty_context():
    ctx = build_context([])
    assert ctx.is_empty
    assert ctx.questions == () and ctx.facts == {} and ctx.ya is None


def test_carries_questions_facts_and_year_from_answers():
    rows = turn(1, "How much tax do I pay on LKR 5 million?",
                facts=SALARY_FACTS, run_id="11111111-aaaa")
    ctx = build_context(rows)
    assert ctx.questions == ("How much tax do I pay on LKR 5 million?",)
    assert ctx.facts == {"employment_income": Decimal("5000000")}
    assert ctx.facts_run_id == "11111111-aaaa"
    assert ctx.ya == "2026/2027"
    assert ctx.pending_clarify is None


def test_refused_turns_carry_nothing():
    rows = (
        turn(1, "How much tax on LKR 5 million?", facts=SALARY_FACTS, run_id="r1")
        + turn(3, "What is the VAT rate?", kind="refusal", intent="out_of_scope",
               ya="2025/2026", reply="Citetax covers personal income tax only.")
    )
    ctx = build_context(rows)
    assert ctx.questions == ("How much tax on LKR 5 million?",)
    assert ctx.ya == "2026/2027"      # the refusal's year does not steer
    assert "VAT" not in ctx.prompt_block()


def test_facts_only_from_compute_and_obligation_answers():
    rows = turn(1, "When is the return due?", intent="deadline",
                facts={"ya": "2026/2027", "employment_income": "9000000"}, run_id="r1")
    ctx = build_context(rows)
    assert ctx.facts == {}
    assert ctx.ya == "2026/2027"


def test_latest_computed_facts_win():
    rows = (
        turn(1, "Tax on 5 million?", facts=SALARY_FACTS, run_id="r1")
        + turn(3, "And with 500,000 freelance?", run_id="r2",
               facts={**SALARY_FACTS, "business_income": "500000"})
    )
    ctx = build_context(rows)
    assert ctx.facts == {"employment_income": Decimal("5000000"),
                         "business_income": Decimal("500000")}
    assert ctx.facts_run_id == "r2"


def test_pending_clarify_and_unresolved_chain():
    rows = (
        turn(1, "What do I owe?", kind="clarify", ya=None,
             reply="Which year of assessment are you asking about?")
        + turn(3, "2026/2027", kind="clarify",
               reply="What was your total income for the year?")
    )
    ctx = build_context(rows)
    assert ctx.pending_clarify == "What was your total income for the year?"
    assert ctx.unresolved == ("What do I owe?", "2026/2027")


def test_clarify_no_longer_pending_once_answered():
    rows = (
        turn(1, "What do I owe?", kind="clarify", reply="Which year?")
        + turn(3, "2026/2027 on 3,000,000", facts=SALARY_FACTS, run_id="r1")
    )
    ctx = build_context(rows)
    assert ctx.pending_clarify is None
    assert ctx.unresolved == ()


def test_window_is_bounded_regardless_of_thread_length():
    rows: list[ContextRow] = []
    for i in range(40):
        rows += turn(i * 2 + 1, f"question number {i}", intent="general", ya="2026/2027")
    ctx = build_context(rows)
    assert len(ctx.questions) == 3
    assert ctx.questions[-1] == "question number 39"
    assert "question number 30" not in ctx.prompt_block()


def test_window_opening_on_a_reply_drops_the_half_turn():
    rows = turn(1, "first", intent="general")[1:] + turn(3, "second", intent="general")
    assert build_context(rows).questions == ("second",)


def test_length_caps():
    long_q = "tax " * 400
    rows = turn(1, long_q, intent="general") + turn(3, long_q, intent="general") \
        + turn(5, long_q, intent="general")
    ctx = build_context(rows)
    assert all(len(q) <= MAX_QUESTION_CHARS + 2 for q in ctx.questions)
    assert sum(len(q) for q in ctx.questions) <= MAX_CONTEXT_CHARS


def test_second_redaction_pass_scrubs_structured_identifiers():
    rows = turn(1, "My NIC is 199012345678 and mail me at someone@example.com",
                intent="general")
    block = build_context(rows).prompt_block()
    assert "199012345678" not in block
    assert "someone@example.com" not in block
    assert "<NIC>" in block and "<EMAIL>" in block


def test_prompt_block_never_carries_earlier_answers():
    rows = turn(1, "Tax on 5 million?", facts=SALARY_FACTS, run_id="r1",
                reply="Your balance payable is LKR 1,044,000 under band.progressive.")
    ctx = build_context(rows)
    block = ctx.prompt_block()
    assert "1,044,000" not in block
    assert "balance payable" not in block
    assert "facts from run" in ctx.summary()
    assert "5000000" not in ctx.summary()


# ---------------------------------------------------------------------------
# Figure check
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("text,expected", [
    ("salary of 250,000 monthly", {"250000", "3000000"}),
    ("LKR 5 million", {"5000000", "60000000"}),
    ("250k a month", {"250000", "3000000"}),
    ("2026/2027 3,000,000", {"3000000", "36000000"}),
    ("Rs. 2.5 lakhs", {"250000.0", "3000000.0"}),
])
def test_stated_amounts(text, expected):
    assert {str(v) for v in stated_amounts(text)} == expected


def _ctx_with_salary() -> ConversationContext:
    return build_context(turn(1, "How much tax do I pay on LKR 5 million?",
                              facts=SALARY_FACTS, run_id="r1"))


def test_follow_up_that_adds_a_stated_income_traces():
    facts = TaxFacts(ya="2026/2027", employment_income=Decimal("5000000"),
                     business_income=Decimal("500000"))
    assert check_figures(facts, _ctx_with_salary(),
                         "What if I also earn LKR 500,000 from freelance work?") == []


def test_invented_figure_is_untraced():
    facts = TaxFacts(ya="2026/2027", employment_income=Decimal("10000000"))
    assert check_figures(facts, _ctx_with_salary(),
                         "What if my salary doubled?") == ["employment_income"]


def test_monthly_times_twelve_and_carried_plus_stated_trace():
    ctx = _ctx_with_salary()
    monthly = TaxFacts(ya="2026/2027", employment_income=Decimal("4800000"))
    assert check_figures(monthly, ctx, "What if I earned 400,000 a month instead?") == []
    raised = TaxFacts(ya="2026/2027", employment_income=Decimal("5600000"))
    assert check_figures(raised, ctx, "What if I get a 600,000 raise?") == []


def test_zero_always_traces():
    facts = TaxFacts(ya="2026/2027", employment_income=Decimal("5000000"),
                     business_income=Decimal(0))
    assert check_figures(facts, _ctx_with_salary(), "Drop the freelance part") == []


# ---------------------------------------------------------------------------
# Route with context (model call replaced)
# ---------------------------------------------------------------------------

@pytest.fixture
def fake_model(monkeypatch):
    calls: list[dict] = []
    reply: dict = {}

    def structured(schema, system, user, **kwargs):
        calls.append({"system": system, "user": user})
        return schema.model_validate(reply["value"]), llm.LLMCall(model="fake")

    monkeypatch.setattr(llm, "available", lambda: True)
    monkeypatch.setattr(llm, "structured", structured)
    return calls, reply


def test_no_context_leaves_the_prompt_exactly_as_before(fake_model):
    calls, reply = fake_model
    reply["value"] = {"intent": "compute", "in_scope": True,
                      "year_of_assessment": "2026/2027",
                      "facts": {"employment_income": 5000000}}
    intent_mod.route("Tax on LKR 5 million for 2026/2027?",
                     "Tax on LKR 5 million for 2026/2027?", SUPPORTED)
    intent_mod.route("Tax on LKR 5 million for 2026/2027?",
                     "Tax on LKR 5 million for 2026/2027?", SUPPORTED,
                     context=ConversationContext())
    for call in calls:
        assert call["system"] == intent_mod.system_prompt()
        assert call["user"] == "Tax on LKR 5 million for 2026/2027?"


def test_context_reaches_route_as_a_bounded_block(fake_model):
    calls, reply = fake_model
    reply["value"] = {"intent": "compute", "in_scope": True,
                      "year_of_assessment": "2026/2027",
                      "facts": {"employment_income": 5000000, "business_income": 500000}}
    q = "What if I also earn LKR 500,000 from freelance work?"
    routed = intent_mod.route(q, q, SUPPORTED, context=_ctx_with_salary())
    assert calls[0]["system"].startswith(intent_mod.system_prompt())
    assert "CONVERSATION SO FAR" in calls[0]["user"]
    assert calls[0]["user"].endswith("NEW QUESTION:\n" + q)
    assert routed.untraced == []
    assert routed.facts.business_income == Decimal("500000")
    assert any(n.startswith("context:") for n in routed.notes)


def test_untraced_figure_becomes_a_clarifying_question(fake_model):
    _, reply = fake_model
    reply["value"] = {"intent": "compute", "in_scope": True,
                      "year_of_assessment": "2026/2027",
                      "facts": {"employment_income": 10000000}}
    routed = intent_mod.route("What if my salary doubled?", "What if my salary doubled?",
                              SUPPORTED, context=_ctx_with_salary())
    assert routed.untraced == ["employment_income"]
    assert "salary" in routed.untraced_question


def test_unstated_epf_figure_falls_back_to_the_statutory_rule(fake_model):
    _, reply = fake_model
    reply["value"] = {"intent": "compute", "in_scope": True,
                      "year_of_assessment": "2026/2027",
                      "facts": {"employment_income": 5000000, "epf_employee": 400000}}
    routed = intent_mod.route("What about EPF?", "What about EPF?",
                              SUPPORTED, context=_ctx_with_salary())
    assert routed.untraced == []
    assert routed.facts.epf_employee is None


def test_regex_fallback_merges_a_clarification_reply(monkeypatch):
    monkeypatch.setattr(llm, "available", lambda: False)
    ctx = build_context(turn(1, "What do I owe on a salary of LKR 3,000,000?",
                             kind="clarify", ya=None, reply="Which year?"))
    routed = intent_mod.route("2026/2027", "2026/2027", SUPPORTED, context=ctx)
    assert routed.source == "regex"
    assert routed.facts.ya == "2026/2027"
    assert routed.facts.employment_income == Decimal("3000000")


def test_graph_asks_instead_of_computing_an_untraced_figure(fake_model):
    """The clarify path returns before any database access, so no connection
    is needed to prove the guard stops the computation."""
    _, reply = fake_model
    reply["value"] = {"intent": "compute", "in_scope": True,
                      "year_of_assessment": "2026/2027",
                      "facts": {"employment_income": 10000000}}
    result = answer_mod.run_answer_graph(None, "What if my salary doubled?",
                                         context=_ctx_with_salary())
    assert result.kind == "clarify"
    assert result.computation is None
    assert "salary" in result.clarify_question


def test_conversation_year_comes_before_the_sidebar(fake_model):
    _, reply = fake_model
    reply["value"] = {"intent": "compute", "in_scope": True, "facts": {}}
    ctx = build_context(turn(1, "Tax on 5 million?", ya="2025/2026",
                             facts={**SALARY_FACTS, "ya": "2025/2026"}, run_id="r1"))
    result = answer_mod.run_answer_graph(None, "What about it?", ya_override="2026/2027",
                                         context=ctx)
    # Income is missing, so it clarifies before any database access, and the
    # year it would have used is already set.
    assert result.kind == "clarify"
    assert result.ya == "2025/2026"


# ---------------------------------------------------------------------------
# Titles
# ---------------------------------------------------------------------------

def test_compute_title_names_the_income_not_the_amount():
    t = titles.title_for_turn("compute", "answer", "2026/2027", SALARY_FACTS, None, [],
                              "How much tax do I pay on LKR 5 million?")
    assert t == "Tax on employment income · 2026/27"


def test_mixed_income_title():
    t = titles.title_for_turn("compute", "answer", "2026/2027",
                              {**SALARY_FACTS, "business_income": "500000"}, None, [], "")
    assert t == "Tax on mixed income · 2026/27"


def test_other_intent_titles():
    assert titles.title_for_turn("deadline", "answer", "2025/2026", None, None, [], "") \
        == "Filing deadlines · 2025/26"
    assert titles.title_for_turn("obligation", "answer", "2026/2027", None, None, [], "") \
        == "Do I need to file? · 2026/27"
    assert titles.title_for_turn(
        "compare", "answer", "2026/2027", None,
        {"from_ya": "2025/2026", "to_ya": "2026/2027"}, [], "",
    ) == "What changed · 2025/26 → 2026/27"
    assert titles.title_for_turn("rule_lookup", "answer", "2026/2027", None, None,
                                 ["relief.personal"], "") == "Personal relief · 2026/27"


def test_question_title_drops_amounts_and_placeholders():
    t = titles.title_for_turn("general", "answer", "2026/2027", None, None, [],
                              "<PERSON_1> asks: how is LKR 500,000 of interest taxed? Thanks")
    assert "500" not in t and "<" not in t
    assert t == "asks: how is … of interest taxed?"
    kept = titles.from_question("Is EPF at 8% deductible for 2026/2027?")
    assert "8%" in kept and "2026/2027" in kept


def test_refusal_title_is_the_cleaned_question():
    t = titles.title_for_turn("out_of_scope", "refusal", None, None, None, [],
                              "What is the VAT rate on 1,000,000 of sales?")
    assert t == "What is the VAT rate on … of sales?"


def test_title_is_bounded():
    t = titles.from_question("word " * 60)
    assert len(t) <= titles.MAX_TITLE and t.endswith("…")


def test_rename_strips_identifiers():
    assert titles.clean_rename("  Tax for me@example.com  ") == "Tax for <EMAIL>"
    assert titles.clean_rename("   ") == ""
    assert len(titles.clean_rename("x" * 500)) <= titles.MAX_RENAMED_TITLE


# ---------------------------------------------------------------------------
# Envelope
# ---------------------------------------------------------------------------

PAYLOAD = {
    "kind": "answer", "intent": "compute", "plan": ["Intake", "Route"],
    "route_source": "llm", "badge": "all_cited", "ya": "2026/2027",
    "snapshot": {"id": "snap-1", "label": "18 August 2026", "changelog": None},
    "trace": [{"node": "Route", "status": "ok", "detail": "compute via llm", "ms": 5}],
    "latency_ms": 900, "llm": {"calls": [], "total_tokens": 10, "total_ms": 5},
    "computation": {"steps": [], "balance_payable": "1.00"},
    "explanation": "Verified prose.", "verify": {"badge": "all_cited", "ok": True},
    "citations": [{"rule_key": "relief.personal"}], "passages": [], "run_id": "run-1",
}


def test_split_leaves_run_fields_to_the_run():
    kind, content, env = envelope.split(PAYLOAD, "run-1")
    assert kind == "answer" and content == "Verified prose."
    for f in ("computation", "explanation", "verify", "snapshot", "llm", "run_id"):
        assert f not in env
    assert env["citations"] == PAYLOAD["citations"]
    assert env["trace"] == PAYLOAD["trace"]


def test_split_keeps_everything_but_usage_when_there_is_no_run():
    _, _, env = envelope.split(PAYLOAD, None)
    assert env["computation"] == PAYLOAD["computation"]
    assert env["snapshot"] == PAYLOAD["snapshot"]
    assert "llm" not in env and "run_id" not in env


def test_split_refusal_and_clarify_content():
    refusal = {"kind": "refusal", "refusal": {"reason": "Out of scope."}}
    clarify = {"kind": "clarify", "clarify": {"question": "Which year?"}}
    assert envelope.split(refusal, None)[1] == "Out of scope."
    assert envelope.split(clarify, None)[1] == "Which year?"


def test_rehydrate_reads_authoritative_fields_from_the_run():
    _, content, env = envelope.split(PAYLOAD, "run-1")
    run = {
        "id": "run-1", "ya": "2026/2027",
        "ledger_json": {"steps": [], "balance_payable": "1.00"},
        "answer_text": "Verified prose.", "verify_result": {"badge": "partial"},
        "llm_usage": {"total_tokens": 10}, "corpus_snapshot_id": "snap-old",
        "snapshot_label": "1 April 2026", "snapshot_changelog": None,
    }
    out = envelope.rehydrate({"kind": "answer", "content": content, "response_json": env},
                             run, current_snapshot_id="snap-new")
    assert out["computation"] == run["ledger_json"]
    assert out["explanation"] == "Verified prose."
    assert out["badge"] == "partial"
    assert out["snapshot"]["label"] == "1 April 2026"
    assert out["snapshot_is_current"] is False
    assert out["reaskable"] is True
    assert out["run_id"] == "run-1"
    assert out["citations"] == PAYLOAD["citations"]


def test_rehydrate_without_a_run_is_not_reaskable():
    _, content, env = envelope.split({"kind": "clarify", "clarify": {"question": "Q?"},
                                      "snapshot": None}, None)
    out = envelope.rehydrate({"kind": "clarify", "content": content, "response_json": env},
                             None, current_snapshot_id="snap")
    assert out["reaskable"] is False
    assert out["snapshot_is_current"] is None
    assert out["clarify"] == {"question": "Q?"}
