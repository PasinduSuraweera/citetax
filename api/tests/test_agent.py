"""Planner, retrieval and extractor tests that need no network.

The LLM paths are exercised by smoke_test.py against the live model. These
tests cover the deterministic fallback route, the chunker, the verify node on
non compute intents, and the extractor's schema contract.
"""

from __future__ import annotations

from datetime import date

from app.corpus.extractor import RULE_SHAPES, Extraction, ProposedChange
from app.corpus.pdf import html_to_text
from app.graph.answer import PLANS
from app.graph.intent import RoutedQuestion, _regex_route, _to_facts
from app.graph.verify import Evidence, verify
from app.retrieval.chunker import chunk_text
from app.retrieval.search import Passage
from app.rules.resolver import RuleVersion

SUPPORTED = ("2025/2026", "2026/2027")


# ---------------------------------------------------------------------------
# Planner: every intent has a plan, and the regex route picks sensible intents
# ---------------------------------------------------------------------------

def test_every_intent_has_a_plan_ending_in_verify_or_refusal():
    for intent, plan in PLANS.items():
        assert plan[0] == "Intake" and plan[1] == "Route"
        if intent == "out_of_scope":
            assert plan == ["Intake", "Route"]
        else:
            assert plan[-1] == "Verify", f"{intent} must end in Verify"
            assert "Explain" in plan


def test_plans_differ_by_intent():
    """The point of the planner: not the same workflow every time."""
    assert "Compute" in PLANS["compute"]
    assert "Compute" not in PLANS["deadline"]
    assert "Compare" in PLANS["compare"]
    assert "Compare" not in PLANS["compute"]
    assert PLANS["general"].index("Retrieve") < PLANS["general"].index("Resolve")


def test_regex_route_deadline_question():
    r = _regex_route("When is my return due for 2026/2027?", SUPPORTED)
    assert r.routed.intent == "deadline"
    assert r.routed.in_scope is True
    assert r.routed.missing == []


def test_regex_route_compare_question():
    r = _regex_route("What changed between 2025/2026 and 2026/2027?", SUPPORTED)
    assert r.routed.intent == "compare"


def test_regex_route_compute_with_missing_year_asks_one_question():
    r = _regex_route("How much tax do I owe on 3,000,000 a year?", SUPPORTED)
    assert r.routed.intent == "compute"
    assert r.routed.missing == ["year_of_assessment"]
    assert r.routed.clarify_question and "year" in r.routed.clarify_question.lower()


def test_regex_route_refuses_vat():
    r = _regex_route("How do I register for VAT?", SUPPORTED)
    assert r.routed.intent == "out_of_scope"
    assert r.routed.scope_category == "VAT"


def test_employee_side_apit_question_is_in_scope_for_the_regex_gate():
    """The model once read 'for a salaried employee' as the employer's side.
    The regex employer pattern is explicit and must not fire here, so the
    cross check in route() can downgrade that refusal to a general answer."""
    from app.graph.scope import check_scope, looks_like_tax_question

    q = "How does APIT work for a salaried employee?"
    assert check_scope(q, None, SUPPORTED).in_scope is True
    assert looks_like_tax_question(q) is True


def test_llm_facts_convert_to_decimal_without_float_drift():
    routed = RoutedQuestion(
        intent="compute", in_scope=True, year_of_assessment="2026/2027",
        facts={"employment_income": 3000000.0, "apit_withheld": 57600.0},
    )
    f = _to_facts(routed, SUPPORTED)
    assert str(f.employment_income) == "3000000.0" or f.employment_income == 3000000
    assert f.apit_withheld == 57600
    assert f.ya == "2026/2027"
    assert f.epf_employee is None


def test_unsupported_year_from_model_is_not_accepted_as_ya():
    routed = RoutedQuestion(intent="compute", in_scope=True, year_of_assessment="2019/2020")
    f = _to_facts(routed, SUPPORTED)
    assert f.ya is None


# ---------------------------------------------------------------------------
# Verify on non compute intents
# ---------------------------------------------------------------------------

def _deadline_rule() -> RuleVersion:
    return RuleVersion(
        id="rv-d", rule_key="deadline.return_filing", revision_no=1,
        value_json={"due": "2027-11-30", "instalments": ["2026-08-15", "2026-11-15"]},
        effective_from=date(2026, 4, 1), effective_to=date(2027, 3, 31),
        citation_label="Act s.93",
        quoted_text="A return shall be furnished on or before the thirtieth day of November.",
    )


def test_verify_accepts_dates_from_the_deadline_rule():
    ev = Evidence(extra_rules=[_deadline_rule()])
    r = verify(
        "Your return for 2026/2027 is due on 30 November 2027 (Act s.93), with the "
        "first instalment on 15 August 2026.", ev,
    )
    assert r.ok is True, r.unmatched_numbers


def test_verify_blocks_a_date_not_in_the_rule():
    ev = Evidence(extra_rules=[_deadline_rule()])
    r = verify("Your return is due on 31 December 2027.", ev, attempt=2)
    assert r.ok is False
    assert any("December" in u for u in r.unmatched_numbers)


def test_verify_accepts_figures_that_appear_in_a_retrieved_passage():
    passage = Passage(
        chunk_id="c1", text="The personal relief is Rs. 1,800,000 for each year.",
        source_document_id=None, rule_key="relief.personal", title="Guide",
        url=None, score=0.1, matched_by="fts",
    )
    ev = Evidence(passages=[passage])
    assert verify("Personal relief is LKR 1,800,000 (Guide).", ev).ok is True


def test_verify_blocks_a_figure_not_in_any_evidence():
    passage = Passage(
        chunk_id="c1", text="The personal relief is Rs. 1,800,000.",
        source_document_id=None, rule_key=None, title=None, url=None,
        score=0.1, matched_by="fts",
    )
    r = verify("Personal relief is LKR 2,400,000.", Evidence(passages=[passage]), attempt=2)
    assert r.ok is False
    assert "LKR 2,400,000" in r.unmatched_numbers


def test_verify_accepts_days_remaining():
    ev = Evidence(extra_rules=[_deadline_rule()], days_remaining=447)
    assert verify("That is 447 days from today.", ev).ok is True


def test_verify_accepts_ordinal_and_abbreviated_dates():
    ev = Evidence(extra_rules=[_deadline_rule()])
    assert verify("Due on 30th November 2027.", ev).ok is True
    assert verify("Due 30 Nov 2027, first instalment Aug 15, 2026.", ev).ok is True


def test_verify_accepts_million_form_of_a_ledger_figure():
    relief = RuleVersion(
        id="rv-r", rule_key="relief.personal", revision_no=1,
        value_json={"amount": "1800000"}, effective_from=date(2025, 4, 1),
        effective_to=None, citation_label="Act s.52", quoted_text=None,
    )
    ev = Evidence(extra_rules=[relief])
    assert verify("Personal relief is LKR 1.8 million (Act s.52).", ev).ok is True
    assert verify("Personal relief is 18 lakhs.", ev).ok is True
    r = verify("Personal relief is 2.4 million.", ev, attempt=2)
    assert r.ok is False and "2.4 million" in r.unmatched_numbers


# ---------------------------------------------------------------------------
# Retrieval chunker
# ---------------------------------------------------------------------------

def test_chunker_short_text_is_one_chunk():
    chunks = chunk_text("Personal relief is Rs. 1,800,000.")
    assert len(chunks) == 1
    assert chunks[0].ordinal == 0


def test_chunker_splits_long_text_with_overlap():
    sentences = [f"Section {i} provides that the amount is {i * 1000}." for i in range(1, 60)]
    text = " ".join(sentences)
    chunks = chunk_text(text, target_chars=400, overlap_sentences=1)
    assert len(chunks) > 3
    for c in chunks:
        assert len(c.text) <= 520   # target plus one overlapping sentence
    # Overlap: the last sentence of chunk n opens chunk n+1.
    last_sentence = chunks[0].text.rsplit(". ", 1)[-1].rstrip(".")
    assert last_sentence[:20] in chunks[1].text


def test_chunker_empty_input():
    assert chunk_text("") == []
    assert chunk_text("   \n  ") == []


# ---------------------------------------------------------------------------
# Extractor contract
# ---------------------------------------------------------------------------

def test_extractor_shapes_cover_every_compute_rule_key():
    from app.compute.engine import REQUIRED_RULE_KEYS

    for key in REQUIRED_RULE_KEYS + ["deadline.return_filing"]:
        assert key in RULE_SHAPES, f"{key} has no shape for the extractor"


def test_extraction_schema_round_trips():
    ex = Extraction(
        document_summary="A circular raising personal relief.",
        document_kind="circular",
        relevant_to_personal_income_tax=True,
        published_date="2026-08-06",
        proposals=[
            ProposedChange(
                rule_key="relief.personal", operation="amend",
                value_json={"amount": "2400000"}, effective_from="2026-08-06",
                applies_to_ya=["2026/2027"],
                quoted_text="The personal relief shall be Rs. 2,400,000.",
                citation_label="Circular 2026/08", confidence=0.93,
                rationale="Explicit amount, explicit date.",
            )
        ],
    )
    dumped = ex.model_dump_json()
    back = Extraction.model_validate_json(dumped)
    assert back.proposals[0].value_json["amount"] == "2400000"
    assert back.proposals[0].confidence == 0.93


# ---------------------------------------------------------------------------
# Document text
# ---------------------------------------------------------------------------

def test_html_to_text_keeps_paragraphs_and_drops_scripts():
    html = (
        "<html><head><script>alert(1)</script><style>p{}</style></head>"
        "<body><h1>Notice</h1><p>Relief is Rs. 1,800,000.</p>"
        "<p>Effective 1 April 2025.</p></body></html>"
    )
    out = html_to_text(html)
    assert "alert" not in out
    assert "Notice" in out
    assert "Relief is Rs. 1,800,000." in out
    assert "\n" in out   # paragraph structure survived
