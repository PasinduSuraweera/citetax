"""Public API — spec §8."""

from __future__ import annotations

import json
import logging
import queue
import threading
import uuid
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from pydantic import ValidationError
from fastapi.responses import StreamingResponse
from sqlalchemy import text

from app.compute.engine import REQUIRED_RULE_KEYS, compute
from app.compute.types import TaxFacts
from app.conversations import envelope, store, titles
from app.conversations.context import build_context
from app.core.auth import CurrentUserDep, OptionalUserDep, User
from app.core.config import get_settings
from app.db.session import db_conn
from app.graph import comply
from app.graph.answer import AnswerResult, run_answer_graph
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


def _persist_run(
    conn, result: AnswerResult, payload: dict[str, Any], user: User | None
) -> None:
    """Log the interaction so any answer is reproducible at its snapshot (spec
    section 9) and the agent's routing decisions are measurable. A logging
    failure must never cost the user their answer, but must not vanish
    either — an unrecorded run breaks the reproducibility guarantee."""
    if result.kind != "answer":
        return
    run_id = str(uuid.uuid4())
    try:
        settings = get_settings()
        conn.execute(
            text(
                "insert into computation_run (id, user_id, ya, intent, plan, "
                "question_redacted, facts_redacted_json, ledger_json, "
                "rule_version_ids, corpus_snapshot_id, answer_text, verify_result, "
                "latency_ms, model, llm_usage) values "
                "(:id, :uid, :ya, :intent, cast(:plan as jsonb), :q, "
                "cast(:facts as jsonb), cast(:ledger as jsonb), cast(:rvids as uuid[]), "
                ":snap, :ans, cast(:vr as jsonb), :ms, :model, cast(:llm as jsonb))"
            ),
            {
                "id": run_id,
                "uid": user.id if user else None,
                "ya": result.ya or "",
                "intent": result.intent,
                "plan": _json(result.plan),
                "q": result.redacted_question,
                "facts": _json(result.facts.model_dump(mode="json"))
                if result.facts
                else "{}",
                "ledger": _json(payload.get("computation") or {}),
                "rvids": _rule_version_ids(result),
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
        conn.rollback()
        logger.warning("computation_run insert failed: %s", exc)
        payload["run_id"] = None


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
    in user gets the run attached to their account so History can show it, and
    the question and answer become a turn in a conversation: the one named by
    conversation_id, or a new one. Anonymous questions are never kept as
    conversations and never carry context.
    """
    if (req.conversation_id or req.reask_message_id) and user is None:
        # An expired or invalid token reads as anonymous in optional_user.
        # Continuing a conversation must not quietly become a fresh anonymous
        # question, so it is refused and the client signs in again.
        raise HTTPException(401, "Sign in to continue this conversation")
    if req.reask_message_id and not req.conversation_id:
        raise HTTPException(422, "reask_message_id needs its conversation_id")

    conversation_id = str(req.conversation_id) if req.conversation_id else None

    with db_conn() as conn:
        question = req.question
        facts_override: TaxFacts | None = None
        context = None

        if user is not None and conversation_id:
            before_seq = None
            if req.reask_message_id:
                # Same question, same stored facts, current law. The old turn
                # and its run are not touched; this becomes a new turn.
                source = store.reask_source(
                    conn, user.id, conversation_id, str(req.reask_message_id)
                )
                if source is None:
                    raise HTTPException(404, "Message not found")
                try:
                    facts_override = TaxFacts.model_validate(source.facts)
                except ValidationError as exc:
                    raise HTTPException(409, "That answer cannot be asked again") from exc
                question = source.question
                before_seq = source.question_seq

            rows = store.context_rows(conn, user.id, conversation_id, before_seq=before_seq)
            if rows is None:
                raise HTTPException(404, "Conversation not found")
            context = build_context(rows)

        result = run_answer_graph(
            conn, question, ya_override=req.ya,
            facts_override=facts_override, context=context,
        )
        payload = serialise_answer(result)
        _persist_run(conn, result, payload, user)

        if user is not None:
            payload.update(_save_turn(conn, user, conversation_id, result, payload))

        return payload


@router.post("/ask/stream")
def ask_stream(req: AskRequest, user: OptionalUserDep = None) -> StreamingResponse:
    """Same question-in, answer-out contract as /ask, except each trace step
    is pushed the instant it actually finishes instead of arriving all at
    once at the end.

    Newline-delimited JSON over a plain POST response, not text/event-stream:
    a browser's native EventSource cannot attach an Authorization header, and
    this API is bearer-token authenticated. A plain fetch() reading the
    response body as a stream has no such limitation.

    Signed-in conversation behavior mirrors /ask: context is bounded and
    redacted, re-ask uses the stored facts, and the new answer is saved as a
    new turn. Anonymous streaming remains a one-off answer.
    """

    if (req.conversation_id or req.reask_message_id) and user is None:
        raise HTTPException(401, "Sign in to continue this conversation")
    if req.reask_message_id and not req.conversation_id:
        raise HTTPException(422, "reask_message_id needs its conversation_id")

    conversation_id = str(req.conversation_id) if req.conversation_id else None

    def generate():
        q: "queue.Queue[dict[str, Any]]" = queue.Queue()

        def on_node(entry) -> None:
            q.put({"type": "step", **entry.to_json()})

        def on_plan(plan: list[str]) -> None:
            q.put({"type": "plan", "plan": plan})

        def worker() -> None:
            try:
                with db_conn() as conn:
                    question = req.question
                    facts_override: TaxFacts | None = None
                    context = None

                    if user is not None and conversation_id:
                        before_seq = None
                        if req.reask_message_id:
                            source = store.reask_source(
                                conn,
                                user.id,
                                conversation_id,
                                str(req.reask_message_id),
                            )
                            if source is None:
                                raise HTTPException(404, "Message not found")
                            try:
                                facts_override = TaxFacts.model_validate(source.facts)
                            except ValidationError as exc:
                                raise HTTPException(
                                    409, "That answer cannot be asked again"
                                ) from exc
                            question = source.question
                            before_seq = source.question_seq

                        rows = store.context_rows(
                            conn,
                            user.id,
                            conversation_id,
                            before_seq=before_seq,
                        )
                        if rows is None:
                            raise HTTPException(404, "Conversation not found")
                        context = build_context(rows)

                    result = run_answer_graph(
                        conn,
                        question,
                        ya_override=req.ya,
                        facts_override=facts_override,
                        context=context,
                        on_node=on_node,
                        on_plan=on_plan,
                    )
                    payload = serialise_answer(result)
                    _persist_run(conn, result, payload, user)

                    if user is not None:
                        payload.update(
                            _save_turn(
                                conn,
                                user,
                                conversation_id,
                                result,
                                payload,
                            )
                        )

                q.put({"type": "done", "payload": payload})
            except HTTPException as exc:
                logger.warning("ask/stream request failed: %s", exc.detail)
                q.put(
                    {
                        "type": "error",
                        "status": exc.status_code,
                        "message": str(exc.detail),
                    }
                )
            except Exception as exc:  # noqa: BLE001 — surfaced to the client
                logger.exception("ask/stream worker failed")
                q.put({"type": "error", "message": str(exc)[:300]})

        threading.Thread(target=worker, daemon=True).start()

        while True:
            item = q.get()
            yield json.dumps(item, default=str) + "\n"
            if item["type"] in ("done", "error"):
                break

    # nosniff: without it Chromium holds back the first 1 KB to sniff the
    # type, and every step event fits inside that, so the whole trace would
    # arrive at once with the answer. no-transform/X-Accel-Buffering keep
    # proxies from buffering it the same way.
    return StreamingResponse(
        generate(),
        media_type="application/x-ndjson",
        headers={
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
        },
    )


def _save_turn(
    conn,
    user: User,
    conversation_id: str | None,
    result: AnswerResult,
    payload: dict[str, Any],
) -> dict[str, Any]:
    """Store the turn in its conversation, after the run has committed.

    A failure here never costs the user the answer: it is returned with
    message_persisted false, and the run is still in History.
    """
    run_id = payload.get("run_id")
    kind, content, response_json = envelope.split(payload, run_id)
    title = titles.title_for_turn(
        intent=result.intent,
        kind=result.kind,
        ya=result.ya,
        facts=result.facts.model_dump(mode="json") if result.facts else None,
        compare=result.compare,
        rule_keys=[rv.rule_key for rv in result.lookup],
        redacted_question=result.redacted_question,
    )
    try:
        saved = store.append_turn(
            conn, user.id, conversation_id,
            title=title,
            question=result.redacted_question,
            kind=kind,
            content=content,
            run_id=run_id,
            response_json=response_json,
        )
    except store.ConversationNotFound:
        # Deleted while the question was running.
        logger.info("conversation %s gone before its turn was saved", conversation_id)
        return {"conversation_id": None, "message_persisted": False}
    except Exception as exc:  # noqa: BLE001
        # Ids and the error type only. The message may carry the question.
        logger.warning(
            "conversation turn not saved (conversation %s, run %s): %s",
            conversation_id, run_id, type(exc).__name__,
        )
        return {"conversation_id": conversation_id, "message_persisted": False}

    return {
        "conversation_id": saved.conversation["id"],
        "conversation": saved.conversation,
        "conversation_created": saved.created,
        "message_id": saved.reply_id,
        "question_message_id": saved.question_id,
        "seq": saved.seq,
        # What was stored, which is what a reload will show: redacted.
        "user_message": result.redacted_question,
        "message_persisted": True,
        "snapshot_is_current": True if payload.get("snapshot") else None,
        "reaskable": bool(run_id) and kind == "answer",
    }


def _rule_version_ids(result: AnswerResult) -> list[str]:
    ids: list[str] = []
    if result.rules:
        ids += [rv.id for rv in result.rules.rules.values()]
    ids += [rv.id for rv in result.lookup]
    if result.compare:
        for change in result.compare.get("changes", []):
            for side in ("from", "to"):
                rid = (change.get(side) or {}).get("rule_version_id")
                if rid:
                    ids.append(rid)

    out: list[str] = []
    for rid in ids:
        try:
            norm = str(uuid.UUID(str(rid)))
        except ValueError:
            continue
        if norm not in out:
            out.append(norm)
    return out


def _json(obj: Any) -> str:
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
