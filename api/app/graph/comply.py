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
from app.rules.resolver import ResolvedRuleSet, RuleVersion


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


def _apit_only(computation: Computation, exemption: RuleVersion) -> bool:
    """Act s.94(1)(c) and (d): the only income is employment income, with APIT
    deducted and nothing left to pay, plus interest of at most the rule's limit.

    The facts keep interest with other investment income, so investment
    income within the limit is read as that interest. Tax on so small a sum
    cannot exceed the sum itself, which bounds the balance it leaves.
    """
    income = next(
        (s.detail or {} for s in computation.steps if s.rule_key == "income.assessable"), {}
    )

    def amount(key: str) -> Decimal:
        return Decimal(str(income.get(key) or 0))

    if amount("employment") <= 0:
        return False
    if any(amount(k) != 0 for k in ("business", "foreign_service", "other")):
        return False
    if any(s.rule_key == "deduction.business_expenses" for s in computation.steps):
        return False
    interest = amount("investment")
    if interest > Decimal(str(exemption.value_json.get("interest_limit", 0))):
        return False
    apit = next((s.value for s in computation.steps if s.rule_key == "credit.apit"), Decimal(0))
    return apit > 0 and computation.balance_payable <= interest


def assess(computation: Computation, rules: ResolvedRuleSet) -> Compliance:
    """Filing obligation and dates for the computed year.

    A taxpayer with taxable income above zero has a filing obligation, unless
    their tax is all on employment income and their employer has deducted it
    as APIT (Act s.94(1)(c), and (d) for small interest income), when no
    return and no instalments are due. Someone whose income falls entirely
    within personal relief generally does not, though APIT withheld is itself
    a reason to file — that is how a refund is claimed.
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
    exemption = rules.get("filing.apit_exemption")

    if computation.taxable_income > 0 and exemption and _apit_only(computation, exemption):
        # More APIT than tax: as below, a refund is a reason to file, since a
        # return is how it is claimed (s.94(3) lets an exempt person file).
        refund = computation.balance_payable < 0
        return Compliance(
            must_file=refund,
            reason=(
                "Your employer deducted more APIT than your tax. A return is how the excess "
                "is refunded; otherwise no return or instalments would be required."
                if refund else
                "Your tax is all on employment income and your employer deducts it as APIT, "
                "so no return and no instalments are required."
            ),
            return_due=due,
            instalments=[],
            rule_version_id=exemption.id,
            citation_label=exemption.citation_label,
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
