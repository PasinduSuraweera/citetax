"""Tax-saving scenarios — what a bigger deduction would do to the balance.

Pure Python, like the engine, and built on it: every figure here is the
difference between two runs of `compute`, so a saving is never estimated or
written by a model. The advisor does not say what qualifies as a qualifying
payment; that is the law's job. It shows the effect of one, cited to the rule
that allows the deduction.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

from app.compute.engine import ZERO, _d, compute
from app.compute.types import Computation, TaxFacts
from app.rules.resolver import ResolvedRuleSet

QUALIFYING_KEY = "deduction.qualifying"
BAND_KEY = "band.progressive"

# Round figures people actually think in, in annual LKR.
SCENARIO_STEPS = (Decimal(100_000), Decimal(250_000), Decimal(500_000))


@dataclass
class Lever:
    kind: str                       # qualifying_payments | band_edge
    extra_deduction: Decimal        # further qualifying payments assumed
    tax_saved: Decimal
    new_balance: Decimal
    rule_key: str = QUALIFYING_KEY
    rule_version_id: str | None = None
    citation_label: str | None = None
    detail: dict[str, Any] = field(default_factory=dict)

    def to_json(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "extra_deduction": f"{self.extra_deduction:.2f}",
            "tax_saved": f"{self.tax_saved:.2f}",
            "new_balance": f"{self.new_balance:.2f}",
            "rule_key": self.rule_key,
            "rule_version_id": self.rule_version_id,
            "citation_label": self.citation_label,
            "detail": self.detail,
        }


@dataclass
class Savings:
    ya: str
    baseline_balance: Decimal
    marginal_rate: Decimal | None
    levers: list[Lever]

    def to_json(self) -> dict[str, Any]:
        return {
            "ya": self.ya,
            "baseline_balance": f"{self.baseline_balance:.2f}",
            "marginal_rate": None if self.marginal_rate is None else str(self.marginal_rate),
            "levers": [lever.to_json() for lever in self.levers],
        }


def _headroom(facts: TaxFacts, rules: ResolvedRuleSet) -> Decimal | None:
    """How much more can be claimed. None means the rule sets no cap."""
    cap = rules[QUALIFYING_KEY].value_json.get("annual_cap")
    if cap is None:
        return None
    return max(_d(cap) - facts.qualifying_payments, ZERO)


def _lever(
    kind: str,
    extra: Decimal,
    facts: TaxFacts,
    rules: ResolvedRuleSet,
    baseline: Computation,
    detail: dict[str, Any] | None = None,
) -> Lever | None:
    """Runs the engine with `extra` more qualifying payments. None if it saves nothing."""
    if extra <= ZERO:
        return None
    alt = compute(
        facts.model_copy(update={"qualifying_payments": facts.qualifying_payments + extra}),
        rules,
    )
    saved = baseline.balance_payable - alt.balance_payable
    if saved <= ZERO:
        return None
    rv = rules.get(QUALIFYING_KEY)
    return Lever(
        kind=kind,
        extra_deduction=extra,
        tax_saved=saved,
        new_balance=alt.balance_payable,
        rule_version_id=rv.id if rv else None,
        citation_label=rv.citation_label if rv else None,
        detail=detail or {},
    )


def analyse(facts: TaxFacts, rules: ResolvedRuleSet, baseline: Computation) -> Savings | None:
    """Scenarios that lower the balance, or None when there is nothing to show
    (no tax due, or no headroom left)."""
    if baseline.taxable_income <= ZERO or baseline.gross_tax <= ZERO:
        return None

    band_step = next((s for s in baseline.steps if s.rule_key == BAND_KEY), None)
    bands = (band_step.detail or {}).get("bands", []) if band_step else []
    marginal = _d(bands[-1]["rate"]) if bands else None

    headroom = _headroom(facts, rules)

    def clamp(amount: Decimal) -> Decimal:
        amount = min(amount, baseline.taxable_income)   # past this, nothing is left to deduct
        return amount if headroom is None else min(amount, headroom)

    levers: list[Lever] = []
    seen: set[Decimal] = set()

    # The slice of income sitting in the top band. Clearing it moves that slice
    # into a lower band, which is the most a single deduction can do per rupee.
    if len(bands) > 1:
        edge = _d(bands[-1]["from"])
        extra = clamp(baseline.taxable_income - edge)
        lever = _lever(
            "band_edge", extra, facts, rules, baseline,
            detail={"band_rate": str(marginal), "band_from": str(edge)},
        )
        if lever:
            levers.append(lever)
            seen.add(lever.extra_deduction)

    for step in SCENARIO_STEPS:
        extra = clamp(step)
        if extra in seen:
            continue
        lever = _lever("qualifying_payments", extra, facts, rules, baseline)
        if lever:
            levers.append(lever)
            seen.add(extra)

    if not levers:
        return None
    levers.sort(key=lambda lv: (lv.kind != "band_edge", lv.extra_deduction))
    return Savings(
        ya=rules.ya,
        baseline_balance=baseline.balance_payable,
        marginal_rate=marginal,
        levers=levers,
    )
