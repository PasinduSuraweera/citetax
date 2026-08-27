"""Typed domain objects. `TaxFacts` is the minimisation boundary (spec §9.1):
downstream nodes receive this, never the user's original string."""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Any, Literal

from pydantic import BaseModel, Field

YA = Literal["2025/2026", "2026/2027"]


class TaxFacts(BaseModel):
    """Everything the computation needs, and nothing that identifies anyone.

    There is deliberately no name, employer, NIC or TIN field. None of them
    affect a tax computation, so none of them travel.
    """

    ya: YA | None = None
    employment_income: Decimal | None = None
    business_income: Decimal = Decimal(0)
    investment_income: Decimal = Decimal(0)
    other_income: Decimal = Decimal(0)
    epf_employee: Decimal | None = None
    qualifying_payments: Decimal = Decimal(0)
    apit_withheld: Decimal = Decimal(0)
    foreign_tax_credit: Decimal = Decimal(0)
    wht_credit: Decimal = Decimal(0)
    is_resident: bool = True

    # Provenance of the parse, for the UI confirmation screen.
    source: Literal["question", "payslip", "structured"] = "question"

    # The date the rules must be in force on. None means the start of the year
    # of assessment, which is right for annual figures. A question about a
    # transaction on a specific date sets this so a mid-year circular applies.
    as_of: date | None = None

    def missing_required(self) -> list[str]:
        """Fields the Clarify node must ask about before computing."""
        missing: list[str] = []
        if self.ya is None:
            missing.append("ya")
        if self.total_income == 0:
            missing.append("income")
        return missing

    @property
    def total_income(self) -> Decimal:
        return (
            (self.employment_income or Decimal(0))
            + self.business_income
            + self.investment_income
            + self.other_income
        )


class LedgerStep(BaseModel):
    """One row of the computation table. Every step carries the rule version
    that produced it — this is what the verify node checks against."""

    step_no: int
    label: str
    rule_key: str
    rule_version_id: str | None = None
    citation_label: str | None = None
    value: Decimal
    is_zero: bool = False          # rendered greyed, not dropped (spec §6.2 #4)
    detail: dict[str, Any] | None = None   # e.g. per-band breakdown


class Computation(BaseModel):
    ya: str
    steps: list[LedgerStep]
    balance_payable: Decimal
    taxable_income: Decimal
    gross_tax: Decimal
    total_credits: Decimal
    is_refund: bool = False
    rule_version_ids: list[str] = Field(default_factory=list)
    corpus_snapshot_id: str | None = None
