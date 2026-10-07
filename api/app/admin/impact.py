"""Impact preview (spec section 5.1 D). The feature that makes reviewing safe.

Before approving, run the golden set of taxpayer scenarios against the proposed
corpus and show what changes. The reviewer is approving a consequence, not a
field.

Obligation flips are called out separately because moving someone from "must
file" to "need not file" is the highest consequence change a rule can make.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from typing import Any

from sqlalchemy.engine import Connection

from app.compute.engine import OPTIONAL_RULE_KEYS, REQUIRED_RULE_KEYS, compute
from app.compute.types import TaxFacts
from app.graph import comply
from app.rules.resolver import (
    ResolvedRuleSet,
    RuleVersion,
    UnresolvedRule,
    resolve_many,
    ya_end_date,
    ya_start_date,
)

NEEDED = REQUIRED_RULE_KEYS + ["deadline.return_filing"]


@dataclass
class Scenario:
    name: str
    ya: str
    facts: TaxFacts


@dataclass
class CaseDelta:
    scenario: str
    ya: str
    old_balance: Decimal | None
    new_balance: Decimal | None
    delta: Decimal | None
    old_must_file: bool | None
    new_must_file: bool | None
    error: str | None = None

    @property
    def changed(self) -> bool:
        return self.delta is not None and self.delta != 0

    @property
    def obligation_flip(self) -> bool:
        return (
            self.old_must_file is not None
            and self.new_must_file is not None
            and self.old_must_file != self.new_must_file
        )

    def to_json(self) -> dict[str, Any]:
        def s(v: Decimal | None) -> str | None:
            return f"{v:.2f}" if v is not None else None

        return {
            "scenario": self.scenario,
            "ya": self.ya,
            "old_balance": s(self.old_balance),
            "new_balance": s(self.new_balance),
            "delta": s(self.delta),
            "changed": self.changed,
            "old_must_file": self.old_must_file,
            "new_must_file": self.new_must_file,
            "obligation_flip": self.obligation_flip,
            "error": self.error,
        }


@dataclass
class ImpactReport:
    total: int
    changed: int
    obligation_flips: int
    min_delta: Decimal | None
    median_delta: Decimal | None
    max_delta: Decimal | None
    cases: list[CaseDelta] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    # Years a proposal was left out of because it is not in force then.
    notes: list[str] = field(default_factory=list)

    def to_json(self) -> dict[str, Any]:
        def s(v: Decimal | None) -> str | None:
            return f"{v:.2f}" if v is not None else None

        return {
            "total": self.total,
            "changed": self.changed,
            "obligation_flips": self.obligation_flips,
            "min_delta": s(self.min_delta),
            "median_delta": s(self.median_delta),
            "max_delta": s(self.max_delta),
            # Cases that actually moved come first: those are what a reviewer
            # needs to look at.
            "cases": [
                c.to_json()
                for c in sorted(
                    self.cases,
                    key=lambda c: (not c.obligation_flip, not c.changed, c.scenario),
                )
            ],
            "errors": self.errors,
            "notes": self.notes,
        }


def golden_set() -> list[Scenario]:
    """Taxpayer scenarios spanning both years, every band boundary, and the
    relief threshold (spec section 11). Grows toward 120 as the corpus does."""
    out: list[Scenario] = []
    from app.core import years

    for ya in years.supported():
        cases: list[tuple[str, dict[str, Any]]] = [
            ("no income", {"employment_income": "0"}),
            ("below relief", {"employment_income": "1500000"}),
            ("at relief threshold", {"employment_income": "1800000"}),
            ("just over relief", {"employment_income": "1900000"}),
            ("salaried 3m", {"employment_income": "3000000"}),
            ("salaried 3m with APIT", {"employment_income": "3000000",
                                       "apit_withheld": "57600"}),
            ("salaried 3m overwithheld", {"employment_income": "3000000",
                                          "apit_withheld": "100000"}),
            ("band 1 top", {"employment_income": "2800000"}),
            ("band 2 entry", {"employment_income": "2900000"}),
            ("band 2 top", {"employment_income": "3300000"}),
            ("band 3 entry", {"employment_income": "3400000"}),
            ("band 3 top", {"employment_income": "3800000"}),
            ("band 4 entry", {"employment_income": "3900000"}),
            ("band 4 top", {"employment_income": "4300000"}),
            ("top band", {"employment_income": "6000000"}),
            ("high earner", {"employment_income": "12000000"}),
            ("freelance only", {"employment_income": "0",
                                "business_income": "2500000"}),
            ("mixed income", {"employment_income": "2000000",
                              "business_income": "1000000",
                              "investment_income": "500000"}),
            ("with qualifying payments", {"employment_income": "4000000",
                                          "qualifying_payments": "300000"}),
            ("with foreign credit", {"employment_income": "4000000",
                                     "foreign_tax_credit": "50000"}),
            # Freelancers (#48): expenses, clients abroad, and both at once.
            ("freelance with expenses", {"business_income": "4000000",
                                         "business_expenses": "1000000"}),
            ("foreign clients only", {"foreign_service_income": "6000000"}),
            ("local and foreign lecturing", {"business_income": "5000000",
                                             "foreign_service_income": "9000000",
                                             "foreign_tax_credit": "1800000"}),
        ]
        for name, kw in cases:
            out.append(
                Scenario(
                    name=name,
                    ya=ya,
                    facts=TaxFacts(
                        ya=ya,
                        source="structured",
                        **{k: Decimal(v) for k, v in kw.items()},
                    ),
                )
            )
    return out


def _run(facts: TaxFacts, rules: ResolvedRuleSet) -> tuple[Decimal, bool]:
    c = compute(facts, rules)
    return c.balance_payable, comply.assess(c, rules).must_file


def _median(values: list[Decimal]) -> Decimal | None:
    if not values:
        return None
    ordered = sorted(values)
    mid = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[mid]
    return (ordered[mid - 1] + ordered[mid]) / 2


def preview(
    conn: Connection,
    snapshot_id: str,
    proposed: dict[str, RuleVersion],
    as_of: date | None = None,
) -> ImpactReport:
    """Compare the current corpus against the same corpus with `proposed`
    substituted in, across the golden set.

    `proposed` maps rule_key to the version that would replace it. Nothing is
    written; this is a dry run over the compute engine, which is pure Python
    and needs no network.
    """
    scenarios = golden_set()
    cases: list[CaseDelta] = []
    errors: list[str] = []
    notes: list[str] = []
    deltas: list[Decimal] = []

    # Resolve the baseline once per year rather than per scenario.
    baseline: dict[str, ResolvedRuleSet] = {}
    for ya in {s.ya for s in scenarios}:
        try:
            baseline[ya] = resolve_many(conn, NEEDED, ya, snapshot_id, as_of, optional=OPTIONAL_RULE_KEYS)
        except UnresolvedRule as exc:
            errors.append(f"{ya}: {exc}")

    for scenario in scenarios:
        base = baseline.get(scenario.ya)
        if base is None:
            cases.append(
                CaseDelta(scenario.name, scenario.ya, None, None, None, None, None,
                          error="baseline could not be resolved")
            )
            continue

        # A proposal only replaces the rule in years it is in force for, on
        # the same date the resolver would use, so a circular dated August
        # 2026 does not appear to change 2025/2026.
        when = min(max(base.as_of or ya_start_date(scenario.ya), ya_start_date(scenario.ya)),
                   ya_end_date(scenario.ya))
        applicable = {
            k: v for k, v in proposed.items()
            if v.effective_from <= when and (v.effective_to is None or v.effective_to >= when)
        }
        for k, v in proposed.items():
            note = (f"{k} is not in force on {when.isoformat()} ({scenario.ya}), "
                    f"so {scenario.ya} cases are unchanged by it.")
            if k not in applicable and note not in notes:
                notes.append(note)
        after = ResolvedRuleSet(
            ya=base.ya, snapshot_id=base.snapshot_id, as_of=base.as_of,
            rules={**base.rules, **applicable},
        )

        try:
            old_balance, old_file = _run(scenario.facts, base)
            new_balance, new_file = _run(scenario.facts, after)
        except Exception as exc:  # noqa: BLE001 — a bad proposal must not 500
            cases.append(
                CaseDelta(scenario.name, scenario.ya, None, None, None, None, None,
                          error=str(exc)[:200])
            )
            errors.append(f"{scenario.name} ({scenario.ya}): {str(exc)[:120]}")
            continue

        delta = new_balance - old_balance
        if delta != 0:
            deltas.append(delta)
        cases.append(
            CaseDelta(scenario.name, scenario.ya, old_balance, new_balance,
                      delta, old_file, new_file)
        )

    changed = [c for c in cases if c.changed]
    return ImpactReport(
        total=len(cases),
        changed=len(changed),
        obligation_flips=sum(1 for c in cases if c.obligation_flip),
        min_delta=min(deltas) if deltas else None,
        median_delta=_median(deltas),
        max_delta=max(deltas) if deltas else None,
        cases=cases,
        errors=errors,
        notes=notes,
    )
