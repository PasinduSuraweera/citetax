"""Comply node — spec §4.1 node 6.

Obligation, deadlines, instalments. Deterministic, sourced from the resolved
deadline rule rather than from constants in this file.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from typing import Any

from app.compute.types import Computation
from app.rules.resolver import ResolvedRuleSet


@dataclass
class Compliance:
    must_file: bool
    reason: str
    return_due: str | None = None
    instalments: list[str] = field(default_factory=list)
    rule_version_id: str | None = None
    citation_label: str | None = None

    def to_json(self) -> dict[str, Any]:
        return {
            "must_file": self.must_file,
            "reason": self.reason,
            "return_due": self.return_due,
            "instalments": self.instalments,
            "rule_version_id": self.rule_version_id,
            "citation_label": self.citation_label,
        }


def assess(computation: Computation, rules: ResolvedRuleSet) -> Compliance:
    """Filing obligation and dates for the computed year.

    A taxpayer with taxable income above zero has a filing obligation. Someone
    whose income falls entirely within personal relief generally does not,
    though APIT withheld is itself a reason to file — that is how a refund is
    claimed.
    """
    deadline = rules.get("deadline.return_filing")
    due = None
    instalments: list[str] = []
    if deadline:
        due = deadline.value_json.get("due")
        instalments = list(deadline.value_json.get("instalments", []))

    apit = next(
        (s.value for s in computation.steps if s.rule_key == "credit.apit"),
        Decimal(0),
    )

    if computation.taxable_income > 0:
        must_file, reason = True, "Taxable income exceeds the personal relief threshold."
    elif apit > 0:
        must_file, reason = (
            True,
            "No tax is payable, but APIT was withheld — a return is how that is "
            "refunded.",
        )
    else:
        must_file, reason = (
            False,
            "Income falls within the personal relief threshold and no tax was "
            "withheld.",
        )

    return Compliance(
        must_file=must_file,
        reason=reason,
        return_due=due,
        instalments=instalments,
        rule_version_id=deadline.id if deadline else None,
        citation_label=deadline.citation_label if deadline else None,
    )


def days_until(due: str | None, today: date | None = None) -> int | None:
    if not due:
        return None
    today = today or date.today()
    return (date.fromisoformat(due) - today).days
