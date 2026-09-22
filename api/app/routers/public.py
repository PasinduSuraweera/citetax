"""Public API — spec §8."""

from __future__ import annotations

import logging
import uuid
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from sqlalchemy import text

from app.compute.engine import REQUIRED_RULE_KEYS, compute
from app.compute.types import TaxFacts
from app.core.auth import CurrentUserDep, OptionalUserDep
from app.core.config import get_settings
from app.db.session import db_conn
from app.graph import comply
from app.graph.answer import run_answer_graph
from app.routers.schemas import AskRequest, ComputeRequest, serialise_answer
from app.rules.resolver import (
    AmbiguousRule,
    UnresolvedRule,
    current_snapshot,
    resolve,
    resolve_many,
)

router = APIRouter(prefix="/v1")
logger = logging.getLogger(__name__)


def _require_snapshot(conn) -> dict[str, Any]:
    snap = current_snapshot(conn)
    if snap is None:
        raise HTTPException(
            503, "No published corpus snapshot. Run the seed script first."
        )
    return snap


@router.post("/ask")
def ask(req: AskRequest, user: OptionalUserDep = None) -> dict[str, Any]:
    """Question → answer, ledger, citations, trace, snapshot id.

    Anonymous access is a supported tier, so a missing token is fine. A signed
    in user gets the run attached to their account so History can show it.
    """
    with db_conn() as conn:
        result = run_answer_graph(conn, req.question, ya_override=req.ya)
        payload = serialise_answer(result)

        # Persist every answered question, whatever path the planner took, so
        # any answer is reproducible at its snapshot (spec section 9) and the
        # agent's routing decisions are measurable.
        if result.kind == "answer":
            run_id = str(uuid.uuid4())
            try:
                settings = get_settings()
                conn.execute(
                    text(
                        "insert into computation_run (id, user_id, ya, intent, plan, "
                        "question_redacted, facts_redacted_json, ledger_json, "
                        "corpus_snapshot_id, answer_text, verify_result, latency_ms, "
                        "model, llm_usage) values "
                        "(:id, :uid, :ya, :intent, cast(:plan as jsonb), :q, "
                        "cast(:facts as jsonb), cast(:ledger as jsonb), :snap, :ans, "
                        "cast(:vr as jsonb), :ms, :model, cast(:llm as jsonb))"
                    ),
                    {
                        "id": run_id,
                        "uid": user.id if user else None,
                        "ya": result.ya or "",
                        "intent": result.intent,
                        "plan": _json(result.plan),
                        # Redacted text only. No name, employer or ID reaches
                        # this table (spec section 9 retention).
                        "q": result.redacted_question,
                        "facts": _json(result.facts.model_dump(mode="json"))
                        if result.facts
                        else "{}",
                        "ledger": _json(payload.get("computation") or {}),
                        "snap": result.snapshot["id"] if result.snapshot else None,
                        "ans": result.prose,
                        "vr": _json(payload.get("verify") or {}),
                        "ms": result.latency_ms,
                        "model": settings.groq_model if result.llm_budget.calls else None,
                        "llm": _json(payload.get("llm") or {}),
                    },
                )
                conn.commit()
                payload["run_id"] = run_id
            except Exception as exc:  # noqa: BLE001
                # A logging failure must never cost the user their answer, but
                # it must not vanish either — an unrecorded run breaks the
                # reproducibility guarantee and needs to be visible.
                conn.rollback()
                logger.warning("computation_run insert failed: %s", exc)
                payload["run_id"] = None

        return payload


def _json(obj: Any) -> str:
    import json

    return json.dumps(obj, default=str)


@router.post("/compute")
def compute_endpoint(req: ComputeRequest) -> dict[str, Any]:
    """Structured facts → ledger only. No LLM in path (target p95 ≤ 300 ms)."""
    settings = get_settings()
    if req.ya not in settings.supported_yas:
        raise HTTPException(
            400,
            f"Year of assessment {req.ya} is not supported. "
            f"Supported: {', '.join(settings.supported_yas)}",
        )

    facts = TaxFacts(**req.model_dump(exclude={"ya"}), ya=req.ya)

    with db_conn() as conn:
        snap = _require_snapshot(conn)
        try:
            rules = resolve_many(
                conn, REQUIRED_RULE_KEYS + ["deadline.return_filing"],
                req.ya, str(snap["id"]),
            )
        except UnresolvedRule as exc:
            raise HTTPException(422, str(exc)) from exc
        except AmbiguousRule as exc:
            raise HTTPException(500, str(exc)) from exc

        c = compute(facts, rules)
        compliance = comply.assess(c, rules)

    return {
        "ya": c.ya,
        "steps": [
            {
                "step_no": s.step_no,
                "label": s.label,
                "rule_key": s.rule_key,
                "rule_version_id": s.rule_version_id,
                "citation_label": s.citation_label,
                "value": f"{s.value:.2f}",
                "is_zero": s.is_zero,
                "detail": s.detail,
            }
            for s in c.steps
        ],
        "balance_payable": f"{c.balance_payable:.2f}",
        "taxable_income": f"{c.taxable_income:.2f}",
        "gross_tax": f"{c.gross_tax:.2f}",
        "is_refund": c.is_refund,
        "compliance": compliance.to_json(),
        "corpus_snapshot_id": c.corpus_snapshot_id,
    }


@router.get("/obligation")
def obligation(
    ya: str = Query(...),
    income: str = Query("0", description="Total annual income, LKR"),
    apit: str = Query("0"),
) -> dict[str, Any]:
    """Filing obligation check — the free-tier entry point."""
    from decimal import Decimal, InvalidOperation

    settings = get_settings()
    if ya not in settings.supported_yas:
        raise HTTPException(400, f"Year of assessment {ya} is not supported.")
    try:
        facts = TaxFacts(
            ya=ya,
            employment_income=Decimal(income),
            apit_withheld=Decimal(apit),
            source="structured",
        )
    except InvalidOperation as exc:
        raise HTTPException(400, "income and apit must be numeric") from exc

    with db_conn() as conn:
        snap = _require_snapshot(conn)
        try:
            rules = resolve_many(
                conn,
                REQUIRED_RULE_KEYS + ["deadline.return_filing"],
                ya,
                str(snap["id"]),
            )
        except UnresolvedRule as exc:
            raise HTTPException(422, str(exc)) from exc
        c = compute(facts, rules)
        result = comply.assess(c, rules)

    return {
        "ya": ya,
        "taxable_income": f"{c.taxable_income:.2f}",
        **result.to_json(),
        "corpus_snapshot_id": str(snap["id"]),
    }


@router.get("/deadlines")
def deadlines(ya: str = Query(...)) -> dict[str, Any]:
    with db_conn() as conn:
        snap = _require_snapshot(conn)
        try:
            rv = resolve(conn, "deadline.return_filing", ya, str(snap["id"]))
        except UnresolvedRule as exc:
            raise HTTPException(422, str(exc)) from exc

    due = rv.value_json.get("due")
    return {
        "ya": ya,
        "return_due": due,
        "days_remaining": comply.days_until(due),
        "instalments": rv.value_json.get("instalments", []),
        "citation": {
            "label": rv.citation_label,
            "rule_version_id": rv.id,
            "effective_from": rv.effective_from.isoformat(),
            "quoted_text": rv.quoted_text,
        },
    }


@router.get("/rules/{rule_key}")
def get_rule(rule_key: str, ya: str = Query(...)) -> dict[str, Any]:
    """Resolved rule version with source anchor."""
    with db_conn() as conn:
        snap = _require_snapshot(conn)
        try:
            rv = resolve(conn, rule_key, ya, str(snap["id"]))
        except UnresolvedRule as exc:
            raise HTTPException(404, str(exc)) from exc
        except AmbiguousRule as exc:
            raise HTTPException(500, str(exc)) from exc

    return {
        "rule_key": rv.rule_key,
        "rule_version_id": rv.id,
        "revision_no": rv.revision_no,
        "value": rv.value_json,
        "effective_from": rv.effective_from.isoformat(),
        "effective_to": rv.effective_to.isoformat() if rv.effective_to else None,
        "citation_label": rv.citation_label,
        "quoted_text": rv.quoted_text,
        "supersedes_version_id": rv.supersedes_version_id,
        "corpus_snapshot_id": str(snap["id"]),
    }


@router.get("/snapshot/current")
def snapshot_current() -> dict[str, Any]:
    with db_conn() as conn:
        snap = _require_snapshot(conn)
    return {
        "id": str(snap["id"]),
        "label": snap["label"],
        "changelog": snap.get("changelog"),
        "created_at": snap["created_at"].isoformat() if snap.get("created_at") else None,
    }


@router.get("/compare")
def compare(
    from_ya: str = Query(alias="from"), to_ya: str = Query(alias="to")
) -> dict[str, Any]:
    """Year-on-year comparison — spec §6.2 #7, 'what changed this year'."""
    settings = get_settings()
    for ya in (from_ya, to_ya):
        if ya not in settings.supported_yas:
            raise HTTPException(400, f"Year of assessment {ya} is not supported.")

    with db_conn() as conn:
        snap = _require_snapshot(conn)
        keys = REQUIRED_RULE_KEYS + ["deadline.return_filing"]
        try:
            a = resolve_many(conn, keys, from_ya, str(snap["id"]))
            b = resolve_many(conn, keys, to_ya, str(snap["id"]))
        except UnresolvedRule as exc:
            raise HTTPException(422, str(exc)) from exc

        titles = {
            r[0]: r[1]
            for r in conn.execute(text("select rule_key, title from rule")).all()
        }
        # The snapshot changelog is the approvers' own words about what moved.
        history = conn.execute(
            text(
                "select label, changelog, created_at from corpus_snapshot "
                " order by created_at desc limit 8"
            )
        ).mappings().all()

    changes = []
    for key in keys:
        ra, rb = a.rules[key], b.rules[key]
        changes.append(
            {
                "rule_key": key,
                "title": titles.get(key, key),
                "changed": ra.value_json != rb.value_json,
                "same_version": ra.id == rb.id,
                "from": {
                    "value": ra.value_json,
                    "rule_version_id": ra.id,
                    "citation_label": ra.citation_label,
                    "effective_from": ra.effective_from.isoformat(),
                    "effective_to": ra.effective_to.isoformat() if ra.effective_to else None,
                    "quoted_text": ra.quoted_text,
                },
                "to": {
                    "value": rb.value_json,
                    "rule_version_id": rb.id,
                    "citation_label": rb.citation_label,
                    "effective_from": rb.effective_from.isoformat(),
                    "effective_to": rb.effective_to.isoformat() if rb.effective_to else None,
                    "quoted_text": rb.quoted_text,
                },
            }
        )

    return {
        "from_ya": from_ya,
        "to_ya": to_ya,
        "changed_count": sum(1 for c in changes if c["changed"]),
        "changes": changes,
        "corpus_snapshot_id": str(snap["id"]),
        "snapshot_history": [
            {
                "label": h["label"],
                "changelog": h["changelog"],
                "created_at": h["created_at"].isoformat() if h["created_at"] else None,
            }
            for h in history
        ],
    }


@router.get("/history")
def history(user: CurrentUserDep, limit: int = Query(50, le=200)) -> dict[str, Any]:
    """Your own computations, each stamped with the snapshot it ran against,
    so an answer can be re-derived exactly as the law stood that day."""
    with db_conn() as conn:
        rows = conn.execute(
            text(
                "select r.id, r.ya, r.ledger_json, r.answer_text, r.latency_ms, "
                "       r.created_at, r.corpus_snapshot_id, r.verify_result, "
                "       r.intent, r.question_redacted, "
                "       s.label as snapshot_label "
                "  from computation_run r "
                "  left join corpus_snapshot s on s.id = r.corpus_snapshot_id "
                " where r.user_id = :uid "
                " order by r.created_at desc limit :limit"
            ),
            {"uid": user.id, "limit": limit},
        ).mappings().all()

    runs = []
    for r in rows:
        ledger = r["ledger_json"] or {}
        runs.append(
            {
                "id": str(r["id"]),
                "ya": r["ya"],
                "intent": r["intent"],
                "question": r["question_redacted"],
                "balance_payable": ledger.get("balance_payable"),
                "taxable_income": ledger.get("taxable_income"),
                "step_count": ledger.get("step_count"),
                "is_refund": ledger.get("is_refund"),
                "answer_text": r["answer_text"],
                "latency_ms": r["latency_ms"],
                "created_at": r["created_at"].isoformat() if r["created_at"] else None,
                "corpus_snapshot_id": str(r["corpus_snapshot_id"])
                if r["corpus_snapshot_id"] else None,
                "snapshot_label": r["snapshot_label"],
                "badge": (r["verify_result"] or {}).get("badge"),
            }
        )
    return {"runs": runs, "count": len(runs)}


@router.get("/history/{run_id}")
def history_detail(run_id: str, user: CurrentUserDep) -> dict[str, Any]:
    """Reproduce one stored answer, including the ledger it produced."""
    with db_conn() as conn:
        row = conn.execute(
            text(
                "select r.*, s.label as snapshot_label, s.changelog "
                "  from computation_run r "
                "  left join corpus_snapshot s on s.id = r.corpus_snapshot_id "
                " where r.id = :id and r.user_id = :uid"
            ),
            {"id": run_id, "uid": user.id},
        ).mappings().first()
    if not row:
        raise HTTPException(404, "Run not found")

    return {
        "id": str(row["id"]),
        "ya": row["ya"],
        "intent": row["intent"],
        "plan": row["plan"],
        "question": row["question_redacted"],
        "ledger": row["ledger_json"],
        "facts": row["facts_redacted_json"],
        "answer_text": row["answer_text"],
        "verify_result": row["verify_result"],
        "llm_usage": row["llm_usage"],
        "latency_ms": row["latency_ms"],
        "model": row["model"],
        "created_at": row["created_at"].isoformat() if row["created_at"] else None,
        "snapshot": {
            "id": str(row["corpus_snapshot_id"]) if row["corpus_snapshot_id"] else None,
            "label": row["snapshot_label"],
            "changelog": row["changelog"],
        },
    }


@router.post("/runs/{run_id}/flag")
def flag_run(run_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    """User escalation — lands in the admin queue bound to rule_version_id
    + computation_run_id so a reviewer can reproduce the answer (spec §5.1 G)."""
    with db_conn() as conn:
        row = conn.execute(
            text(
                "insert into escalation (computation_run_id, step_no, "
                "rule_version_id, note) values (:r, :s, :rv, :n) returning id"
            ),
            {
                "r": run_id,
                "s": payload.get("step_no"),
                "rv": payload.get("rule_version_id"),
                "n": (payload.get("note") or "")[:2000],
            },
        ).scalar_one()
        conn.commit()
    return {"escalation_id": str(row), "status": "open"}
