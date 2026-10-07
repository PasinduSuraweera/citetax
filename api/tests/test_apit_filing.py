"""APIT on a salary, and who need not file (Act s.83A, s.94(1)(c) and (d)).

A salaried person whose employer deducts APIT every month owes nothing more
at the end of the year and files no return. The ledger used to treat an
unstated APIT as nil and ask for the whole year's tax again.
"""

from __future__ import annotations

from decimal import Decimal

from app.compute.engine import compute
from app.compute.types import TaxFacts
from app.graph import comply
from tests.test_engine import _rules

D = Decimal
NOT_DEDUCTIBLE = {"deduction.epf_employee": {"employee_rate": "0.08", "deductible": False}}
DEADLINE = {"deadline.return_filing": {"due": "2027-11-30", "instalments": ["2026-08-15", "2026-11-15"]}}
EXEMPTION = {"filing.apit_exemption": {"interest_limit": "5000"}}


def _law(**extra):
    return _rules(**NOT_DEDUCTIBLE, **DEADLINE, **extra)


def _apit(c):
    return next(s for s in c.steps if s.rule_key == "credit.apit")


def test_a_stated_apit_is_used_as_given():
    c = compute(TaxFacts(ya="2026/2027", employment_income=D("3000000"), apit_withheld=D("50000")), _law())
    assert (_apit(c).value, c.balance_payable) == (D("50000.00"), D("46000.00"))
    assert not (_apit(c).detail or {}).get("assumed")


def test_a_stated_nil_apit_is_not_assumed_away():
    c = compute(TaxFacts(ya="2026/2027", employment_income=D("3000000"), apit_withheld=D("0")), _law())
    assert c.balance_payable == D("96000.00")


def test_the_assumed_apit_covers_the_salary_and_not_the_freelance_income():
    """250,000 a month and 5,000,000 freelancing: the employer's APIT is the
    tax on the salary alone, 96,000; the rest of the tax is the balance."""
    facts = TaxFacts(ya="2026/2027", employment_income=D("3000000"), business_income=D("5000000"))
    c = compute(facts, _law())
    apit = _apit(c)
    assert (apit.value, apit.detail["assumed"]) == (D("96000.00"), True)
    assert c.balance_payable == c.gross_tax - D("96000.00")


def test_the_assumed_apit_never_makes_a_refund():
    facts = TaxFacts(ya="2026/2027", employment_income=D("3000000"), qualifying_payments=D("600000"))
    c = compute(facts, _law())
    assert c.balance_payable == 0 and _apit(c).value == c.gross_tax


def test_no_salary_no_apit():
    c = compute(TaxFacts(ya="2026/2027", business_income=D("4000000")), _law())
    assert _apit(c).value == 0 and not (_apit(c).detail or {}).get("assumed")


def test_a_salary_within_the_relief_assumes_nothing():
    c = compute(TaxFacts(ya="2026/2027", employment_income=D("1500000")), _law())
    assert _apit(c).value == 0 and _apit(c).detail["assumed"] is False


def _filing(facts, rules):
    return comply.assess(compute(facts, rules), rules)


def test_an_apit_only_employee_need_not_file():
    cp = _filing(TaxFacts(ya="2026/2027", employment_income=D("3000000")), _law(**EXEMPTION))
    assert cp.must_file is False and cp.instalments == []
    assert cp.citation_label == "cite-filing.apit_exemption"


def test_without_the_published_rule_the_old_obligation_stands():
    """The exemption is law, but Citetax applies it only once its rule is
    signed and published, like every other rule."""
    cp = _filing(TaxFacts(ya="2026/2027", employment_income=D("3000000")), _law())
    assert cp.must_file is True


def test_interest_within_the_limit_keeps_the_exemption():
    facts = TaxFacts(ya="2026/2027", employment_income=D("3000000"), investment_income=D("4000"))
    assert _filing(facts, _law(**EXEMPTION)).must_file is False


def test_interest_over_the_limit_means_a_return():
    facts = TaxFacts(ya="2026/2027", employment_income=D("3000000"), investment_income=D("6000"))
    assert _filing(facts, _law(**EXEMPTION)).must_file is True


def test_any_business_income_means_a_return():
    facts = TaxFacts(ya="2026/2027", employment_income=D("3000000"), business_income=D("500000"))
    cp = _filing(facts, _law(**EXEMPTION))
    assert cp.must_file is True and cp.instalments


def test_apit_short_of_the_tax_means_a_return():
    """s.94(1)(c) needs no tax left payable under s.82(2)."""
    facts = TaxFacts(ya="2026/2027", employment_income=D("3000000"), apit_withheld=D("50000"))
    assert _filing(facts, _law(**EXEMPTION)).must_file is True


def test_a_stated_nil_apit_means_a_return():
    facts = TaxFacts(ya="2026/2027", employment_income=D("3000000"), apit_withheld=D("0"))
    assert _filing(facts, _law(**EXEMPTION)).must_file is True


def test_apit_beyond_the_tax_still_points_to_the_refund():
    facts = TaxFacts(ya="2026/2027", employment_income=D("3000000"), apit_withheld=D("120000"))
    cp = _filing(facts, _law(**EXEMPTION))
    assert cp.must_file is True and "refund" in cp.reason and cp.instalments == []
