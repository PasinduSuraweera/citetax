"""API response shapes. The ledger shape is baked into the API contract, the
export format and the golden set (spec section 4.3), so it is defined once here."""

from __future__ import annotations

import uuid
from decimal import Decimal
from typing import Any, Literal

from pydantic import BaseModel, Field

from app.graph.answer import AnswerResult
from app.rules.resolver import RuleVersion


class AskRequest(BaseModel):
    question: str = Field(min_length=1, max_length=4000)
    ya: str | None = None
    # Signed in only. The conversation this question continues; omitted, a
    # signed in question starts a new one.
    conversation_id: uuid.UUID | None = None
    # Ask an answered turn of that conversation again, with the facts stored
    # on its run, against the current snapshot. The stored question is used
    # and `question` is ignored. The original turn is left as it was.
    reask_message_id: uuid.UUID | None = None


class RenameConversationRequest(BaseModel):
    title: str = Field(min_length=1, max_length=200)


class ComputeRequest(BaseModel):
    """Structured facts → ledger only, no LLM in path (spec section 8)."""

    ya: str
    employment_income: Decimal = Decimal(0)
    business_income: Decimal = Decimal(0)
    business_expenses: Decimal = Decimal(0)
    foreign_service_income: Decimal = Decimal(0)
    investment_income: Decimal = Decimal(0)
    other_income: Decimal = Decimal(0)
    epf_employee: Decimal | None = None
    qualifying_payments: Decimal = Decimal(0)
    apit_withheld: Decimal = Decimal(0)
    foreign_tax_credit: Decimal = Decimal(0)
    wht_credit: Decimal = Decimal(0)

    # Provenance for the UI/ledger (spec §1.3). Never affects the computation
    # itself — only which figures a user typed vs. confirmed from a payslip.
    source: Literal["structured", "payslip"] = "structured"


def _money(value: Decimal) -> str:
    """Money crosses the wire as a string. A float would silently lose the
    precision the Decimal engine exists to preserve."""
    return f"{value:.2f}"


def _citation(rv: RuleVersion) -> dict[str, Any]:
    return {
        "rule_key": rv.rule_key,
        "rule_version_id": rv.id,
        "label": rv.citation_label,
        "revision_no": rv.revision_no,
        "effective_from": rv.effective_from.isoformat(),
        "effective_to": rv.effective_to.isoformat() if rv.effective_to else None,
        "supersedes_version_id": rv.supersedes_version_id,
        "quoted_text": rv.quoted_text,
        "value": rv.value_json,
    }


def serialise_answer(result: AnswerResult) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "kind": result.kind,
        "intent": result.intent,
        "plan": result.plan,
        "route_source": result.route_source,
        "badge": result.badge.value,
        "ya": result.ya,
        "snapshot": result.snapshot,
        "trace": [t.to_json() for t in result.trace],
        "latency_ms": result.latency_ms,
        "llm": result.llm_budget.to_json(),
    }

    if result.kind == "refusal":
        payload["refusal"] = {
            "reason": result.refusal_reason,
            "pointer": result.refusal_pointer,
            "category": result.refusal_category,
        }
        return payload

    if result.kind == "clarify":
        payload["clarify"] = {"question": result.clarify_question}
        return payload

    if result.computation:
        c = result.computation
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
            "notes": c.notes,
        }

    if result.compliance:
        payload["compliance"] = {
            **result.compliance.to_json(),
            "days_remaining": result.days_remaining,
        }

    if result.compare:
        payload["compare"] = result.compare

    if result.lookup:
        payload["lookup"] = [_citation(rv) for rv in result.lookup]

    payload["explanation"] = result.prose
    if result.suggestions:
        payload["suggestions"] = result.suggestions
    payload["verify"] = result.verify_result.to_json() if result.verify_result else None
    payload["passages"] = [p.to_json() for p in result.passages]

    # Citation cards, one per rule version, with lineage (spec section 6.2 #2).
    seen: set[str] = set()
    citations: list[dict[str, Any]] = []
    for rv in list(result.lookup) + (list(result.rules.rules.values()) if result.rules else []):
        if rv.id in seen:
            continue
        seen.add(rv.id)
        citations.append(_citation(rv))
    payload["citations"] = citations

    return payload
