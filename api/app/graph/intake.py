"""Intake node — spec §4.1 node 1.

Parses the user's message into a typed TaxFacts object. This is the minimisation
boundary: downstream nodes receive TaxFacts, not the original string, so a name
or an employer that slipped past the redactor usually has nowhere to travel to.

Deterministic parsing, no LLM. A question the parser cannot understand goes to
the Clarify node rather than to a model that would guess.
"""

from __future__ import annotations

import re
from decimal import Decimal, InvalidOperation

from app.compute.types import TaxFacts

# --- Amount parsing --------------------------------------------------------
# Matches "LKR 250,000", "Rs. 3,000,000", "250000", "1.5 million", "250k".
# Thousands groups must be exactly 3 digits, so "2027 3,000,000" cannot fuse
# into one token. \b anchors keep a figure from starting mid-number.
_AMOUNT = re.compile(
    r"(?i)(?:lkr|rs\.?|rupees?)?\s*"
    r"\b(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\b"
    r"\s*(k|m|mn|million|lakhs?|crores?)?",
)

_MULTIPLIER = {
    "k": Decimal("1000"),
    "m": Decimal("1000000"),
    "mn": Decimal("1000000"),
    "million": Decimal("1000000"),
    "lakh": Decimal("100000"),
    "lakhs": Decimal("100000"),
    "crore": Decimal("10000000"),
    "crores": Decimal("10000000"),
}

_MONTHLY = re.compile(r"(?i)\b(per month|a month|monthly|pm|p\.m\.|each month)\b")
_ANNUAL = re.compile(r"(?i)\b(per year|a year|per annum|annually|yearly|p\.a\.)\b")

# A "what if I got a raise" question states a change, not a total — the
# figure near these words is added to (or, for a cut, subtracted from) the
# base salary rather than replacing it or being dropped. Without this,
# "income is 3,000,000 ... with a 50,000 raise" silently loses the 50,000:
# no keyword list below claims it, so it is never parsed at all and the
# computation quietly answers the old salary. A bonus, overtime pay and
# commission get the same additive treatment — for this calculation they
# are all just more employment income, not a separate source.
_INCREASE_KEYWORDS = [
    "raise", "increase", "rise", "hike", "pay rise", "pay increase",
    "salary increase", "salary hike", "bonus", "overtime", "commission",
]
_DECREASE_KEYWORDS = [
    "pay cut", "salary cut", "decrease", "reduction", "reduced by",
    "cut by", "dropped by", "lower by",
]

_YA = re.compile(r"\b(20\d{2})\s*[/\-–]\s*(20\d{2})\b")
_SINGLE_YEAR = re.compile(r"(?i)\b(?:ya|year of assessment|for)\s*(20\d{2})\b")


def _to_decimal(raw: str, suffix: str | None) -> Decimal | None:
    try:
        value = Decimal(raw.replace(",", ""))
    except InvalidOperation:
        return None
    if suffix:
        value *= _MULTIPLIER.get(suffix.lower(), Decimal(1))
    return value


def _find_amount(
    text: str,
    keywords: list[str],
    window: int = 60,
    claimed: set[int] | None = None,
) -> tuple[Decimal, int] | None:
    """Find the amount *nearest* to any of `keywords`.

    Nearest, not largest: in "salary 3,000,000, EPF 240,000" the window around
    "EPF" contains both figures, and the larger one is the salary. Distance is
    what distinguishes them, so the closest amount wins and ties break toward
    text that follows the keyword ("EPF 240,000" over "240,000 EPF").

    `claimed` holds character offsets already assigned to another field. One
    figure cannot fill two roles: in "LKR 250,000 a month, with EPF deducted"
    the only number is the salary, and "with EPF deducted" states that EPF
    applies without giving an amount. Returns (value, offset) so the caller can
    mark what it consumed.
    """
    claimed = claimed or set()
    best: tuple[Decimal, int] | None = None
    best_distance = float("inf")
    lowered = text.lower()

    for kw in keywords:
        for km in re.finditer(re.escape(kw), lowered):
            start = max(0, km.start() - window)
            end = min(len(text), km.end() + window)
            for am in _AMOUNT.finditer(text[start:end]):
                value = _to_decimal(am.group(1), am.group(2))
                # Reject bare years masquerading as amounts.
                if value is None or value < 1000:
                    continue
                if 2000 <= value <= 2100 and not am.group(2):
                    continue

                pos = start + am.start(1)
                if pos in claimed:
                    continue

                if pos >= km.end():
                    distance = pos - km.end()          # amount follows keyword
                else:
                    distance = (km.start() - pos) + 1  # precedes; slight penalty

                if distance < best_distance:
                    best, best_distance = (value, pos), distance

    return best


def parse_year_of_assessment(text: str, supported: tuple[str, ...]) -> str | None:
    m = _YA.search(text)
    if m:
        candidate = f"{m.group(1)}/{m.group(2)}"
        if candidate in supported:
            return candidate
        return candidate  # returned so the scope gate can refuse it by name

    m = _SINGLE_YEAR.search(text)
    if m:
        start = int(m.group(1))
        for ya in supported:
            if ya.startswith(str(start)):
                return ya
    return None


def parse_question(text: str, supported_yas: tuple[str, ...]) -> TaxFacts:
    """Extract everything the computation needs, and nothing that identifies."""
    facts = TaxFacts(source="question")

    facts.ya = parse_year_of_assessment(text, supported_yas)

    # Blank the year-of-assessment token before scanning for amounts. Left in
    # place, "2026/2027 my salary was 3,000,000" reads as 2,027,000,000 —
    # the trailing year fuses with the leading digits of the real figure.
    text = _YA.sub(" ", text)

    # Offsets already assigned to a field, so one figure never fills two roles.
    claimed: set[int] = set()

    hit = _find_amount(
        text, ["salary", "earn", "income", "paid", "wage", "make", "pay"],
        claimed=claimed,
    )
    if hit is None:
        # A lone figure in a tax question is almost always the salary.
        candidates = [
            (v, m.start(1))
            for m, v in (
                (m, _to_decimal(m.group(1), m.group(2)))
                for m in _AMOUNT.finditer(text)
            )
            if v is not None and v >= 10000
        ]
        hit = max(candidates, key=lambda p: p[0]) if candidates else None

    salary: Decimal | None = None
    if hit is not None:
        salary, pos = hit
        claimed.add(pos)
        if _MONTHLY.search(text) and not _ANNUAL.search(text):
            salary *= 12
        facts.employment_income = salary

    increase_hit = _find_amount(text, _INCREASE_KEYWORDS, claimed=claimed)
    if increase_hit is not None:
        amount, pos = increase_hit
        claimed.add(pos)
        if _MONTHLY.search(text) and not _ANNUAL.search(text):
            amount *= 12
        facts.employment_income = (facts.employment_income or Decimal(0)) + amount

    decrease_hit = _find_amount(text, _DECREASE_KEYWORDS, claimed=claimed)
    if decrease_hit is not None:
        amount, pos = decrease_hit
        claimed.add(pos)
        if _MONTHLY.search(text) and not _ANNUAL.search(text):
            amount *= 12
        # A cut larger than the stated salary is a nonsensical input, not a
        # negative-income scenario the compute engine needs to handle.
        facts.employment_income = max(
            Decimal(0), (facts.employment_income or Decimal(0)) - amount
        )

    for keywords, field_name in (
        (["epf", "provident"], "epf_employee"),
        (["apit", "paye", "withheld", "deducted at source"], "apit_withheld"),
        (["business income", "freelance", "self-employed"], "business_income"),
        (["interest", "dividend", "rent", "investment"], "investment_income"),
        (["qualifying payment"], "qualifying_payments"),
        (["foreign tax credit", "tax paid abroad", "foreign tax paid"], "foreign_tax_credit"),
        (["withholding tax credit", "wht credit"], "wht_credit"),
        (["other income", "miscellaneous income", "misc income"], "other_income"),
    ):
        found = _find_amount(text, keywords, claimed=claimed)
        if found is not None:
            value, pos = found
            claimed.add(pos)
            setattr(facts, field_name, value)

    return facts
