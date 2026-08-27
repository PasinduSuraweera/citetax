"""API response shapes. The ledger shape is baked into the API contract, the
export format and the golden set (spec §4.3), so it is defined once here."""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from pydantic import BaseModel, Field

from app.graph.answer import AnswerResult


class AskRequest(BaseModel):
    question: str = Field(min_length=1, max_length=4000)
    ya: str | None = None


class ComputeRequest(BaseModel):
    """Structured facts → ledger only, no LLM in path (spec §8)."""

    ya: str
    employment_income: Decimal = Decimal(0)
    business_income: Decimal = Decimal(0)
    investment_income: Decimal = Decimal(0)
    other_income: Decimal = Decimal(0)
    epf_employee: Decimal | None = None
    qualifying_payments: Decimal = Decimal(0)
    apit_withheld: Decimal = Decimal(0)
    foreign_tax_credit: Decimal = Decimal(0)
    wht_credit: Decimal = Decimal(0)


def _money(value: Decimal) -> str:
    """Money crosses the wire as a string. A float would silently lose the
    precision the Decimal engine exists to preserve."""
    return f"{value:.2f}"


def serialise_answer(result: AnswerResult) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "kind": result.kind,
        "badge": result.badge.value,
        "ya": result.ya,
        "snapshot": result.snapshot,
        "trace": [t.to_json() for t in result.trace],
        "latency_ms": result.latency_ms,
    }

    if result.kind == "refusal":
        payload["refusal"] = {
            "reason": result.refusal_reason,
            "pointer": result.refusal_pointer,
        }
        return payload

    if result.kind == "clarify":
        payload["clarify"] = {"question": result.clarify_question}
        return payload

    c = result.computation
    assert c is not None
    payload["computation"] = {
        "steps": [
            {
                "step_no": s.step_no,
                "label": s.label,
                "rule_key": s.rule_key,
                "rule_version_id": s.rule_version_id,
                "citation_label": s.citation_label,
                "value": _money(s.value),
                "is_zero": s.is_zero,
                "detail": s.detail,
            }
            for s in c.steps
        ],
        "balance_payable": _money(c.balance_payable),
        "taxable_income": _money(c.taxable_income),
        "gross_tax": _money(c.gross_tax),
        "is_refund": c.is_refund,
        "step_count": len(c.steps),
    }

    if result.compliance:
        payload["compliance"] = result.compliance.to_json()

    payload["explanation"] = result.prose
    payload["verify"] = result.verify_result.to_json() if result.verify_result else None

    # Citation cards — one per rule version, with lineage (spec §6.2 #2).
    if result.rules:
        payload["citations"] = [
            {
                "rule_key": rv.rule_key,
                "rule_version_id": rv.id,
                "label": rv.citation_label,
                "revision_no": rv.revision_no,
                "effective_from": rv.effective_from.isoformat(),
                "effective_to": rv.effective_to.isoformat() if rv.effective_to else None,
                "supersedes_version_id": rv.supersedes_version_id,
                "quoted_text": rv.quoted_text,
            }
            for rv in result.rules.rules.values()
        ]

    return payload
