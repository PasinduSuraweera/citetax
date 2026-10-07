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


# ---------------------------------------------------------------------------
# EPF (#47): the employee's contribution is not deductible (IRA s.10(1)(a))
# ---------------------------------------------------------------------------

NOT_DEDUCTIBLE = {"deduction.epf_employee": {"employee_rate": "0.08", "deductible": False}}


@pytest.mark.parametrize(
    "salary,balance",
    [
        # LKR 400,000 a month: the IRD's APIT Table 01 formula for 2025/26,
        # 400,000 x 36% - 94,000 = 50,000 a month, is 600,000 for the year.
        ("4800000", "600000.00"),
        # 3,000,000 - 1,800,000 relief = 1,200,000: 60,000 + 200,000 x 18%.
        ("3000000", "96000.00"),
    ],
)
def test_epf_not_deductible_matches_the_ird_apit_figures(salary, balance):
    facts = TaxFacts(ya="2026/2027", employment_income=Decimal(salary))
    c = compute(facts, _rules(**NOT_DEDUCTIBLE))
    assert str(c.balance_payable) == balance
    epf = next(s for s in c.steps if s.rule_key == "deduction.epf_employee")
    # Kept in the ledger, at zero and cited, so the user sees why.
    assert (epf.value, epf.label) == (Decimal("0"), "EPF employee contribution, not deductible")
    assert epf.rule_version_id is not None


def test_a_stated_epf_figure_is_shown_but_not_deducted():
    facts = TaxFacts(ya="2026/2027", employment_income=Decimal("3000000"), epf_employee=Decimal("240000"))
    c = compute(facts, _rules(**NOT_DEDUCTIBLE))
    epf = next(s for s in c.steps if s.rule_key == "deduction.epf_employee")
    assert epf.detail["contribution"] == "240000.00" and epf.value == 0
    assert str(c.taxable_income) == "1200000.00"


def test_an_old_rule_version_still_deducts_and_marks_the_default_as_assumed():
    """Until the corrected rule is signed and published, the published rule
    decides; the code never changes the law on its own."""
    c = compute(TaxFacts(ya="2026/2027", employment_income=Decimal("3000000")), _rules())
    epf = next(s for s in c.steps if s.rule_key == "deduction.epf_employee")
    assert epf.value == Decimal("240000.00") and epf.detail["assumed"] is True
    stated = compute(TaxFacts(ya="2026/2027", employment_income=Decimal("3000000"),
                              epf_employee=Decimal("240000")), _rules())
    assert next(s for s in stated.steps if s.rule_key == "deduction.epf_employee").detail["assumed"] is False


# ---------------------------------------------------------------------------
# The IRD's own worked examples: Guide to the Return of Income, Year of
# Assessment 2025/2026 (Asmt_IIT_004_2025_2026_E), Illustrations 1 to 3.
# Expected figures are the IRD's, not ours (#47, #48).
# ---------------------------------------------------------------------------

IRD_LAW = {
    "deduction.epf_employee": {"employee_rate": "0.08", "deductible": False},
    "deduction.business_expenses": {"capital_excluded": True},
    "band.foreign_service_cap": {"max_rate": "0.15"},
}


def test_ird_example_1_salary_and_interest():
    """Ms Yohani: salary 240,000 a month, interest 140,000, APIT 74,400, WHT 14,000."""
    facts = TaxFacts(ya="2025/2026", employment_income=Decimal("2880000"),
                     investment_income=Decimal("140000"), apit_withheld=Decimal("74400"),
                     wht_credit=Decimal("14000"))
    c = compute(facts, _rules("2025/2026", **IRD_LAW))
    assert (c.taxable_income, c.gross_tax, c.balance_payable) == (
        Decimal("1220000.00"), Decimal("99600.00"), Decimal("11200.00"))


def test_ird_example_2_foreign_and_local_lecturing():
    """Mr Chatura: foreign fees 9,000,000 (20% tax abroad), local 5,000,000
    (5% AIT), net of expenses. Foreign at 15%: 1,350,000; local across the
    bands: 672,000; the foreign tax credit is limited to 1,350,000."""
    facts = TaxFacts(ya="2025/2026", business_income=Decimal("5000000"),
                     foreign_service_income=Decimal("9000000"),
                     foreign_tax_credit=Decimal("1800000"), wht_credit=Decimal("250000"))
    c = compute(facts, _rules("2025/2026", **IRD_LAW))
    by_key = {s.rule_key: s for s in c.steps}
    assert by_key["band.progressive"].value == Decimal("672000.00")
    assert by_key["band.foreign_service_cap"].value == Decimal("1350000.00")
    assert c.taxable_income == Decimal("12200000.00")
    # Before the 400,000 instalment the IRD subtracts last: 422,000.
    assert c.balance_payable == Decimal("422000.00")


def test_ird_example_3_youtuber_with_a_donation():
    """Mr Amith: foreign 83,280,000, local 40,490,000, donation 2,500,000 to a
    government school, AIT 44,500. IRD total tax 25,040,400."""
    facts = TaxFacts(ya="2025/2026", business_income=Decimal("40490000"),
                     foreign_service_income=Decimal("83280000"),
                     qualifying_payments=Decimal("2500000"), wht_credit=Decimal("44500"))
    c = compute(facts, _rules("2025/2026", **IRD_LAW))
    by_key = {s.rule_key: s for s in c.steps}
    # 60,000 + 90,000 + 120,000 + 150,000 + 33,690,000 x 36% (12,128,400).
    assert by_key["band.progressive"].value == Decimal("12548400.00")
    assert by_key["band.foreign_service_cap"].value == Decimal("12492000.00")
    assert c.gross_tax == Decimal("25040400.00")
    # The IRD then subtracts the 8,160,000 instalments: 16,835,900.
    assert c.balance_payable - Decimal("8160000") == Decimal("16835900.00")


def test_a_small_foreign_only_income_still_gets_the_6_percent_band():
    """With no local income, foreign income takes the bands from the bottom,
    each capped at 15%: 1,000,000 at 6% and the rest at 15%, not 18% and up."""
    facts = TaxFacts(ya="2026/2027", foreign_service_income=Decimal("3800000"))
    c = compute(facts, _rules(**IRD_LAW))
    # 3,800,000 - 1,800,000 relief = 2,000,000 taxable: 60,000 + 1,000,000 x 15%.
    assert c.gross_tax == Decimal("210000.00")


def test_business_expenses_are_deducted_with_a_cited_step():
    facts = TaxFacts(ya="2026/2027", business_income=Decimal("4000000"), business_expenses=Decimal("1000000"))
    c = compute(facts, _rules(**IRD_LAW))
    labels = [s.label for s in c.steps]
    assert labels[:2] == ["Income before business expenses", "Less business expenses"]
    assert c.steps[1].value == Decimal("1000000.00") and c.steps[1].rule_version_id
    # 3,000,000 - 1,800,000 = 1,200,000 taxable: 96,000.
    assert c.gross_tax == Decimal("96000.00")


def test_without_the_new_rules_nothing_is_dropped_silently():
    """Before the rules are signed and published, the figures are taxed as
    today, and the computation says what it could not apply."""
    facts = TaxFacts(ya="2026/2027", business_income=Decimal("4000000"),
                     business_expenses=Decimal("1000000"), foreign_service_income=Decimal("2000000"))
    c = compute(facts, _rules())
    assert len(c.steps) == 8
    assert any("Business expenses" in n for n in c.notes)
    assert any("15%" in n for n in c.notes)
