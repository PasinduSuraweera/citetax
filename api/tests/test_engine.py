"""Compute engine tests — spec §11, target 100% (a single mismatch blocks release).

Rules used here are the real ones: Inland Revenue (Amendment) Act No. 2 of 2025,
first 1,000,000 @ 6%, then 500,000 bands @ 18/24/30%, balance @ 36%,
personal relief 1,800,000.

No database and no network — the engine takes a ResolvedRuleSet and nothing else,
which is the whole point of spec §4.3.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest

from app.compute.engine import compute, compute_band_tax
from app.compute.types import TaxFacts
from app.rules.resolver import ResolvedRuleSet, RuleVersion, UnresolvedRule

BANDS = [
    {"upto": 1000000, "rate": "0.06"},
    {"upto": 1500000, "rate": "0.18"},
    {"upto": 2000000, "rate": "0.24"},
    {"upto": 2500000, "rate": "0.30"},
    {"upto": None,    "rate": "0.36"},
]

_VALUES = {
    "income.assessable":     {"includes": ["employment"]},
    "deduction.epf_employee": {"employee_rate": "0.08"},
    "deduction.qualifying":  {"annual_cap": None},
    "relief.personal":       {"amount": "1800000"},
    "charge.taxable_income": {"formula": "assessable - deductions - relief"},
    "band.progressive":      {"bands": BANDS},
    "credit.foreign_wht":    {"allowed": True},
    "credit.apit":           {"allowed": True},
}


def _rules(ya: str = "2026/2027", **overrides) -> ResolvedRuleSet:
    values = {**_VALUES, **overrides}
    rs = ResolvedRuleSet(ya=ya, snapshot_id="test-snapshot")
    for i, (key, val) in enumerate(values.items()):
        rs.rules[key] = RuleVersion(
            id=f"rv-{i}",
            rule_key=key,
            revision_no=1,
            value_json=val,
            effective_from=date(2025, 4, 1),
            effective_to=None,
            citation_label=f"cite-{key}",
            quoted_text="…",
        )
    return rs


# ---------------------------------------------------------------------------
# Band table
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "taxable,expected",
    [
        ("0",       "0"),
        ("500000",  "30000"),      # 500k @ 6%
        ("1000000", "60000"),      # full first band
        ("1500000", "150000"),     # 60,000 + 500k@18% = 90,000
        ("2000000", "270000"),     # +500k@24% = 120,000
        ("2500000", "420000"),     # +500k@30% = 150,000
        ("3000000", "600000"),     # +500k@36% = 180,000
    ],
)
def test_band_boundaries(taxable, expected):
    """Every band edge, which is where off-by-one errors live."""
    rule = _rules()["band.progressive"]
    gross, _ = compute_band_tax(Decimal(taxable), rule)
    assert gross == Decimal(expected)


def test_band_breakdown_is_itemised():
    rule = _rules()["band.progressive"]
    gross, rows = compute_band_tax(Decimal("1200000"), rule)
    assert gross == Decimal("96000")     # 60,000 + 200k @ 18% = 36,000
    assert len(rows) == 2
    assert rows[0]["rate"] == "0.06"
    assert rows[1]["tax"] == "36000.00"


# ---------------------------------------------------------------------------
# Full ledger
# ---------------------------------------------------------------------------

def test_salaried_3m_with_apit():
    """LKR 250,000/month = 3,000,000/year, EPF deducted, APIT withheld.

    3,000,000 − 240,000 EPF − 1,800,000 relief = 960,000 taxable
    960,000 is inside the 6% band → 57,600 gross tax
    """
    facts = TaxFacts(
        ya="2026/2027",
        employment_income=Decimal("3000000"),
        apit_withheld=Decimal("57600"),
    )
    c = compute(facts, _rules())

    assert c.steps[0].value == Decimal("3000000.00")   # assessable
    assert c.steps[1].value == Decimal("240000.00")    # EPF 8%
    assert c.steps[3].value == Decimal("1800000.00")   # relief
    assert c.taxable_income == Decimal("960000.00")
    assert c.gross_tax == Decimal("57600.00")
    assert c.balance_payable == Decimal("0.00")        # APIT exactly covers it


def test_ledger_always_has_eight_steps():
    """Spec §6.2 #4 — zero-value steps render greyed, never dropped, so the
    headline step count always matches the visible table."""
    facts = TaxFacts(ya="2026/2027", employment_income=Decimal("2000000"))
    c = compute(facts, _rules())

    assert len(c.steps) == 8
    assert [s.step_no for s in c.steps] == [1, 2, 3, 4, 5, 6, 7, 8]
    # No qualifying payments and no credits were supplied, so those are zero
    # but still present and still cited.
    zero_steps = [s for s in c.steps if s.is_zero]
    assert {s.rule_key for s in zero_steps} >= {
        "deduction.qualifying", "credit.foreign_wht"
    }
    assert all(s.rule_version_id for s in c.steps), "every step must cite a rule"


def test_below_relief_threshold_pays_nothing():
    """1,500,000 salary: after EPF and 1.8M relief there is no taxable income."""
    facts = TaxFacts(ya="2026/2027", employment_income=Decimal("1500000"))
    c = compute(facts, _rules())
    assert c.taxable_income == Decimal("0.00")
    assert c.gross_tax == Decimal("0.00")
    assert c.balance_payable == Decimal("0.00")


def test_relief_cannot_create_a_loss():
    facts = TaxFacts(ya="2026/2027", employment_income=Decimal("500000"))
    c = compute(facts, _rules())
    assert c.taxable_income == Decimal("0.00")
    assert c.steps[3].value <= Decimal("500000")


def test_overwithheld_apit_produces_refund():
    facts = TaxFacts(
        ya="2026/2027",
        employment_income=Decimal("3000000"),
        apit_withheld=Decimal("100000"),
    )
    c = compute(facts, _rules())
    assert c.balance_payable == Decimal("-42400.00")   # 57,600 − 100,000
    assert c.is_refund is True


def test_epf_capped_at_statutory_rate():
    """A user claiming more EPF than 8% of employment income is capped."""
    facts = TaxFacts(
        ya="2026/2027",
        employment_income=Decimal("3000000"),
        epf_employee=Decimal("900000"),
    )
    c = compute(facts, _rules())
    assert c.steps[1].value == Decimal("240000.00")


def test_mixed_income_sums_into_assessable():
    facts = TaxFacts(
        ya="2026/2027",
        employment_income=Decimal("2000000"),
        business_income=Decimal("1000000"),
        investment_income=Decimal("500000"),
    )
    c = compute(facts, _rules())
    assert c.steps[0].value == Decimal("3500000.00")
    # EPF applies to employment income only: 8% of 2,000,000
    assert c.steps[1].value == Decimal("160000.00")


def test_credits_cannot_exceed_gross_tax():
    facts = TaxFacts(
        ya="2026/2027",
        employment_income=Decimal("3000000"),
        foreign_tax_credit=Decimal("999999"),
    )
    c = compute(facts, _rules())
    assert c.steps[6].value == c.gross_tax


def test_every_step_carries_a_rule_version_id():
    """Citation completeness is 100% by construction (spec §11)."""
    facts = TaxFacts(ya="2026/2027", employment_income=Decimal("3000000"))
    c = compute(facts, _rules())
    assert len(c.rule_version_ids) == 8
    assert all(s.rule_version_id is not None for s in c.steps)


def test_missing_rule_refuses_rather_than_guessing():
    """Spec §3.6 — silence is a valid answer; a guess is not."""
    rs = _rules()
    del rs.rules["band.progressive"]
    with pytest.raises(UnresolvedRule):
        compute(TaxFacts(ya="2026/2027", employment_income=Decimal("3000000")), rs)


def test_engine_makes_no_network_calls():
    """The engine must be importable and runnable with sockets disabled."""
    import socket

    original = socket.socket

    def blocked(*a, **kw):
        raise AssertionError("compute engine attempted a network call")

    socket.socket = blocked
    try:
        facts = TaxFacts(ya="2026/2027", employment_income=Decimal("3000000"))
        c = compute(facts, _rules())
        assert c.balance_payable is not None
    finally:
        socket.socket = original


# ---------------------------------------------------------------------------
# TaxFacts
# ---------------------------------------------------------------------------

def test_taxfacts_reports_missing_fields_for_clarify_node():
    assert "ya" in TaxFacts().missing_required()
    assert "income" in TaxFacts(ya="2026/2027").missing_required()
    assert TaxFacts(
        ya="2026/2027", employment_income=Decimal("3000000")
    ).missing_required() == []


def test_taxfacts_has_no_identity_fields():
    """Spec §9.1 minimisation — the boundary object carries no identifiers."""
    forbidden = {"name", "nic", "tin", "employer", "address", "phone", "email"}
    assert forbidden & set(TaxFacts.model_fields) == set()


def test_relief_step_carries_statutory_and_applied_when_capped():
    """Below the threshold the ledger applies less relief than the law grants.
    Both figures must travel so an explanation cannot call the capped amount
    'the personal relief'."""
    c = compute(TaxFacts(ya="2026/2027", employment_income=Decimal("1500000")), _rules())
    relief = next(s for s in c.steps if s.rule_key == "relief.personal")
    assert relief.value == Decimal("1380000.00")
    assert relief.detail == {"statutory": "1800000", "applied": "1380000.00", "capped": True}

    c_hi = compute(TaxFacts(ya="2026/2027", employment_income=Decimal("3000000")), _rules())
    relief_hi = next(s for s in c_hi.steps if s.rule_key == "relief.personal")
    assert relief_hi.value == Decimal("1800000.00")
    assert relief_hi.detail["capped"] is False
