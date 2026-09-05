"""Verify node (spec section 4.1 node 9 and 4.2).

Every numeric token in generated prose must trace to something the model was
handed: a ledger value, a value inside a cited rule version, a date in the
compliance result, a number inside a retrieved passage, or an explicit
allowlist. Anything else is fluent invention and is not released.

The user always gets the verified figures. The prose is the part allowed to fail.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from enum import Enum
from typing import Any

from app.compute.types import Computation
from app.graph.comply import Compliance
from app.privacy.redactor import EgressScanner
from app.retrieval.search import Passage
from app.rules.resolver import ResolvedRuleSet, RuleVersion


class BadgeState(str, Enum):
    """Spec section 6.2 addition 3: the verify node can fail, so three states."""

    ALL_CITED = "all_cited"          # green
    PARTIAL = "partial"              # amber, explanation withheld
    CANNOT_ANSWER = "cannot_answer"  # grey, no rule in force


@dataclass
class VerifyResult:
    badge: BadgeState
    ok: bool
    unmatched_numbers: list[str] = field(default_factory=list)
    pii_classes: list[str] = field(default_factory=list)
    prose_released: bool = True
    note: str | None = None
    checked_numbers: int = 0

    def to_json(self) -> dict[str, Any]:
        return {
            "badge": self.badge.value,
            "ok": self.ok,
            "unmatched_numbers": self.unmatched_numbers,
            "pii_classes": self.pii_classes,
            "prose_released": self.prose_released,
            "note": self.note,
            "checked_numbers": self.checked_numbers,
        }


@dataclass
class Evidence:
    """Everything the prose is allowed to draw numbers from."""

    computation: Computation | None = None
    rules: ResolvedRuleSet | None = None
    compliance: Compliance | None = None
    passages: list[Passage] = field(default_factory=list)
    extra_rules: list[RuleVersion] = field(default_factory=list)
    compare: dict[str, Any] | None = None
    days_remaining: int | None = None


_NUMBER = re.compile(r"\b\d[\d,]*(?:\.\d+)?\b")
_PERCENT = re.compile(r"\b(\d+(?:\.\d+)?)\s*(?:%|per ?cent)")
_DATE_ISO = re.compile(r"\b\d{4}-\d{2}-\d{2}\b")
_MONTHS = (
    "January|February|March|April|May|June|July|August|"
    "September|October|November|December|"
    "Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec"
)
# "30 November 2027", "30th November 2027", "30 Nov 2027", "November 30, 2027"
_DATE_WORDS = re.compile(
    rf"\b(\d{{1,2}})(?:st|nd|rd|th)?\s+({_MONTHS})\.?,?\s+(\d{{4}})\b", re.I
)
_DATE_WORDS_US = re.compile(
    rf"\b({_MONTHS})\.?\s+(\d{{1,2}})(?:st|nd|rd|th)?,?\s+(\d{{4}})\b", re.I
)
_YA_TOKEN = re.compile(r"\b20\d{2}\s*/\s*20\d{2}\b")
_CURRENCY_AMOUNT = re.compile(r"(?i)(?:lkr|rs\.?|rupees?)\s*(\d[\d,]*(?:\.\d+)?)")
# "1.8 million", "2.5 mn", "4 lakhs": a legitimate way to write a ledger figure.
_SCALED = re.compile(
    r"(?i)\b(\d+(?:\.\d+)?)\s*(million|mn|m|lakhs?|crores?)\b"
)
_SCALE = {
    "million": Decimal(1_000_000), "mn": Decimal(1_000_000), "m": Decimal(1_000_000),
    "lakh": Decimal(100_000), "lakhs": Decimal(100_000),
    "crore": Decimal(10_000_000), "crores": Decimal(10_000_000),
}

# Step counts, ordinals, days of the month, years.
_ALLOWLIST = {Decimal(n) for n in range(0, 32)}
_ALLOWLIST |= {Decimal(y) for y in range(2000, 2101)}


def _norm(raw: str) -> Decimal | None:
    try:
        return Decimal(raw.replace(",", ""))
    except InvalidOperation:
        return None


def _walk(node: Any, add) -> None:
    if isinstance(node, dict):
        for v in node.values():
            _walk(v, add)
    elif isinstance(node, list):
        for v in node:
            _walk(v, add)
    elif isinstance(node, (int, float, str, Decimal)):
        add(node)


def _collect_allowed(ev: Evidence) -> tuple[set[Decimal], set[str]]:
    """Returns (numbers, iso_dates) the prose may contain."""
    allowed: set[Decimal] = set(_ALLOWLIST)
    dates: set[str] = set()

    def add(value: Any) -> None:
        if isinstance(value, str):
            # ISO dates inside rule values are dates, not amounts.
            if _DATE_ISO.fullmatch(value.strip()):
                dates.add(value.strip())
                return
            # A string may carry several numbers (a passage, a quoted sentence).
            for m in _NUMBER.finditer(value):
                d = _norm(m.group(0))
                if d is not None:
                    _add_decimal(d)
            for m in _PERCENT.finditer(value):
                d = _norm(m.group(1))
                if d is not None:
                    _add_decimal(d)
            return
        d = value if isinstance(value, Decimal) else _norm(str(value))
        if d is not None:
            _add_decimal(d)

    def _add_decimal(d: Decimal) -> None:
        allowed.add(d)
        allowed.add(d.normalize())
        if d == d.to_integral_value():
            allowed.add(d.to_integral_value())
        if 0 < d < 1:
            allowed.add((d * 100).normalize())   # 0.06 in rules is 6% in prose

    if ev.computation:
        c = ev.computation
        for step in c.steps:
            add(step.value)
            add(abs(step.value))
            if step.detail:
                _walk(step.detail, add)
        for v in (c.balance_payable, abs(c.balance_payable), c.taxable_income,
                  c.gross_tax, c.total_credits):
            add(v)

    rule_versions: list[RuleVersion] = list(ev.extra_rules)
    if ev.rules:
        rule_versions.extend(ev.rules.rules.values())
    for rv in rule_versions:
        _walk(rv.value_json, add)
        if rv.citation_label:
            add(rv.citation_label)
        if rv.quoted_text:
            add(rv.quoted_text)
        dates.add(rv.effective_from.isoformat())
        if rv.effective_to:
            dates.add(rv.effective_to.isoformat())

    if ev.compliance:
        if ev.compliance.return_due:
            dates.add(ev.compliance.return_due)
        for d in ev.compliance.instalments:
            dates.add(d)
        if ev.compliance.citation_label:
            add(ev.compliance.citation_label)

    if ev.days_remaining is not None:
        add(ev.days_remaining)

    if ev.compare:
        for ch in ev.compare.get("changes", []):
            _walk(ch.get("from", {}).get("value"), add)
            _walk(ch.get("to", {}).get("value"), add)
            add(ch.get("from", {}).get("citation_label") or "")
            add(ch.get("to", {}).get("citation_label") or "")

    for p in ev.passages:
        add(p.text)
        if p.title:
            add(p.title)

    return allowed, dates


_MONTH_INDEX = {
    m: i + 1
    for i, names in enumerate([
        ("january", "jan"), ("february", "feb"), ("march", "mar"), ("april", "apr"),
        ("may",), ("june", "jun"), ("july", "jul"), ("august", "aug"),
        ("september", "sep", "sept"), ("october", "oct"), ("november", "nov"),
        ("december", "dec"),
    ])
    for m in names
}


def _to_iso(day: str, month_word: str, year: str) -> str | None:
    month = _MONTH_INDEX.get(month_word.lower())
    if not month:
        return None
    return f"{int(year):04d}-{month:02d}-{int(day):02d}"


def verify(prose: str, evidence: Evidence, attempt: int = 1) -> VerifyResult:
    """Numeric provenance check plus egress PII scan."""
    pii = EgressScanner().scan(prose)
    allowed, dates = _collect_allowed(evidence)
    unmatched: list[str] = []
    checked = 0

    scratch = _YA_TOKEN.sub(" ", prose)

    # Dates, in either form, must be dates the material contains.
    for m in _DATE_ISO.finditer(scratch):
        checked += 1
        if m.group(0) not in dates:
            unmatched.append(m.group(0))
    scratch = _DATE_ISO.sub(" ", scratch)

    for m in _DATE_WORDS.finditer(scratch):
        checked += 1
        iso = _to_iso(m.group(1), m.group(2), m.group(3))
        if iso is None or iso not in dates:
            unmatched.append(m.group(0))
    scratch = _DATE_WORDS.sub(" ", scratch)

    for m in _DATE_WORDS_US.finditer(scratch):
        checked += 1
        iso = _to_iso(m.group(2), m.group(1), m.group(3))
        if iso is None or iso not in dates:
            unmatched.append(m.group(0))
    scratch = _DATE_WORDS_US.sub(" ", scratch)

    # A figure with a currency marker is a claim about money: ledger only, no
    # small integer allowlist, so a truncated "LKR 3" cannot slip through.
    money_allowed = allowed - _ALLOWLIST

    # "1.8 million" is LKR 1,800,000 written differently. Scale it and check
    # the scaled value against the money set, then remove it from the text.
    def _scaled(m: re.Match[str]) -> str:
        nonlocal checked
        checked += 1
        value = _norm(m.group(1))
        scale = _SCALE.get(m.group(2).lower())
        if value is None or scale is None:
            unmatched.append(m.group(0))
            return " "
        total = (value * scale).normalize()
        if total not in money_allowed and total.to_integral_value() not in money_allowed:
            unmatched.append(m.group(0))
        return " "

    scratch = re.sub(r"(?i)\b(?:lkr|rs\.?|rupees?)\s*(?=\d+(?:\.\d+)?\s*(?:million|mn|m|lakhs?|crores?)\b)", " ", scratch)
    scratch = _SCALED.sub(_scaled, scratch)
    for m in _CURRENCY_AMOUNT.finditer(scratch):
        checked += 1
        value = _norm(m.group(1))
        if value is not None and value not in money_allowed and value.normalize() not in money_allowed:
            unmatched.append(m.group(0))
    scratch = _CURRENCY_AMOUNT.sub(" ", scratch)

    for m in _PERCENT.finditer(scratch):
        checked += 1
        value = _norm(m.group(1))
        if value is not None and value not in allowed and value.normalize() not in allowed:
            unmatched.append(f"{m.group(1)}%")
    scratch = _PERCENT.sub(" ", scratch)

    for m in _NUMBER.finditer(scratch):
        value = _norm(m.group(0))
        if value is None:
            continue
        checked += 1
        if value not in allowed and value.normalize() not in allowed:
            unmatched.append(m.group(0))

    if pii:
        return VerifyResult(
            badge=BadgeState.PARTIAL, ok=False, pii_classes=pii,
            prose_released=False, checked_numbers=checked,
            note="Explanation withheld: the egress scan found an identifier.",
        )

    if unmatched:
        return VerifyResult(
            badge=BadgeState.PARTIAL, ok=False,
            unmatched_numbers=sorted(set(unmatched)),
            prose_released=False, checked_numbers=checked,
            note=(
                "Explanation withheld: a figure could not be traced to the law or the ledger. The figures shown are verified."
                if attempt >= 2
                else "Regenerating: an uncited figure appeared in the explanation."
            ),
        )

    return VerifyResult(
        badge=BadgeState.ALL_CITED, ok=True, prose_released=True,
        checked_numbers=checked,
    )
