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

# Rules only some taxpayers need. Resolved when a version is in force, left out
# when not; the engine says so in the computation's notes (#48).
OPTIONAL_RULE_KEYS = [
    "deduction.business_expenses",
    "band.foreign_service_cap",
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


def _capped_band_tax(
    start: Decimal, amount: Decimal, band_rule: RuleVersion, max_rate: Decimal
) -> tuple[Decimal, list[dict[str, Any]]]:
    """Tax on `amount` of income placed in the bands from `start` upward, with
    no band's rate above `max_rate`.

    This is how the IRD taxes foreign-currency service income (First Schedule
    1(6); IRD return guide 2025/2026, examples 2 and 3): the ordinary rates,
    at most 15%, on income that sits above the person's local income.
    """
    if amount <= ZERO:
        return ZERO, []
    total = ZERO
    breakdown: list[dict[str, Any]] = []
    lower = ZERO
    end = start + amount
    for band in band_rule.value_json.get("bands", []):
        upto_raw = band.get("upto")
        upper = None if upto_raw is None else _d(upto_raw)
        lo = max(lower, start)
        hi = end if upper is None else min(upper, end)
        if hi > lo:
            rate = min(_d(band["rate"]), max_rate)
            tax = _round((hi - lo) * rate, band_rule.rounding_mode)
            total += tax
            breakdown.append({
                "from": str(lo), "to": str(hi), "rate": str(rate),
                "band_rate": str(_d(band["rate"])), "amount": str(hi - lo), "tax": str(tax),
            })
        if upper is None or upper >= end:
            break
        lower = upper
    return _round(total), breakdown


def compute(facts: TaxFacts, rules: ResolvedRuleSet) -> Computation:
    """Returns an ordered ledger of steps plus the balance payable.

    The canonical 8-step sequence per spec §4.3 for an ordinary case. Steps
    that evaluate to zero are still emitted, marked is_zero, so the headline
    step count always matches the visible table (spec §6.2 #4). Business
    expenses and foreign-currency service income add their own steps, only
    when the facts include them and a rule allowing them is in force (#48).
    """
    steps: list[LedgerStep] = []
    notes: list[str] = []

    def emit(
        label: str,
        rule_key: str,
        value: Decimal,
        detail: dict[str, Any] | None = None,
    ) -> None:
        rv = rules.get(rule_key)
        steps.append(
            LedgerStep(
                step_no=len(steps) + 1,
                label=label,
                rule_key=rule_key,
                rule_version_id=rv.id if rv else None,
                citation_label=rv.citation_label if rv else None,
                value=value,
                is_zero=(value == ZERO),
                detail=detail,
            )
        )

    # --- Income, and business expenses ------------------------------------
    gross_income = _round(facts.total_income)
    business = _round(facts.business_income)
    foreign = _round(facts.foreign_service_income)
    stated_expenses = _round(facts.business_expenses)
    expenses_rule = rules.get("deduction.business_expenses")
    expenses = ZERO
    if stated_expenses > ZERO:
        if expenses_rule is not None:
            expenses = min(stated_expenses, business + foreign)
        else:
            notes.append(
                f"Business expenses of LKR {stated_expenses:,.2f} were not deducted: the rule "
                "allowing them (Act s.11(1)) is not yet a published rule in Citetax."
            )
    income_detail = {
        "employment": str(facts.employment_income or ZERO),
        "business": str(business),
        "foreign_service": str(foreign),
        "investment": str(facts.investment_income),
        "other": str(facts.other_income),
    }
    if expenses > ZERO:
        emit("Income before business expenses", "income.assessable", gross_income, detail=income_detail)
        emit(
            "Less business expenses",
            "deduction.business_expenses",
            expenses,
            detail={"stated": str(stated_expenses), "applied": str(expenses), "capital_excluded": True},
        )
    else:
        emit("Assessable income", "income.assessable", gross_income, detail=income_detail)
    assessable = gross_income - expenses
    # Expenses are set against local business income first; any excess
    # against foreign service income.
    foreign_net = max(foreign - max(expenses - business, ZERO), ZERO)
    local_income = assessable - foreign_net

    # --- EPF employee contribution ---------------------------------------
    # What the rule in force says decides this, not the code (#47). A rule
    # version with "deductible": false keeps the step, at zero and cited, so
    # the user sees that their contribution was considered and why it does not
    # reduce the tax. Otherwise it is deductible up to the statutory rate on
    # employment income, and a figure the user never gave is marked assumed.
    epf_rule = rules["deduction.epf_employee"]
    epf_rate = _d(epf_rule.value_json.get("employee_rate", "0.08"))
    employment = facts.employment_income or ZERO
    epf_cap = _round(employment * epf_rate, epf_rule.rounding_mode)
    stated = facts.epf_employee is not None
    if epf_rule.value_json.get("deductible") is False and employment == ZERO and not stated:
        # No salary, no EPF: a freelancer's ledger shows a plain nil step,
        # not a reason why a contribution they never made is not deducted.
        epf = ZERO
        emit("EPF employee contribution", "deduction.epf_employee", ZERO)
    elif epf_rule.value_json.get("deductible") is False:
        epf = ZERO
        emit(
            "EPF employee contribution, not deductible",
            "deduction.epf_employee",
            ZERO,
            detail={"deductible": False, "contribution": str(_round(facts.epf_employee)) if stated else None},
        )
    else:
        epf = facts.epf_employee if stated else epf_cap
        epf = min(_round(epf), epf_cap) if epf_cap > ZERO else ZERO
        emit(
            "Less EPF employee contribution",
            "deduction.epf_employee",
            epf,
            detail={"rate": str(epf_rate), "cap": str(epf_cap), "assumed": not stated and epf > ZERO},
        )

    # --- Qualifying payments ---------------------------------------------
    qp_rule = rules["deduction.qualifying"]
    qp_cap_raw = qp_rule.value_json.get("annual_cap")
    qp = _round(facts.qualifying_payments)
    if qp_cap_raw is not None:
        qp = min(qp, _d(qp_cap_raw))
    emit(
        "Less qualifying payments",
        "deduction.qualifying",
        qp,
        detail={"cap": str(qp_cap_raw) if qp_cap_raw is not None else None},
    )

    # --- Personal relief -------------------------------------------------
    relief_rule = rules["relief.personal"]
    statutory_relief = _d(relief_rule.value_json["amount"])
    # Relief cannot create a loss, so the amount applied is capped at what is
    # left after deductions. Both figures travel in the detail: the statutory
    # relief is the rule, the applied relief is the ledger, and an explanation
    # that conflates them ("personal relief of 1,380,000") misstates the law.
    relief = min(statutory_relief, max(assessable - epf - qp, ZERO))
    emit(
        "Less personal relief",
        "relief.personal",
        _round(relief),
        detail={
            "statutory": str(statutory_relief),
            "applied": str(_round(relief)),
            "capped": relief < statutory_relief,
        },
    )

    # --- Taxable income --------------------------------------------------
    taxable = _round(max(assessable - epf - qp - relief, ZERO))
    emit("Taxable income", "charge.taxable_income", taxable)

    # --- Tax --------------------------------------------------------------
    band_rule = rules["band.progressive"]
    cap_rule = rules.get("band.foreign_service_cap")
    foreign_tax = ZERO
    if foreign_net > ZERO and cap_rule is not None:
        max_rate = _d(cap_rule.value_json["max_rate"])
        # Relief and qualifying payments may be set against either the local
        # or the foreign income, whichever gives the taxpayer the lower tax
        # (IRD return guide 2025/2026, example 3). EPF, when deductible, is
        # set against employment income, which is local.
        movable = qp + relief

        def split(foreign_first: bool) -> tuple[Decimal, Decimal]:
            if foreign_first:
                f_taxable = max(foreign_net - movable, ZERO)
                excess = max(movable - foreign_net, ZERO)
                return _round(max(local_income - epf - excess, ZERO)), _round(f_taxable)
            l_taxable = max(local_income - epf - movable, ZERO)
            short = max(epf + movable - local_income, ZERO)
            return _round(l_taxable), _round(max(foreign_net - short, ZERO))

        options = []
        for foreign_first in (False, True):
            l_taxable, f_taxable = split(foreign_first)
            l_tax, l_bands = compute_band_tax(l_taxable, band_rule)
            f_tax, f_bands = _capped_band_tax(l_taxable, f_taxable, band_rule, max_rate)
            options.append((l_tax + f_tax, foreign_first, l_taxable, f_taxable, l_tax, l_bands, f_tax, f_bands))
        _, foreign_first, l_taxable, f_taxable, local_tax, l_bands, foreign_tax, f_bands = min(
            options, key=lambda o: (o[0], o[1])
        )
        emit(
            "Tax on local income across bands",
            "band.progressive",
            local_tax,
            detail={"bands": l_bands, "taxable": str(l_taxable)},
        )
        emit(
            f"Tax on foreign-currency service income, at most {max_rate * 100:.0f}%",
            "band.foreign_service_cap",
            foreign_tax,
            detail={
                "bands": f_bands, "taxable": str(f_taxable), "max_rate": str(max_rate),
                "relief_against": "foreign income" if foreign_first else "local income",
            },
        )
        gross_tax = _round(local_tax + foreign_tax)
    else:
        if foreign_net > ZERO:
            notes.append(
                "Foreign-currency service income was taxed at the ordinary rates: the 15% "
                "maximum (First Schedule 1(6)) is not yet a published rule in Citetax."
            )
        gross_tax, band_breakdown = compute_band_tax(taxable, band_rule)
        emit(
            "Gross tax across bands",
            "band.progressive",
            gross_tax,
            detail={"bands": band_breakdown},
        )

    # --- Tax credits (foreign, WHT) --------------------------------------
    # A foreign tax credit is limited to the tax on the foreign income and
    # cannot be set against any other tax (IRD return guide 2025/2026,
    # example 2). Without a separate foreign tax it is limited by the total.
    foreign_credit = _round(facts.foreign_tax_credit)
    if foreign_tax > ZERO:
        foreign_credit = min(foreign_credit, foreign_tax)
    other_credits = min(_round(foreign_credit + facts.wht_credit), gross_tax)
    emit(
        "Less tax credits",
        "credit.foreign_wht",
        other_credits,
        detail={
            "foreign": str(facts.foreign_tax_credit),
            "foreign_allowed": str(foreign_credit),
            "wht": str(facts.wht_credit),
        },
    )

    # --- APIT already withheld -------------------------------------------
    apit = _round(facts.apit_withheld)
    emit("Less APIT already withheld", "credit.apit", apit)

    # --- Balance payable (derived) ---------------------------------------
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
        notes=notes,
    )
