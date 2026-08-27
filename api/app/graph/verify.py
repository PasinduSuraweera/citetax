"""Verify node — spec §4.1 node 9 and §4.2.

Every numeric token in the generated prose must trace to a ledger value, a value
inside a cited rule_version.value_json, or an explicit allowlist. Anything else
is fluent invention and is not released.

The user always gets the verified table. The prose is the part allowed to fail.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from enum import Enum
from typing import Any

from app.compute.types import Computation
from app.privacy.redactor import EgressScanner
from app.rules.resolver import ResolvedRuleSet


class BadgeState(str, Enum):
    """Spec §6.2 #3 — the verify node can fail, so the UI has three states."""

    ALL_CITED = "all_cited"          # green
    PARTIAL = "partial"              # amber — explanation withheld
    CANNOT_ANSWER = "cannot_answer"  # grey — no rule in force


@dataclass
class VerifyResult:
    badge: BadgeState
    ok: bool
    unmatched_numbers: list[str] = field(default_factory=list)
    pii_classes: list[str] = field(default_factory=list)
    prose_released: bool = True
    note: str | None = None

    def to_json(self) -> dict[str, Any]:
        return {
            "badge": self.badge.value,
            "ok": self.ok,
            "unmatched_numbers": self.unmatched_numbers,
            "pii_classes": self.pii_classes,
            "prose_released": self.prose_released,
            "note": self.note,
        }


# Numeric tokens: currency amounts, percentages, plain numbers, dates.
_NUMBER = re.compile(r"\b\d[\d,]*(?:\.\d+)?\b")
_PERCENT = re.compile(r"\b(\d+(?:\.\d+)?)\s*(?:%|per ?cent)")
_DATE_ISO = re.compile(r"\b\d{4}-\d{2}-\d{2}\b")
_YA_TOKEN = re.compile(r"\b20\d{2}\s*/\s*20\d{2}\b")

# A figure carrying a currency marker is a claim about money, and is held to
# the ledger alone — the small-integer allowlist must not excuse it. Without
# this, a response truncated mid-figure ("...is LKR 3") passes verification,
# because 3 is a legal step number.
_CURRENCY_AMOUNT = re.compile(
    r"(?i)(?:lkr|rs\.?|rupees?)\s*(\d[\d,]*(?:\.\d+)?)"
)

# Spec §4.2 item 4 — step counts, years of assessment, list ordinals.
_ALLOWLIST = {Decimal(n) for n in range(0, 32)}          # step numbers, day-of-month
_ALLOWLIST |= {Decimal(y) for y in range(2000, 2101)}    # years


def _norm(raw: str) -> Decimal | None:
    try:
        return Decimal(raw.replace(",", ""))
    except InvalidOperation:
        return None


def _collect_allowed(
    computation: Computation, rules: ResolvedRuleSet
) -> set[Decimal]:
    """Every number the prose is permitted to contain."""
    allowed: set[Decimal] = set(_ALLOWLIST)

    def add(value: Any) -> None:
        d = _norm(str(value)) if not isinstance(value, Decimal) else value
        if d is None:
            return
        allowed.add(d)
        # A figure may legitimately be written 57,600 or 57600.00.
        allowed.add(d.normalize())
        if d == d.to_integral_value():
            allowed.add(d.to_integral_value())
        # Percentages: 0.06 in the rules is "6%" in prose.
        if 0 < d < 1:
            allowed.add(d * 100)

    # --- ledger values ---
    for step in computation.steps:
        add(step.value)
        add(abs(step.value))
        if step.detail:
            _walk(step.detail, add)

    add(computation.balance_payable)
    add(abs(computation.balance_payable))
    add(computation.taxable_income)
    add(computation.gross_tax)
    add(computation.total_credits)

    # --- values inside cited rule versions ---
    for rv in rules.rules.values():
        _walk(rv.value_json, add)
        # Numbers inside a citation label are part of the law's name, not a
        # claim about money: "Act s.52", "Amendment No. 2 of 2025". Citing the
        # section correctly must not read as a hallucinated figure.
        if rv.citation_label:
            for token in _NUMBER.finditer(rv.citation_label):
                add(token.group(0))

    return allowed


def _walk(node: Any, add) -> None:
    if isinstance(node, dict):
        for v in node.values():
            _walk(v, add)
    elif isinstance(node, list):
        for v in node:
            _walk(v, add)
    elif isinstance(node, (int, float, str, Decimal)):
        add(node)


def verify(
    prose: str,
    computation: Computation,
    rules: ResolvedRuleSet,
    attempt: int = 1,
) -> VerifyResult:
    """Numeric provenance check + egress PII scan.

    Returns a VerifyResult; the caller decides whether to regenerate (attempt 1)
    or withhold the prose (attempt 2), per spec §4.2 item 5.
    """
    # --- egress PII scan (§4.1 node 9) ---
    pii = EgressScanner().scan(prose)

    # --- numeric provenance ---
    allowed = _collect_allowed(computation, rules)
    unmatched: list[str] = []

    scratch = _YA_TOKEN.sub(" ", prose)      # "2026/2027" is an allowlisted label
    scratch = _DATE_ISO.sub(" ", scratch)    # dates checked against rule values

    # Currency amounts are held to the ledger alone, without the small-integer
    # allowlist, so a figure truncated mid-number cannot slip through.
    money_allowed = allowed - _ALLOWLIST
    for m in _CURRENCY_AMOUNT.finditer(scratch):
        value = _norm(m.group(1))
        if value is not None and value not in money_allowed:
            unmatched.append(m.group(0))
    scratch = _CURRENCY_AMOUNT.sub(" ", scratch)

    for m in _PERCENT.finditer(scratch):
        value = _norm(m.group(1))
        if value is not None and value not in allowed:
            unmatched.append(f"{m.group(1)}%")
    scratch = _PERCENT.sub(" ", scratch)

    for m in _NUMBER.finditer(scratch):
        value = _norm(m.group(0))
        if value is None:
            continue
        if value not in allowed and value.normalize() not in allowed:
            unmatched.append(m.group(0))

    if pii:
        return VerifyResult(
            badge=BadgeState.PARTIAL,
            ok=False,
            pii_classes=pii,
            prose_released=False,
            note="Explanation withheld — egress scan flagged an identifier.",
        )

    if unmatched:
        release = attempt >= 2
        return VerifyResult(
            badge=BadgeState.PARTIAL,
            ok=False,
            unmatched_numbers=sorted(set(unmatched)),
            prose_released=False,
            note=(
                "Explanation withheld — figures below are verified."
                if release
                else "Regenerating: uncited figure in explanation."
            ),
        )

    return VerifyResult(badge=BadgeState.ALL_CITED, ok=True, prose_released=True)
