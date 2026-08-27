"""Redaction tests — spec §11.

Targets: identifier leak rate 0 on structured IDs, money-token survival 100%.
Recall is reported per class, never as one average, because a 0.95 mean that
hides 0.60 on Tamil names is not a passing grade.
"""

from __future__ import annotations

import pytest

from app.privacy.redactor import CodedRedactor, EgressScanner, truncate_for_llm

# NER off in most tests: it is optional, and these assert the regex tier.
R = CodedRedactor(use_ner=False)


# ---------------------------------------------------------------------------
# Structured identifiers — target leak rate 0
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "raw,token",
    [
        ("My NIC is 912345678V",              "<NIC>"),
        ("nic 912345678v please",             "<NIC>"),
        ("NIC: 199123401234",                 "<NIC>"),   # new format, day 234
        ("passport N1234567",                 "<PASSPORT>"),
        ("call me on 0771234567",             "<PHONE>"),
        ("phone +94 77 123 4567",             "<PHONE>"),
        ("email me at nimal@example.lk",      "<EMAIL>"),
        ("my TIN is 123456789",               "<TIN>"),
        ("bank account 1234567890123",        "<ACCOUNT>"),
    ],
)
def test_structured_identifiers_are_redacted(raw, token):
    out = R.redact(raw)
    assert token in out.text
    assert not out.clean


def test_new_nic_implausible_day_is_not_treated_as_nic():
    """Day-of-year 999 is impossible, so this 12-digit run is left alone
    rather than destroying a figure that merely looks like an NIC."""
    out = R.redact("reference 199999901234")
    assert "<NIC>" not in out.text


# ---------------------------------------------------------------------------
# Money survival — target 100% (spec §11)
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "raw",
    [
        "My salary is LKR 250,000 a month",
        "I earn Rs. 3,000,000 per annum",
        "EPF deducted 240000 and APIT withheld 57,600",
        "annual income 3000000",
        "I was paid 1,800,000.50 last year",
        "salary 250000 monthly, bonus 500000",
    ],
)
def test_money_survives_redaction(raw):
    """The redactor's hardest job is not finding IDs — it is not destroying
    the figures the computation needs."""
    out = R.redact(raw)
    for token in ("<NIC>", "<TIN>", "<ACCOUNT>", "<PHONE>"):
        assert token not in out.text, f"{token} destroyed a figure in: {raw}"


def test_salary_adjacent_to_nic_keeps_the_salary():
    out = R.redact("NIC 912345678V, salary LKR 3,000,000 per year")
    assert "<NIC>" in out.text
    assert "3,000,000" in out.text


def test_nine_digit_figure_without_tin_context_survives():
    """A bare 9-digit run only becomes a TIN near a tax-file keyword."""
    out = R.redact("the company turnover was 123456789 rupees")
    assert "<TIN>" not in out.text


# ---------------------------------------------------------------------------
# Names — reported per class, NER required
# ---------------------------------------------------------------------------

def test_gazetteer_catches_names_ner_would_miss():
    """Spec §9.1: en_core_web_sm under-detects Sinhala and Tamil names, so a
    gazetteer is layered over it."""
    r = CodedRedactor(use_ner=False, gazetteer={"Nimal", "Kumaraswamy", "Perera"})
    out = r.redact("Nimal Perera earns LKR 250,000")
    assert "<PERSON>" in out.text
    assert "Nimal" not in out.text
    assert "250,000" in out.text


def test_gazetteer_does_not_eat_money():
    r = CodedRedactor(use_ner=False, gazetteer={"Nimal"})
    out = r.redact("Nimal earns Rs. 3,000,000")
    assert "3,000,000" in out.text


# ---------------------------------------------------------------------------
# Egress scanning and truncation
# ---------------------------------------------------------------------------

def test_ner_does_not_substitute_inside_an_existing_placeholder():
    """Regression: spaCy tags '<NIC>' as an ORG, and re-substituting inside it
    produced a mangled '<EMPLOYER_1> <<EMPLOYER_2>' instead of a clean '<NIC>'.
    Placeholders from earlier tiers are protected."""
    r = CodedRedactor(use_ner=True)
    out = r.redact("I am Nimal Perera, NIC 912345678V, at Ceylon Textiles PLC.")
    assert "<NIC>" in out.text
    assert "<<" not in out.text
    assert ">>" not in out.text
    # Every placeholder is well-formed: no nesting, no stray angle brackets.
    assert out.text.count("<") == out.text.count(">")


def test_label_word_is_absorbed_into_its_placeholder():
    """'NIC <NIC>' collapses to '<NIC>' — the bare label adds nothing and
    invites NER to tag it as an organisation."""
    r = CodedRedactor(use_ner=False)
    assert r.redact("NIC 912345678V").text == "<NIC>"
    assert r.redact("my phone number is 0771234567").text.endswith("<PHONE>")


def test_gazetteer_does_not_substitute_inside_a_placeholder():
    r = CodedRedactor(use_ner=False, gazetteer={"person", "nic"})
    assert r.redact("NIC 912345678V").text == "<NIC>"


def test_egress_scanner_flags_a_leak_on_the_way_out():
    assert EgressScanner().scan("your NIC 912345678V is on file") == ["NIC"]


def test_egress_scanner_is_quiet_on_a_clean_answer():
    clean = (
        "Your taxable income is LKR 960,000 and the balance payable is "
        "LKR 57,600 for the year of assessment 2026/2027."
    )
    assert EgressScanner().scan(clean) == []


def test_truncation_cap_is_enforced():
    long = "word " * 500
    out = truncate_for_llm(long, 100)
    assert len(out) <= 102
    assert out.endswith("…")


def test_short_text_is_not_truncated():
    assert truncate_for_llm("short question", 600) == "short question"


def test_redaction_is_reported_per_class():
    """Spec §11 — report recall per class rather than one aggregate number."""
    out = R.redact("NIC 912345678V phone 0771234567 email a@b.lk")
    assert set(out.replacements) == {"NIC", "PHONE", "EMAIL"}
    assert out.total == 3


def test_missing_ner_model_degrades_rather_than_failing_open():
    """If spaCy is unavailable the regex tier still runs and the result says so,
    instead of silently passing text through unredacted."""
    r = CodedRedactor(use_ner=True)
    r._ner_failed = True  # simulate model not installed
    out = r.redact("NIC 912345678V")
    assert "<NIC>" in out.text
    assert out.ner_available is False
