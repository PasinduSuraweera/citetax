"""Ways to pay less, from the person's own facts.

Each item appears only when it applies, and every figure in it is the
difference between two runs of `compute`, never an estimate. Nothing here
says what the law allows beyond the rules already in force.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Any

from app.compute.engine import ZERO, compute
from app.compute.types import Computation, TaxFacts
from app.rules.resolver import ResolvedRuleSet

# A round figure to show the effect of business expenses with.
EXPENSE_EXAMPLE = Decimal(100_000)


@dataclass
class Saving:
    kind: str                  # business_expenses | apit_refund | wht_credit
    text: str
    rule_key: str
    citation_label: str | None

    def to_json(self) -> dict[str, Any]:
        return {"kind": self.kind, "text": self.text, "rule_key": self.rule_key, "citation_label": self.citation_label}


def _lkr(value: Decimal) -> str:
    return f"LKR {value:,.0f}"


def analyse(facts: TaxFacts, rules: ResolvedRuleSet, baseline: Computation) -> list[Saving]:
    found: list[Saving] = []

    def cite(key: str) -> str | None:
        rv = rules.get(key)
        return rv.citation_label if rv else None

    # Business income with no expenses stated, and the rule allowing them in force.
    if facts.business_income > ZERO and facts.business_expenses == ZERO and rules.get("deduction.business_expenses"):
        extra = min(EXPENSE_EXAMPLE, facts.business_income)
        alt = compute(facts.model_copy(update={"business_expenses": extra}), rules)
        saved = baseline.gross_tax - alt.gross_tax
        if saved > ZERO:
            found.append(Saving(
                "business_expenses",
                f"Expenses you paid to earn your business income come off it. "
                f"{_lkr(extra)} of them would lower the tax by {_lkr(saved)}.",
                "deduction.business_expenses",
                cite("deduction.business_expenses"),
            ))

    # APIT the person stated, more than the year's tax. An assumed APIT never
    # makes a refund, so this is only ever their own figure.
    if baseline.is_refund and facts.apit_withheld is not None:
        found.append(Saving(
            "apit_refund",
            f"Your employer deducted {_lkr(-baseline.balance_payable)} more than the tax for the year. "
            "Filing a return claims it back.",
            "credit.apit",
            cite("credit.apit"),
        ))

    # Interest or other investment income, with no tax withheld stated.
    if facts.investment_income > ZERO and facts.wht_credit == ZERO and baseline.gross_tax > ZERO:
        found.append(Saving(
            "wht_credit",
            "Tax your bank withheld on this income counts against what you owe. "
            "Add the amount and the balance drops by it.",
            "credit.foreign_wht",
            cite("credit.foreign_wht"),
        ))

    return found
