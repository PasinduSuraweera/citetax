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
# into one token, and the lookarounds keep a figure from starting or ending
# mid-number. The multiplier must end the word: without that, the "m" of
# "250,000 monthly" read as a million and the salary became 3 trillion.
_AMOUNT = re.compile(
    r"(?i)(?<!\d)(?<!\d[.,])"
    r"(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?!\d)"
    r"(?:\s*(million|mn|m|k|lakhs?|crores?)(?![a-z]))?"
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

# (?<!\w) and (?!\w) rather than \b, so "p.m." still matches before a space.
_MONTHLY = re.compile(r"(?i)(?<!\w)(?:per month|a month|monthly|pm|p\.m\.?|each month)(?!\w)")
_ANNUAL = re.compile(r"(?i)(?<!\w)(?:per year|a year|per annum|annually|yearly|p\.a\.?)(?!\w)")

# A period phrase belongs to the figure it sits beside: "EPF 20,000 a month"
# or "monthly salary of 250,000". It reaches no further than this many
# characters, never across another figure, and never into the next clause, so
# "rent 50,000 per month and salary 3,000,000" leaves the salary annual.
_PERIOD_REACH = 25
# A sentence or clause boundary. The dot of "Rs." is not one.
_CLAUSE_BREAK = re.compile(r"(?i)[?!;\n]|(?<!rs)\.(?=\s|$)")

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
    # Matched against the whole text, then filtered by position: matching a
    # slice could start a figure mid-number where the window cut it.
    amounts = list(_AMOUNT.finditer(text))

    for kw in keywords:
        for km in re.finditer(re.escape(kw), lowered):
            start = max(0, km.start() - window)
            end = min(len(text), km.end() + window)
            for am in amounts:
                pos = am.start(1)
                if not start <= pos < end:
                    continue
                value = _to_decimal(am.group(1), am.group(2))
                # Reject bare years masquerading as amounts.
                if value is None or value < 1000:
                    continue
                if 2000 <= value <= 2100 and not am.group(2):
                    continue

                if pos in claimed:
                    continue

                if pos >= km.end():
                    distance = pos - km.end()          # amount follows keyword
                else:
                    distance = (km.start() - pos) + 1  # precedes; slight penalty

                if distance < best_distance:
                    best, best_distance = (value, pos), distance

    return best


def _monthly_figures(text: str) -> set[int]:
    """Offsets of the figures stated per month.

    Each period phrase belongs to the one figure it sits beside, preferring the
    figure before it ("EPF 20,000 a month") over the one after it ("monthly
    salary of 250,000"). A figure with no phrase of its own is taken as stated.
    Deciding this per figure, not once for the whole question, is what keeps
    "salary 250,000 per month, bonus 300,000" from multiplying the bonus too.
    """
    figures = [(m.start(1), m.end()) for m in _AMOUNT.finditer(text)]

    def attached(gap: str) -> bool:
        return len(gap) <= _PERIOD_REACH and not _CLAUSE_BREAK.search(gap)

    # figure offset -> (gap length, monthly?); the closest phrase wins.
    period: dict[int, tuple[int, bool]] = {}
    for pattern, monthly in ((_MONTHLY, True), (_ANNUAL, False)):
        for pm in pattern.finditer(text):
            before = [f for f in figures if f[1] <= pm.start()]
            after = [f for f in figures if f[0] >= pm.end()]
            owner: tuple[int, int] | None = None
            if before and attached(text[before[-1][1]:pm.start()]):
                owner, gap = before[-1], pm.start() - before[-1][1]
            elif after and attached(text[pm.end():after[0][0]]):
                owner, gap = after[0], after[0][0] - pm.end()
            if owner is None:
                continue
            if owner[0] not in period or gap < period[owner[0]][0]:
                period[owner[0]] = (gap, monthly)

    return {pos for pos, (_, monthly) in period.items() if monthly}


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


# Scanned before the salary, in this order: clients abroad, then expenses,
# then other business income.
_BUSINESS_FIELDS = (
    (["foreign client", "foreign clients", "clients abroad", "upwork", "fiverr",
      "foreign currency", "from abroad", "in dollars", "paid in usd"], "foreign_service_income"),
    (["business expenses", "expenses", "costs"], "business_expenses"),
    (["business income", "freelance", "self-employed"], "business_income"),
)


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
    # Figures stated per month; each is annualised where it is assigned.
    monthly = _monthly_figures(text)

    def annual(value: Decimal, pos: int) -> Decimal:
        return value * 12 if pos in monthly else value

    # Freelance figures first: "my freelance income is 4,000,000" is not a
    # salary, and the salary scan below would take it for one (#48).
    business_found = False
    for keywords, field_name in _BUSINESS_FIELDS:
        found = _find_amount(text, keywords, claimed=claimed)
        if found is not None:
            value, pos = found
            claimed.add(pos)
            setattr(facts, field_name, annual(value, pos))
            business_found = business_found or field_name != "business_expenses"

    hit = _find_amount(
        text, ["salary", "earn", "income", "paid", "wage", "make", "pay"],
        claimed=claimed,
    )
    if hit is None and not business_found:
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
        facts.employment_income = annual(salary, pos)

    increase_hit = _find_amount(text, _INCREASE_KEYWORDS, claimed=claimed)
    if increase_hit is not None:
        amount, pos = increase_hit
        claimed.add(pos)
        amount = annual(amount, pos)
        facts.employment_income = (facts.employment_income or Decimal(0)) + amount

    decrease_hit = _find_amount(text, _DECREASE_KEYWORDS, claimed=claimed)
    if decrease_hit is not None:
        amount, pos = decrease_hit
        claimed.add(pos)
        amount = annual(amount, pos)
        # A cut larger than the stated salary is a nonsensical input, not a
        # negative-income scenario the compute engine needs to handle.
        facts.employment_income = max(
            Decimal(0), (facts.employment_income or Decimal(0)) - amount
        )

    for keywords, field_name in (
        (["epf", "provident"], "epf_employee"),
        (["apit", "paye", "withheld", "deducted at source"], "apit_withheld"),
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
            setattr(facts, field_name, annual(value, pos))

    return facts
