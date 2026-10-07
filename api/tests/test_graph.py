"""Scope gate, intake parser and verify node tests — spec §11.

Targets: out-of-scope refusal rate ≥ 0.95 on the adversarial set,
hallucinated-number rate 0 after verify.
"""

from __future__ import annotations

from dataclasses import replace
from datetime import date
from decimal import Decimal

import pytest

from app.compute.engine import compute
from app.compute.types import TaxFacts
from app.graph.intake import parse_question, parse_year_of_assessment
from app.graph.scope import check_scope, looks_like_tax_question
from app.graph.verify import BadgeState, Evidence
from app.graph.verify import verify as _verify_impl
from app.rules.resolver import ResolvedRuleSet, RuleVersion

SUPPORTED = ("2025/2026", "2026/2027")


def verify(prose, computation, rules, attempt: int = 1):
    """The node now takes an Evidence bundle so it can verify prose for
    intents with no computation. These tests exercise the compute case."""
    return _verify_impl(
        prose, Evidence(computation=computation, rules=rules), attempt=attempt
    )

BANDS = [
    {"upto": 1000000, "rate": "0.06"},
    {"upto": 1500000, "rate": "0.18"},
    {"upto": 2000000, "rate": "0.24"},
    {"upto": 2500000, "rate": "0.30"},
    {"upto": None,    "rate": "0.36"},
]

_VALUES = {
    "income.assessable":      {"includes": ["employment"]},
    "deduction.epf_employee": {"employee_rate": "0.08"},
    "deduction.qualifying":   {"annual_cap": None},
    "relief.personal":        {"amount": "1800000"},
    "charge.taxable_income":  {"formula": "a-d-r"},
    "band.progressive":       {"bands": BANDS},
    "credit.foreign_wht":     {"allowed": True},
    "credit.apit":            {"allowed": True},
}


def _rules(ya="2026/2027") -> ResolvedRuleSet:
    rs = ResolvedRuleSet(ya=ya, snapshot_id="snap")
    for i, (k, v) in enumerate(_VALUES.items()):
        rs.rules[k] = RuleVersion(
            id=f"rv-{i}", rule_key=k, revision_no=1, value_json=v,
            effective_from=date(2025, 4, 1), effective_to=None,
            citation_label=f"cite-{k}", quoted_text="…",
        )
    return rs


# ---------------------------------------------------------------------------
# Scope gate — adversarial set
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "question,category",
    [
        ("How do I register for VAT?",                        "VAT"),
        ("What is the SSCL rate this year?",                  "SSCL"),
        ("Calculate corporate income tax for my company",     "corporate"),
        ("What stamp duty do I pay on a lease?",              "other"),
        ("How do I file APIT for my employees?",              "employer-filing"),
        ("I want to appeal my assessment notice",             "representation"),
        ("How can I reduce my tax legally?",                  "advisory"),
        ("What should I do to pay less tax?",                 "advisory"),
        ("Best way to minimise my tax bill?",                 "advisory"),
        ("Any loophole to get around income tax?",            "advisory"),
    ],
)
def test_out_of_scope_questions_are_refused_with_a_reason(question, category):
    v = check_scope(question, None, SUPPORTED)
    assert v.in_scope is False
    assert v.category == category
    assert v.reason, "a refusal must carry a reason (spec §1.2)"


@pytest.mark.parametrize(
    "question",
    [
        "What do I owe for 2026/2027 on a salary of LKR 250,000 a month?",
        "How much income tax on 3,000,000 a year with EPF deducted?",
        "When is my return due for 2025/2026?",
        "Do I need to file if I earn 1,500,000?",
        "How much APIT credit can I claim?",
        # #46: ordinary ways of asking what the law requires.
        "Should I file a return for 2026/2027 if I earn 150,000 a month?",
        "Would you recommend I check my APIT?",
        "What does an assessment notice mean for my salary tax?",
        "Should I file if I have investment income as well?",
    ],
)
def test_in_scope_questions_pass(question):
    ya = parse_year_of_assessment(question, SUPPORTED)
    assert check_scope(question, ya, SUPPORTED).in_scope is True


@pytest.mark.parametrize(
    "question,category",
    [
        ("Should I split my income to pay less tax?", "advisory"),
        ("Should I put the rental income in my wife's name?", "advisory"),
        ("What would you recommend to reduce my tax?", "advisory"),
        ("Should I file a return or move my income abroad to avoid tax?", "advisory"),
        ("How do I contest my assessment?", "representation"),
    ],
)
def test_planning_and_contesting_are_still_refused(question, category):
    v = check_scope(question, None, SUPPORTED)
    assert (v.in_scope, v.category) == (False, category)


def test_should_i_file_routes_to_the_obligation_intent():
    from app.graph.intent import _regex_route

    routed = _regex_route("Should I file a return for 2026/2027 if I earn 150,000 a month?", SUPPORTED)
    assert routed.routed.intent == "obligation"


def test_scope_gate_is_not_blinded_by_redaction():
    """Regression: spaCy tags 'VAT' as an ORG, so redacting before the scope
    gate rewrote the question to 'How do I register for <EMPLOYER_1>?' and the
    gate let it through. The redactor now keeps tax vocabulary, but the gate
    must still classify the original text: NER can hide words the
    vocabulary list does not cover."""
    from app.privacy.redactor import CodedRedactor

    q = "How do I register for VAT?"
    redacted = CodedRedactor(use_ner=True).redact(q).text

    assert check_scope(q, None, SUPPORTED).category == "VAT"
    # Whenever redaction does hide the tax type, the graph must use the
    # original string.
    if "VAT" not in redacted:
        assert check_scope(redacted, None, SUPPORTED).in_scope is True, (
            "redaction hides the tax type, so the gate must see the original"
        )


def test_unsupported_year_is_refused_by_name():
    v = check_scope("What do I owe for 2019/2020?", "2019/2020", SUPPORTED)
    assert v.in_scope is False
    assert v.category == "unsupported-year"
    assert "2019/2020" in v.reason


def test_employee_asking_about_own_apit_is_in_scope():
    """Employer-side filing is out of scope; an employee's own APIT credit is not."""
    assert check_scope(
        "How much APIT was withheld from my salary?", "2026/2027", SUPPORTED
    ).in_scope is True


def test_tax_question_detector():
    assert looks_like_tax_question("how much income tax do I owe")
    assert not looks_like_tax_question("what is the weather today")


# ---------------------------------------------------------------------------
# Intake parser
# ---------------------------------------------------------------------------

def test_parses_the_ui_mock_question():
    q = "What do I owe for 2026/2027 on a salary of LKR 250,000 a month, with EPF deducted?"
    f = parse_question(q, SUPPORTED)
    assert f.ya == "2026/2027"
    assert f.employment_income == Decimal("3000000")   # 250,000 × 12


def test_annual_salary_is_not_multiplied():
    f = parse_question("I earn Rs. 3,000,000 per annum for 2026/2027", SUPPORTED)
    assert f.employment_income == Decimal("3000000")


def test_parses_epf_and_apit_separately():
    f = parse_question(
        "For 2026/2027 my salary was 3,000,000, EPF 240,000 and APIT withheld 57,600",
        SUPPORTED,
    )
    assert f.employment_income == Decimal("3000000")
    assert f.epf_employee == Decimal("240000")
    assert f.apit_withheld == Decimal("57600")


def test_year_adjacent_to_amount_does_not_fuse():
    """Regression: '2026/2027 my salary was 3,000,000' once parsed as
    2,027,000,000 because the trailing year fused with the figure."""
    f = parse_question("For 2026/2027 my salary was 3,000,000", SUPPORTED)
    assert f.employment_income == Decimal("3000000")


def test_epf_mentioned_without_an_amount_is_not_given_the_salary():
    """Regression: "LKR 250,000 a month, with EPF deducted" assigned 250,000 to
    epf_employee as well as to salary. One figure cannot fill two roles; the
    engine then derives EPF from the statutory rate."""
    f = parse_question(
        "What do I owe for 2026/2027 on a salary of LKR 250,000 a month, "
        "with EPF deducted?",
        SUPPORTED,
    )
    assert f.employment_income == Decimal("3000000")
    assert f.epf_employee is None


def test_million_shorthand():
    f = parse_question("salary of 2.5 million for 2026/2027", SUPPORTED)
    assert f.employment_income == Decimal("2500000")


def test_monthly_is_not_read_as_million():
    """Regression (#49): the "m" of "monthly" was taken as a million suffix,
    so a 250,000 monthly salary became 3 trillion."""
    f = parse_question("For 2026/2027 my salary is 250,000 monthly", SUPPORTED)
    assert f.employment_income == Decimal("3000000")


def test_k_and_m_shorthand_attached_to_the_number():
    """Regression (#49): "250k" was skipped, so the EPF figure was taken as
    the salary and EPF was left empty."""
    f = parse_question(
        "For 2026/2027 salary 250k a month and EPF 20,000 a month", SUPPORTED
    )
    assert f.employment_income == Decimal("3000000")
    assert f.epf_employee == Decimal("240000")
    assert parse_question("For 2026/2027 I earn 3m", SUPPORTED).employment_income == Decimal("3000000")


def test_every_monthly_field_is_annualised():
    """Regression (#49): only salary and raises were multiplied by 12."""
    f = parse_question(
        "For 2026/2027 salary LKR 250,000 per month, APIT deducted 12,000 per month",
        SUPPORTED,
    )
    assert f.employment_income == Decimal("3000000")
    assert f.apit_withheld == Decimal("144000")


def test_period_belongs_to_the_figure_it_sits_beside():
    """One "per month" no longer annualises every figure in the question."""
    f = parse_question("For 2026/2027 salary 250,000 per month, bonus 300,000", SUPPORTED)
    assert f.employment_income == Decimal("3300000")

    f = parse_question(
        "For 2026/2027 rent income 50,000 per month and salary 3,000,000", SUPPORTED
    )
    assert f.employment_income == Decimal("3000000")
    assert f.investment_income == Decimal("600000")

    f = parse_question("For 2026/2027 salary 3,000,000 a year, APIT 12,000 a month", SUPPORTED)
    assert f.employment_income == Decimal("3000000")
    assert f.apit_withheld == Decimal("144000")


def test_period_wording_before_the_figure():
    f = parse_question("For 2026/2027 my monthly salary is Rs. 250,000", SUPPORTED)
    assert f.employment_income == Decimal("3000000")


def test_period_wording_in_another_sentence_does_not_apply():
    f = parse_question("For 2026/2027 salary 3,000,000. What is my tax per month?", SUPPORTED)
    assert f.employment_income == Decimal("3000000")


def test_dotted_pm_abbreviation():
    f = parse_question("For 2026/2027 salary 250,000 p.m. and EPF 20,000 p.m.", SUPPORTED)
    assert f.employment_income == Decimal("3000000")
    assert f.epf_employee == Decimal("240000")


def test_missing_year_triggers_clarify():
    assert "ya" in parse_question("I earn 3,000,000 a year", SUPPORTED).missing_required()


def test_missing_income_triggers_clarify():
    assert "income" in parse_question(
        "What do I owe for 2026/2027?", SUPPORTED
    ).missing_required()


def test_year_written_with_dash():
    assert parse_year_of_assessment("for 2025-2026", SUPPORTED) == "2025/2026"


# ---------------------------------------------------------------------------
# Verify node — hallucinated-number rate must be 0
# ---------------------------------------------------------------------------

def _computation():
    facts = TaxFacts(
        ya="2026/2027",
        employment_income=Decimal("3000000"),
        apit_withheld=Decimal("57600"),
    )
    return compute(facts, _rules())


def test_verify_accepts_prose_built_only_from_ledger_figures():
    c = _computation()
    prose = (
        "Your assessable income for 2026/2027 was LKR 3,000,000.00. After the "
        "EPF deduction of 240,000.00 and personal relief of 1,800,000.00, your "
        "taxable income is 960,000.00, taxed at 6% to give 57,600.00."
    )
    assert verify(prose, c, _rules()).ok is True


def test_verify_blocks_a_hallucinated_figure():
    """Spec §11 — hallucinated-number rate after verify must be 0."""
    c = _computation()
    prose = "Your taxable income is 960,000.00 and you also owe a surcharge of 88,888.00."
    r = verify(prose, c, _rules(), attempt=2)
    assert r.ok is False
    assert "88,888.00" in r.unmatched_numbers
    assert r.prose_released is False
    assert r.badge is BadgeState.PARTIAL


def test_verify_allows_section_numbers_from_citation_labels():
    """Regression: prose citing 'Act s.52' and 'Act s.80' had 52 and 80 flagged
    as hallucinated figures, so correct citations suppressed the explanation.
    Numbers inside a citation label name the law, they do not claim money."""
    c = _computation()
    rules = _rules()
    # RuleVersion is frozen by design, so rebuild the two entries rather than
    # mutating them.
    for key, label in (("deduction.qualifying", "Act s.52"),
                       ("credit.foreign_wht", "Act s.80")):
        rules.rules[key] = replace(rules.rules[key], citation_label=label)

    r = verify(
        "Qualifying payments under Act s.52 were nil, and no credit arose "
        "under Act s.80. Your taxable income is 960,000.00.",
        c, rules, attempt=2,
    )
    assert r.ok is True, f"false positives: {r.unmatched_numbers}"


def test_verify_blocks_a_figure_truncated_mid_number():
    """Regression: a response cut off at max_tokens ended '...is LKR 3', and
    verify passed it because 3 is an allowlisted step number. A figure carrying
    a currency marker is a claim about money and is held to the ledger alone."""
    c = _computation()
    r = verify(
        "The assessable income for the year of assessment 2026/2027 is LKR 3",
        c, _rules(), attempt=2,
    )
    assert r.ok is False
    assert any("3" in u for u in r.unmatched_numbers)


def test_verify_accepts_a_zero_the_ledger_holds():
    """Regression: 'qualifying payments of LKR 0.00' withheld the whole
    explanation, because zero is on the small number allowlist and that list
    was subtracted from the money set, ledger zeros included."""
    c = _computation()
    assert any(s.value == 0 for s in c.steps), "fixture needs a zero step"
    r = verify("Qualifying payments come to LKR 0.00 this year.", c, _rules(), attempt=2)
    assert r.ok is True, r.unmatched_numbers


@pytest.mark.parametrize("prose", [
    "The top slice is taxed at 12% under the bands.",
    "Income above LKR 2,500,000 is taxed at 30%.",
    "Your balance payable is LKR 1,800,000.",
    "The personal relief rose to LKR 1,800,000 in 2024.",
])
def test_verify_withholds_right_numbers_in_the_wrong_place(prose):
    """#43: each figure here exists somewhere in the material, so a value
    check alone released all four. They are wrong where they are used."""
    r = verify(prose, _computation(), _rules(), attempt=2)
    assert r.ok is False, prose


@pytest.mark.parametrize("prose", [
    "Income above LKR 2,500,000 is taxed at 36%.",
    "The first LKR 1,000,000 is taxed at 6%.",
    "Income over LKR 1,000,000 up to LKR 1,500,000 is taxed at 18%.",
    "The top rate is 36%.",
    "Your taxable income above LKR 2,500,000 would be taxed at 36%.",
    "Your balance payable for 2026/2027 is LKR 0.00 after the APIT credit.",
    "The personal relief is LKR 1,800,000 for 2026/2027.",
])
def test_verify_still_releases_correct_band_and_role_sentences(prose):
    r = verify(prose, _computation(), _rules(), attempt=2)
    assert r.ok is True, (prose, r.unmatched_numbers)


def test_verify_still_accepts_a_correct_currency_figure():
    c = _computation()
    assert verify(
        "Your assessable income is LKR 3,000,000.00 for the year.", c, _rules()
    ).ok is True


def test_verify_blocks_an_invented_rate():
    c = _computation()
    r = verify("Your income is taxed at 42% under the top band.", c, _rules(), attempt=2)
    assert r.ok is False
    assert "42%" in r.unmatched_numbers


def test_verify_allows_rates_from_the_band_table():
    c = _computation()
    assert verify(
        "The first 1,000,000.00 is taxed at 6%, then 18% applies.", c, _rules()
    ).ok is True


def test_verify_allows_year_of_assessment_and_step_numbers():
    c = _computation()
    assert verify(
        "Across 8 steps for the year of assessment 2026/2027, the balance is 0.00.",
        c, _rules(),
    ).ok is True


def test_verify_blocks_pii_in_egress():
    """Egress scan catches a leak on the way out as well as on the way in."""
    c = _computation()
    r = verify("Nimal (NIC 912345678V) owes 0.00.", c, _rules())
    assert r.ok is False
    assert "NIC" in r.pii_classes
    assert r.prose_released is False


def test_verify_first_failure_asks_for_regeneration():
    c = _computation()
    r = verify("You owe 99,999.00.", c, _rules(), attempt=1)
    assert r.ok is False
    assert "Regenerating" in r.note
