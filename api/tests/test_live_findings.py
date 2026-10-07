"""Regressions from the second live routine against Groq (#100)."""

from __future__ import annotations

from decimal import Decimal

import pytest

from app.compute.types import TaxFacts
from app.conversations.context import ConversationContext, apit_is_stale
from app.core import llm
from app.graph import intent as intent_mod
from app.graph.explain import _describe_value
from app.graph.verify import Evidence, verify
from tests.test_engine import _rules

SUPPORTED = ("2025/2026", "2026/2027")
D = Decimal


# --- the band table in one sentence ------------------------------------------

def _bands_evidence() -> Evidence:
    return Evidence(extra_rules=[_rules()["band.progressive"]])


def test_a_sentence_listing_every_band_is_traced():
    """The model wrote the whole table in one sentence, with narrow no-break
    spaces, and the check held its first rate to its last edge."""
    s = ("For the year of assessment 2026/2027 the progressive tax bands are up to LKR 1,000,000 "
         "at 6 %, up to LKR 1,500,000 at 18 %, up to LKR 2,000,000 at 24 %, "
         "up to LKR 2,500,000 at 30 %, and any amount above LKR 2,500,000 at 36 %.")
    assert verify(s, _bands_evidence()).unmatched_numbers == []


def test_a_wrong_rate_in_a_band_list_is_still_caught():
    s = ("The bands are up to LKR 1,000,000 at 6%, up to LKR 1,500,000 at 24%, "
         "and above LKR 2,500,000 at 36%.")
    assert verify(s, _bands_evidence()).unmatched_numbers


def test_a_single_band_sentence_is_held_as_before():
    assert verify("Income above LKR 2,500,000 is taxed at 6%.", _bands_evidence()).unmatched_numbers


# --- the name of a law is not a figure ----------------------------------------

def test_an_act_name_is_not_a_figure():
    s = "It amends the Inland Revenue Act, No. 24 of 2017 and Amendment No. 2 of 2025."
    assert verify(s, Evidence()).unmatched_numbers == []


def test_a_bare_year_is_still_checked():
    assert "2017" in verify("The rate changed in 2017.", Evidence()).unmatched_numbers


# --- EPF said in words --------------------------------------------------------

def test_a_non_deductible_epf_rule_is_described_as_not_deductible():
    """With only "8%" to go on, the model said EPF was allowed as a deduction."""
    text = _describe_value("deduction.epf_employee", {"employee_rate": "0.08", "deductible": False})
    assert "NOT deductible" in text and "8.00%" in text


def test_a_deductible_epf_rule_says_so():
    assert "deductible from" in _describe_value("deduction.epf_employee", {"employee_rate": "0.08"})


# --- APIT follows the salary --------------------------------------------------

def _ctx(**facts) -> ConversationContext:
    return ConversationContext(facts={k: D(v) for k, v in facts.items()})


def test_a_carried_apit_does_not_follow_a_new_salary():
    facts = TaxFacts(employment_income=D("4800000"), apit_withheld=D("96000"))
    ctx = _ctx(employment_income="3000000", apit_withheld="96000")
    assert apit_is_stale(facts, ctx, "what if my salary was 400k a month instead?")


def test_an_apit_stated_with_the_new_salary_stays():
    facts = TaxFacts(employment_income=D("4800000"), apit_withheld=D("96000"))
    ctx = _ctx(employment_income="3000000", apit_withheld="96000")
    assert not apit_is_stale(facts, ctx, "if my salary was 400k and APIT was 96,000?")


def test_a_carried_apit_on_the_same_salary_stays():
    facts = TaxFacts(employment_income=D("3000000"), business_income=D("5000000"), apit_withheld=D("96000"))
    ctx = _ctx(employment_income="3000000", apit_withheld="96000")
    assert not apit_is_stale(facts, ctx, "I make 5000000 more with freelancing")


# --- a circular is not corporate tax ------------------------------------------

@pytest.fixture
def model_says(monkeypatch):
    reply: dict = {}

    def structured(schema, system, user, **kwargs):
        return schema.model_validate(reply["value"]), llm.LLMCall(model="fake")

    monkeypatch.setattr(llm, "available", lambda: True)
    monkeypatch.setattr(llm, "structured", structured)
    return reply


def _refused_as_corporate(reply):
    reply["value"] = {"intent": "out_of_scope", "in_scope": False, "scope_category": "corporate",
                      "scope_reason": "Question about a tax circular, not personal income tax"}


def test_a_circular_on_apit_refused_as_corporate_is_answered(model_says):
    _refused_as_corporate(model_says)
    q = "What is the revised quarterly tax circular SEC/2026/E/06 about?"
    r = intent_mod.route(q, q, SUPPORTED)
    assert (r.routed.in_scope, r.routed.intent) == (True, "general")


def test_a_company_question_refused_as_corporate_stays_refused(model_says):
    _refused_as_corporate(model_says)
    q = "How is the income of my private limited company taxed?"
    r = intent_mod.route(q, q, SUPPORTED)
    assert r.routed.in_scope is False and r.routed.scope_category == "corporate"
