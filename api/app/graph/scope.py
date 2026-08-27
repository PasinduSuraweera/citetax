"""Scope gate — spec §4.1 node 2.

Runs early (position 2, not late) so an out-of-scope question costs one cheap
classification instead of a full retrieval and computation pass.

Refusal is a designed output with a reason and, where possible, a pointer to the
right IRD resource. It is not an error state.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

IRD_URL = "https://www.ird.gov.lk"


@dataclass
class ScopeVerdict:
    in_scope: bool
    reason: str | None = None
    pointer: str | None = None
    category: str | None = None


# Out-of-scope tax types (spec §1.2).
_OTHER_TAXES = [
    (r"(?i)\b(vat|value added tax)\b", "VAT",
     "Citetax covers personal income tax only.",
     f"{IRD_URL} | Value Added Tax"),
    (r"(?i)\b(sscl|social security contribution)\b", "SSCL",
     "Citetax covers personal income tax only.",
     f"{IRD_URL} | Social Security Contribution Levy"),
    (r"(?i)\b(corporate (income )?tax|company tax|corporation tax)\b", "corporate",
     "Citetax covers personal income tax only, not corporate income tax.",
     f"{IRD_URL} | Corporate Income Tax"),
    (r"(?i)\b(stamp duty|nation building tax|\bnbt\b)\b", "other",
     "Citetax covers personal income tax only.",
     IRD_URL),
    (r"(?i)\bwithholding tax\s+(?:return|filing|remittance)\b", "wht-filing",
     "Citetax covers personal income tax only, not WHT agent filing.",
     IRD_URL),
]

# Employer-side PAYE/APIT administration is out of scope; an employee asking
# about their own APIT credit is in scope.
_EMPLOYER_FILING = re.compile(
    r"(?i)\b(as an employer|for my employees|my staff|payroll for|"
    r"employer'?s? (?:return|obligation|filing)|remit (?:paye|apit))\b"
)

# Advisory phrasing — "what should I do" is refused (spec §1.2).
_ADVISORY = re.compile(
    r"(?i)\b(should i|what should|advise me|recommend|best way to (?:avoid|reduce|minimi[sz]e)|"
    r"how (?:can|do) i (?:avoid|reduce|minimi[sz]e|evade|escape)|tax planning|"
    r"structure my|loophole|get around|pay less tax)\b"
)

# Representation before IRD.
_REPRESENTATION = re.compile(
    r"(?i)\b(appeal|dispute|object to|represent me|tribunal|assessment notice|"
    r"tax case|litigat)\b"
)

_INCOME_TAX_HINT = re.compile(
    r"(?i)\b(income tax|salary|epf|etf|apit|paye|relief|taxable income|"
    r"balance payable|year of assessment|filing|return|deadline|"
    r"how much (?:tax|do i owe)|owe)\b"
)


def check_scope(question: str, ya: str | None, supported: tuple[str, ...]) -> ScopeVerdict:
    """Deterministic first pass. Cheap, explainable, and testable."""

    for pattern, category, reason, pointer in _OTHER_TAXES:
        if re.search(pattern, question):
            return ScopeVerdict(False, reason, pointer, category)

    if _EMPLOYER_FILING.search(question):
        return ScopeVerdict(
            False,
            "Citetax answers for individual filers, not for employers filing on "
            "behalf of staff.",
            f"{IRD_URL} | APIT / PAYE for employers",
            "employer-filing",
        )

    if _REPRESENTATION.search(question):
        return ScopeVerdict(
            False,
            "Citetax is a computation aid. It does not handle appeals, disputes "
            "or representation before the IRD.",
            f"{IRD_URL} | Appeals",
            "representation",
        )

    if _ADVISORY.search(question):
        return ScopeVerdict(
            False,
            "Citetax computes what the law says you owe. It does not give tax "
            "planning or advisory recommendations.",
            None,
            "advisory",
        )

    # Year of assessment must be supported (spec §1.2).
    if ya is not None and ya not in supported:
        return ScopeVerdict(
            False,
            f"Citetax supports the years of assessment "
            f"{' and '.join(supported)} only. You asked about {ya}.",
            f"{IRD_URL} | Publications",
            "unsupported-year",
        )

    return ScopeVerdict(True)


def looks_like_tax_question(question: str) -> bool:
    """Used to decide whether Clarify is worth running at all."""
    return bool(_INCOME_TAX_HINT.search(question))
