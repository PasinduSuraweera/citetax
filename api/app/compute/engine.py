"""The computation engine — spec §4.3.

Pure Python. No network, no model, no database. Fully unit-testable.
Every step carries the rule_version_id that produced it.

This module is the reason Citetax can claim "every number, cited": the LLM is
structurally absent from this path. It cannot invent a figure here because it
is never called here.
"""

from __future__ import annotations

from decimal import ROUND_DOWN, ROUND_HALF_UP, Decimal
from typing import Any

from app.compute.types import Computation, LedgerStep, TaxFacts
from app.rules.resolver import ResolvedRuleSet, RuleVersion

# Rules every employment-income computation needs. Resolved up front (node 4)
# so a missing rule refuses cleanly instead of producing a half-built ledger.
REQUIRED_RULE_KEYS = [
    "income.assessable",
    "deduction.epf_employee",
    "deduction.qualifying",
    "relief.personal",
    "charge.taxable_income",
    "band.progressive",
    "credit.foreign_wht",
    "credit.apit",
]

ZERO = Decimal("0")


def _round(value: Decimal, mode: str = "half_up") -> Decimal:
    """Rounding is per-rule, taken from the rules table — never hardcoded."""
    rounding = ROUND_DOWN if mode == "down" else ROUND_HALF_UP
    return value.quantize(Decimal("0.01"), rounding=rounding)


def _d(value: Any) -> Decimal:
    """Coerce a JSON number to Decimal without going through float."""
    if isinstance(value, Decimal):
        return value
    return Decimal(str(value))


def compute_band_tax(
    taxable: Decimal, band_rule: RuleVersion
) -> tuple[Decimal, list[dict[str, Any]]]:
    """Apply a progressive band table.

    value_json shape:
        {"bands": [{"upto": 1000000, "rate": 0.06}, ..., {"upto": null, "rate": 0.36}]}
    `upto` is the cumulative top edge of the band; null means "and above".
    Returns (gross_tax, per_band_breakdown).
    """
    bands = band_rule.value_json.get("bands", [])
    if not bands:
        raise ValueError(f"band rule {band_rule.id} has no bands")

    gross = ZERO
    breakdown: list[dict[str, Any]] = []
    lower = ZERO

    for band in bands:
        upto_raw = band.get("upto")
        upper = None if upto_raw is None else _d(upto_raw)
        rate = _d(band["rate"])

        if upper is None:
            slice_amount = max(taxable - lower, ZERO)
        else:
            slice_amount = max(min(taxable, upper) - lower, ZERO)

        if slice_amount > ZERO:
            band_tax = _round(slice_amount * rate, band_rule.rounding_mode)
            gross += band_tax
            breakdown.append(
                {
                    "from": str(lower),
                    "to": "and above" if upper is None else str(upper),
                    "rate": str(rate),
                    "amount": str(slice_amount),
                    "tax": str(band_tax),
                }
            )

        if upper is None:
            break
        lower = upper
        if taxable <= lower:
            break

    return _round(gross, band_rule.rounding_mode), breakdown


def compute(facts: TaxFacts, rules: ResolvedRuleSet) -> Computation:
    """Returns an ordered ledger of steps plus the balance payable.

    Canonical 8-step sequence per spec §4.3. Steps that evaluate to zero are
    still emitted, marked is_zero, so the headline step count always matches
    the visible table (spec §6.2 #4).
    """
    steps: list[LedgerStep] = []

    def emit(
        step_no: int,
        label: str,
        rule_key: str,
        value: Decimal,
        detail: dict[str, Any] | None = None,
    ) -> None:
        rv = rules.get(rule_key)
        steps.append(
            LedgerStep(
                step_no=step_no,
                label=label,
                rule_key=rule_key,
                rule_version_id=rv.id if rv else None,
                citation_label=rv.citation_label if rv else None,
                value=value,
                is_zero=(value == ZERO),
                detail=detail,
            )
        )

    # --- Step 1: Assessable income -----------------------------------------
    assessable = _round(facts.total_income)
    emit(
        1,
        "Assessable income",
        "income.assessable",
        assessable,
        detail={
            "employment": str(facts.employment_income or ZERO),
            "business": str(facts.business_income),
            "investment": str(facts.investment_income),
            "other": str(facts.other_income),
        },
    )

    # --- Step 2: EPF employee contribution ---------------------------------
    # Deductible up to the statutory rate on employment income only.
    epf_rule = rules["deduction.epf_employee"]
    epf_rate = _d(epf_rule.value_json.get("employee_rate", "0.08"))
    employment = facts.employment_income or ZERO
    epf_cap = _round(employment * epf_rate, epf_rule.rounding_mode)
    epf = facts.epf_employee if facts.epf_employee is not None else epf_cap
    epf = min(_round(epf), epf_cap) if epf_cap > ZERO else ZERO
    emit(
        2,
        "Less EPF employee contribution",
        "deduction.epf_employee",
        epf,
        detail={"rate": str(epf_rate), "cap": str(epf_cap)},
    )

    # --- Step 3: Qualifying payments / other deductions --------------------
    qp_rule = rules["deduction.qualifying"]
    qp_cap_raw = qp_rule.value_json.get("annual_cap")
    qp = _round(facts.qualifying_payments)
    if qp_cap_raw is not None:
        qp = min(qp, _d(qp_cap_raw))
    emit(
        3,
        "Less qualifying payments",
        "deduction.qualifying",
        qp,
        detail={"cap": str(qp_cap_raw) if qp_cap_raw is not None else None},
    )

    # --- Step 4: Personal relief -------------------------------------------
    relief_rule = rules["relief.personal"]
    statutory_relief = _d(relief_rule.value_json["amount"])
    # Relief cannot create a loss, so the amount applied is capped at what is
    # left after deductions. Both figures travel in the detail: the statutory
    # relief is the rule, the applied relief is the ledger, and an explanation
    # that conflates them ("personal relief of 1,380,000") misstates the law.
    relief = min(statutory_relief, max(assessable - epf - qp, ZERO))
    emit(
        4,
        "Less personal relief",
        "relief.personal",
        _round(relief),
        detail={
            "statutory": str(statutory_relief),
            "applied": str(_round(relief)),
            "capped": relief < statutory_relief,
        },
    )

    # --- Step 5: Taxable income --------------------------------------------
    taxable = max(assessable - epf - qp - relief, ZERO)
    taxable = _round(taxable)
    emit(5, "Taxable income", "charge.taxable_income", taxable)

    # --- Step 6: Gross tax across bands ------------------------------------
    band_rule = rules["band.progressive"]
    gross_tax, band_breakdown = compute_band_tax(taxable, band_rule)
    emit(
        6,
        "Gross tax across bands",
        "band.progressive",
        gross_tax,
        detail={"bands": band_breakdown},
    )

    # --- Step 7: Tax credits (foreign, WHT) --------------------------------
    other_credits = _round(facts.foreign_tax_credit + facts.wht_credit)
    other_credits = min(other_credits, gross_tax)
    emit(
        7,
        "Less tax credits",
        "credit.foreign_wht",
        other_credits,
        detail={
            "foreign": str(facts.foreign_tax_credit),
            "wht": str(facts.wht_credit),
        },
    )

    # --- Step 8: APIT already withheld -------------------------------------
    apit = _round(facts.apit_withheld)
    emit(8, "Less APIT already withheld", "credit.apit", apit)

    # --- Balance payable (derived) -----------------------------------------
    balance = _round(gross_tax - other_credits - apit)

    return Computation(
        ya=rules.ya,
        steps=steps,
        balance_payable=balance,
        taxable_income=taxable,
        gross_tax=gross_tax,
        total_credits=_round(other_credits + apit),
        is_refund=balance < ZERO,
        rule_version_ids=[s.rule_version_id for s in steps if s.rule_version_id],
        corpus_snapshot_id=rules.snapshot_id,
    )
