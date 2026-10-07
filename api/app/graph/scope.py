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

# Advisory phrasing is refused (spec §1.2). These are planning on their own.
_ADVISORY = re.compile(
    r"(?i)\b(best way to (?:avoid|reduce|minimi[sz]e)|"
    r"how (?:can|do) i (?:avoid|reduce|minimi[sz]e|evade|escape)|tax planning|"
    r"structure my|loophole|get around|pay less tax)\b"
)
# "Should I", "recommend" and "advise me" are refused only when they ask about
# planning. "Should I file a return?" is the obligation question in ordinary
# words, and refusing it refused one of the commonest questions there is (#46).
_ASKS_ADVICE = re.compile(r"(?i)\b(should i|what should|advise me|recommend)\b")
_PLANNING = re.compile(
    r"(?i)\b(reduce|avoid|minimi[sz]e|lower|save|saving|cut|less tax|structure|split|"
    r"shift|move (?:my |the )?(?:income|money)|hide|evade|escape|invest|scheme|"
    r"plan(?:ning)?|transfer|in my (?:wife|husband|spouse|child)'?s? name)\b"
)

# Representation before IRD. An assessment notice is in scope to explain; it
# is representation once the user wants to contest it.
_REPRESENTATION = re.compile(
    r"(?i)\b(appeal|dispute|object to|represent me|tribunal|tax case|litigat|"
    r"(?:challenge|contest|fight|respond to|reply to) (?:an? |my |the )?assessment)\w*"
)

# Whether the user must file, in the words people use for it.
OBLIGATION = re.compile(
    r"(?i)\b(?:do|should|must|would|will) i (?:need to |have to )?(?:file|submit|lodge)\b"
    r"|\b(?:need|have) to (?:file|submit|lodge)\b|\bam i required to file\b"
)

_INCOME_TAX_HINT = re.compile(
    r"(?i)\b(income tax|salary|salaried|epf|etf|apit|paye|relief|taxable income|"
    r"balance payable|year of assessment|filing|return|deadline|instalment|"
    r"tax band|tax rate|withheld|assessable|qualifying payment|"
    r"how much (?:tax|do i owe)|owe|tax|inland revenue|ird|circular|tax tables?)\b"
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

    if _ADVISORY.search(question) or (
        _ASKS_ADVICE.search(question) and _PLANNING.search(question)
    ):
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
