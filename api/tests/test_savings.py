"""Ways to pay less. Expected figures are worked by hand from the real bands
(6/18/24/30/36%, relief 1,800,000) and checked against the engine."""

from __future__ import annotations

from decimal import Decimal

from app.compute.engine import compute
from app.compute.savings import analyse
from app.compute.types import TaxFacts
from tests.test_engine import IRD_LAW, _rules

D = Decimal


def _kinds(facts: TaxFacts, rules=None):
    rules = rules or _rules(**IRD_LAW)
    found = analyse(facts, rules, compute(facts, rules))
    return {s.kind: s for s in found}


def test_a_plain_salary_has_nothing_to_suggest():
    assert _kinds(TaxFacts(ya="2026/2027", employment_income=D("3000000"))) == {}


def test_business_expenses_saving_is_the_tax_on_the_top_slice():
    # 4,000,000 - 1,800,000 relief = 2,200,000 taxable, its top slice at 30%:
    # 100,000 of expenses saves 30,000.
    s = _kinds(TaxFacts(ya="2026/2027", business_income=D("4000000")))["business_expenses"]
    assert "LKR 100,000" in s.text and "LKR 30,000" in s.text
    assert s.citation_label


def test_no_expenses_item_when_they_are_stated_or_the_rule_is_not_in_force():
    stated = TaxFacts(ya="2026/2027", business_income=D("4000000"), business_expenses=D("500000"))
    assert "business_expenses" not in _kinds(stated)
    no_rule = _rules(**{k: v for k, v in IRD_LAW.items() if k != "deduction.business_expenses"})
    assert "business_expenses" not in _kinds(TaxFacts(ya="2026/2027", business_income=D("4000000")), no_rule)


def test_stated_apit_above_the_tax_is_a_refund_to_claim():
    # 3,000,000 - 1,800,000 = 1,200,000 taxable: 60,000 + 36,000 = 96,000.
    # APIT of 500,000 leaves 404,000 to claim back.
    s = _kinds(TaxFacts(ya="2026/2027", employment_income=D("3000000"), apit_withheld=D("500000")))["apit_refund"]
    assert "LKR 404,000" in s.text


def test_an_assumed_apit_never_suggests_a_refund():
    assert "apit_refund" not in _kinds(TaxFacts(ya="2026/2027", employment_income=D("3000000")))


def test_interest_without_withholding_tax_suggests_adding_it():
    facts = TaxFacts(ya="2026/2027", business_income=D("3000000"), investment_income=D("140000"))
    assert "wht_credit" in _kinds(facts)
    assert "wht_credit" not in _kinds(facts.model_copy(update={"wht_credit": D("14000")}))
