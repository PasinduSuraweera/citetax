"""Admin API (spec section 5).

The admin panel is where the product's claim is actually true, so it is a
first-class surface rather than internal tooling.

Two invariants hold everywhere in this file:
  1. Publishing creates a new corpus snapshot; it is never a row update.
  2. Anything that changes a computed figure needs two distinct humans.
"""

from __future__ import annotations

import json
import logging
import uuid
from datetime import date, timedelta
from typing import Any

from fastapi import APIRouter, Body, HTTPException, Query
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from app.admin import impact as impact_mod
from app.core.auth import AdminDep, ApproverDep, CurrentUserDep, ReviewerDep, User
from app.db.session import db_conn
from app.rules.resolver import RuleVersion, current_snapshot

router = APIRouter(prefix="/admin")
logger = logging.getLogger(__name__)

# Rule keys whose value feeds a computed figure. Changing one needs dual
# control (spec section 5.1 E).
VALUE_BEARING_PREFIXES = (
    "band.", "relief.", "credit.", "deduction.", "charge.", "deadline.", "apit.",
    "income.",
)

# States a reviewer can move a proposal between by editing it. Approval and
# publication only happen through their own endpoints.
REVIEW_STATES = {"needs_review", "in_review", "changes_requested"}

# Fields that decide what would be published. Changing one voids signatures.
SIGNED_FIELDS = {"rule_key", "operation", "value_json", "effective_from", "effective_to"}


def _is_value_bearing(rule_key: str) -> bool:
    return rule_key.startswith(VALUE_BEARING_PREFIXES)


def _uuid_or_404(value: str, what: str) -> str:
    """Ids are UUIDs. Anything else is a missing record, not a server error."""
    try:
        return str(uuid.UUID(str(value)))
    except ValueError as exc:
        raise HTTPException(404, f"{what} not found") from exc


def _audit(conn, actor: str, action: str, target_type: str,
           target_id: str, before: Any = None, after: Any = None) -> None:
    """Append-only. Never editable, never deletable (spec section 5.1 H)."""
    conn.execute(
        text(
            "insert into review_event (actor, action, target_type, target_id, "
            "before_json, after_json) values "
            "(:a, :act, :tt, :tid, cast(:b as jsonb), cast(:af as jsonb))"
        ),
        {
            "a": actor, "act": action, "tt": target_type, "tid": str(target_id),
            "b": json.dumps(before, default=str) if before is not None else None,
            "af": json.dumps(after, default=str) if after is not None else None,
        },
    )


# ---------------------------------------------------------------------------
# Review inbox
# ---------------------------------------------------------------------------

@router.get("/proposals")
def list_proposals(
    user: ReviewerDep,
    status: str | None = Query(None),
    only_revisions: bool = Query(False),
) -> dict[str, Any]:
    """Queue sorted by risk then age (spec section 5.1 A)."""
    clauses = ["1=1"]
    params: dict[str, Any] = {}
    if status:
        clauses.append("p.status = :status")
        params["status"] = status
    else:
        clauses.append("p.status in ('needs_review','in_review','changes_requested')")
    if only_revisions:
        clauses.append("d.supersedes_id is not null")

    with db_conn() as conn:
        rows = conn.execute(
            text(
                f"""
                select p.id, p.rule_key, p.operation, p.value_json, p.confidence,
                       p.status, p.priority, p.created_at, p.effective_from,
                       p.effective_to, p.quoted_text, p.assigned_to, p.corrected_json,
                       d.title as document_title, d.url as document_url,
                       d.revision_no, d.supersedes_id, d.doc_type, d.published_at,
                       exists (select 1 from rule_version rv
                                 join source_document sd on sd.id = rv.source_document_id
                                where sd.family_id = d.family_id
                                  and rv.status = 'published') as feeds_published
                  from change_proposal p
                  left join source_document d on d.id = p.source_document_id
                 where {' and '.join(clauses)}
                 order by p.priority asc, p.created_at asc
                 limit 200
                """
            ),
            params,
        ).mappings().all()

    def sla_hours(priority: int) -> int:
        return {1: 4, 2: 24, 3: 120}.get(priority, 120)

    now = None
    out = []
    for r in rows:
        d = dict(r)
        d["id"] = str(d["id"])
        d["supersedes_id"] = str(d["supersedes_id"]) if d["supersedes_id"] else None
        # Only a revision of a document a published rule came from can make a
        # live answer wrong. Any other revision is just a changed page.
        d["is_revision_of_published"] = bool(d["supersedes_id"] and d.pop("feeds_published"))
        d.pop("feeds_published", None)
        d["sla_hours"] = sla_hours(d["priority"])
        if d["created_at"]:
            now = now or d["created_at"].tzinfo
            from datetime import datetime, timezone

            age = (datetime.now(timezone.utc) - d["created_at"]).total_seconds() / 3600
            d["age_hours"] = round(age, 1)
            d["sla_breached"] = age > d["sla_hours"]
        d["confidence"] = float(d["confidence"]) if d["confidence"] is not None else None
        out.append(d)

    return {"proposals": out, "count": len(out), "viewer_role": user.role}


@router.get("/summary")
def summary(user: ReviewerDep) -> dict[str, Any]:
    """What the admin sidebar shows on every page: the live snapshot and the
    counts that need someone's attention."""
    with db_conn() as conn:
        snap = current_snapshot(conn)
        counts = conn.execute(
            text(
                "select "
                " count(*) filter (where status in ('needs_review','in_review','changes_requested')) as open, "
                " count(*) filter (where status in ('needs_review','in_review','changes_requested') "
                "                  and priority = 1) as urgent, "
                " count(*) filter (where status = 'approved') as approved "
                "from change_proposal"
            )
        ).mappings().one()
        flags = conn.execute(text("select count(*) from escalation where status = 'open'")).scalar_one()
    return {
        "snapshot": {"id": str(snap["id"]), "label": snap["label"]} if snap else None,
        "open_proposals": counts["open"],
        "urgent": counts["urgent"],
        "approved_waiting": counts["approved"],
        "open_escalations": flags,
    }


@router.get("/proposals/{proposal_id}")
def get_proposal(proposal_id: str, user: ReviewerDep) -> dict[str, Any]:
    """Document viewer payload: the extracted values plus the quoted sentence
    each came from, and the currently published version to diff against."""
    proposal_id = _uuid_or_404(proposal_id, "Proposal")
    with db_conn() as conn:
        row = conn.execute(
            text(
                """
                select p.*, d.title as document_title, d.url as document_url,
                       d.revision_no, d.supersedes_id, d.raw_text, d.doc_type,
                       d.published_at, d.sha256
                  from change_proposal p
                  left join source_document d on d.id = p.source_document_id
                 where p.id = :id
                """
            ),
            {"id": proposal_id},
        ).mappings().first()
        if not row:
            raise HTTPException(404, "Proposal not found")

        snap = current_snapshot(conn)
        published = None
        if row["rule_key"] and snap:
            pub = conn.execute(
                text(
                    "select rv.id, rv.value_json, rv.effective_from, "
                    "rv.effective_to, rv.citation_label, rv.revision_no, "
                    "rv.quoted_text "
                    "  from rule_version rv "
                    "  join snapshot_rule_version srv "
                    "    on srv.rule_version_id = rv.id "
                    " where rv.rule_key = :k and srv.snapshot_id = :s "
                    "   and rv.status = 'published' "
                    " order by rv.effective_from desc, rv.revision_no desc limit 1"
                ),
                {"k": row["rule_key"], "s": str(snap["id"])},
            ).mappings().first()
            if pub:
                published = {**dict(pub), "id": str(pub["id"])}

    d = dict(row)
    d["id"] = str(d["id"])
    d["source_document_id"] = (
        str(d["source_document_id"]) if d["source_document_id"] else None
    )
    d["supersedes_id"] = str(d["supersedes_id"]) if d["supersedes_id"] else None
    d["confidence"] = float(d["confidence"]) if d["confidence"] is not None else None
    # The raw document can be large and the viewer only needs a window.
    if d.get("raw_text"):
        d["raw_text"] = d["raw_text"][:20000]

    return {
        "proposal": d,
        "published": published,
        "is_value_bearing": _is_value_bearing(d.get("rule_key") or ""),
        "viewer_role": user.role,
    }


@router.patch("/proposals/{proposal_id}")
def edit_proposal(
    proposal_id: str, user: ReviewerDep, payload: dict[str, Any] = Body(...)
) -> dict[str, Any]:
    """The reviewer compares, corrects and signs; never retypes. Every edit is
    recorded as a correction, which becomes the extractor's eval set.

    An edit can only move a proposal between review states: approval happens
    through the approve endpoint, where dual control is enforced. Changing
    what would be published clears any signature already given, because
    whoever signed approved the old value, not the new one.
    """
    proposal_id = _uuid_or_404(proposal_id, "Proposal")
    editable = {"rule_key", "operation", "value_json", "effective_from",
                "effective_to", "quoted_text", "assigned_to", "status"}
    changes = {k: v for k, v in payload.items() if k in editable}
    if not changes:
        raise HTTPException(400, "No editable fields supplied")
    if "status" in changes and changes["status"] not in REVIEW_STATES:
        raise HTTPException(
            400, "Status can only be set to a review state. Approve through the approve action."
        )

    with db_conn() as conn:
        before = conn.execute(
            text("select * from change_proposal where id = :id for update"), {"id": proposal_id}
        ).mappings().first()
        if not before:
            raise HTTPException(404, "Proposal not found")
        if before["status"] in ("published", "rejected"):
            raise HTTPException(409, f"This proposal is {before['status']} and can no longer be edited.")

        changed = {
            k: v for k, v in changes.items()
            if json.dumps(before[k] if k in before else None, default=str) != json.dumps(v, default=str)
        }
        if not changed:
            return {"ok": True, "corrections_recorded": 0, "signatures_cleared": False}

        corrected = dict(before["corrected_json"] or {})
        had_signature = bool(corrected.get("approved_by") or corrected.get("second_approved_by"))
        clears = had_signature and bool(SIGNED_FIELDS & set(changed))
        if clears:
            corrected.pop("approved_by", None)
            corrected.pop("second_approved_by", None)

        sets, params = [], {"id": proposal_id}
        for k, v in changed.items():
            if k == "value_json":
                sets.append("value_json = cast(:value_json as jsonb)")
                params["value_json"] = json.dumps(v)
            else:
                sets.append(f"{k} = :{k}")
                params[k] = v
        if clears:
            sets.append("corrected_json = cast(:corrected as jsonb)")
            params["corrected"] = json.dumps(corrected)
            if "status" not in changed:
                sets.append("status = 'needs_review'")
        sets.append("reviewed_by = :actor")
        sets.append("reviewed_at = now()")
        params["actor"] = user.email

        conn.execute(
            text(f"update change_proposal set {', '.join(sets)} where id = :id"),
            params,
        )

        for field, after_value in changed.items():
            conn.execute(
                text(
                    "insert into reviewer_correction (proposal_id, field, "
                    "before_value, after_value, actor) values "
                    "(:p, :f, :b, :a, :actor)"
                ),
                {
                    "p": proposal_id, "f": field,
                    "b": json.dumps(before[field] if field in before else None, default=str)[:2000],
                    "a": json.dumps(after_value, default=str)[:2000],
                    "actor": user.email,
                },
            )

        _audit(conn, user.email, "proposal.edit", "change_proposal",
               proposal_id, dict(before), {**changed, "signatures_cleared": clears})
        conn.commit()

    return {"ok": True, "corrections_recorded": len(changed), "signatures_cleared": clears}


@router.post("/proposals/{proposal_id}/impact")
def proposal_impact(proposal_id: str, user: ReviewerDep) -> dict[str, Any]:
    """Run the golden set against the proposed corpus (spec section 5.1 D)."""
    proposal_id = _uuid_or_404(proposal_id, "Proposal")
    with db_conn() as conn:
        row = conn.execute(
            text(
                "select rule_key, value_json, effective_from, effective_to "
                "  from change_proposal where id = :id"
            ),
            {"id": proposal_id},
        ).mappings().first()
        if not row:
            raise HTTPException(404, "Proposal not found")
        if not row["rule_key"]:
            raise HTTPException(400, "Proposal has no rule key to evaluate")

        snap = current_snapshot(conn)
        if not snap:
            raise HTTPException(503, "No current snapshot")

        candidate = RuleVersion(
            id=f"proposed:{proposal_id}",
            rule_key=row["rule_key"],
            revision_no=999,
            value_json=row["value_json"] or {},
            effective_from=row["effective_from"] or date(2025, 4, 1),
            effective_to=row["effective_to"],
            citation_label="proposed",
            quoted_text=None,
        )
        report = impact_mod.preview(
            conn, str(snap["id"]), {row["rule_key"]: candidate}
        )

    return {"rule_key": row["rule_key"], "impact": report.to_json()}


@router.post("/proposals/{proposal_id}/reject")
def reject_proposal(
    proposal_id: str, user: ReviewerDep, payload: dict[str, Any] = Body(...)
) -> dict[str, Any]:
    """Rejected proposals are kept forever with the reason. They are training
    data for the extractor and evidence for the audit."""
    proposal_id = _uuid_or_404(proposal_id, "Proposal")
    reason = (payload.get("reason") or "").strip()
    if not reason:
        raise HTTPException(400, "A rejection must carry a reason")

    with db_conn() as conn:
        status = conn.execute(
            text("select status from change_proposal where id = :id"), {"id": proposal_id}
        ).scalar()
        if status is None:
            raise HTTPException(404, "Proposal not found")
        if status in ("published", "rejected"):
            raise HTTPException(409, f"This proposal is already {status}.")
        conn.execute(
            text(
                "update change_proposal set status = 'rejected', "
                "reject_reason = :r, reviewed_by = :a, reviewed_at = now() "
                "where id = :id"
            ),
            {"r": reason[:2000], "a": user.email, "id": proposal_id},
        )
        _audit(conn, user.email, "proposal.reject", "change_proposal",
               proposal_id, None, {"reason": reason})
        conn.commit()
    return {"ok": True, "status": "rejected"}


@router.post("/proposals/{proposal_id}/approve")
def approve_proposal(
    proposal_id: str, user: ReviewerDep, payload: dict[str, Any] = Body(default={})
) -> dict[str, Any]:
    """First or second signature.

    Dual control: a value-bearing change needs two distinct humans, and the
    second must have the approver role. The same person signing twice is
    refused, which is the entire point of the control.
    """
    proposal_id = _uuid_or_404(proposal_id, "Proposal")
    with db_conn() as conn:
        row = conn.execute(
            text("select * from change_proposal where id = :id for update"), {"id": proposal_id}
        ).mappings().first()
        if not row:
            raise HTTPException(404, "Proposal not found")
        if row["status"] in ("published", "rejected", "approved"):
            raise HTTPException(409, f"This proposal is already {row['status']}.")

        # What would be published must be complete before anyone signs it.
        if not row["rule_key"]:
            raise HTTPException(
                400, "This proposal names no rule. Re-extract it, fill in the rule, or reject it."
            )
        if not isinstance(row["value_json"], dict) or not row["value_json"]:
            raise HTTPException(400, "This proposal has no value to publish.")
        needs_dual = _is_value_bearing(row["rule_key"])
        if needs_dual and not row["effective_from"]:
            raise HTTPException(
                400, "Set the date this takes effect from. A figure without one cannot be placed in the right year."
            )

        corrected = row["corrected_json"] or {}
        first_approver = corrected.get("approved_by")

        if not needs_dual:
            conn.execute(
                text(
                    "update change_proposal set status = 'approved', "
                    "corrected_json = cast(:c as jsonb), "
                    "reviewed_by = :a, reviewed_at = now() where id = :id"
                ),
                {"c": json.dumps({**corrected, "approved_by": user.email}),
                 "a": user.email, "id": proposal_id},
            )
            _audit(conn, user.email, "proposal.approve", "change_proposal",
                   proposal_id, None, {"dual_control": False})
            conn.commit()
            return {"ok": True, "status": "approved", "awaiting_second": False,
                    "first_approver": user.email}

        if first_approver is None:
            conn.execute(
                text(
                    "update change_proposal set status = 'in_review', "
                    "corrected_json = cast(:c as jsonb), reviewed_by = :a, "
                    "reviewed_at = now() where id = :id"
                ),
                {
                    "c": json.dumps({**corrected, "approved_by": user.email}),
                    "a": user.email,
                    "id": proposal_id,
                },
            )
            _audit(conn, user.email, "proposal.approve.first", "change_proposal",
                   proposal_id, None, {"dual_control": True})
            conn.commit()
            return {
                "ok": True,
                "status": "in_review",
                "awaiting_second": True,
                "first_approver": user.email,
                "message": "First signature recorded. A different approver must "
                           "countersign before this can be published.",
            }

        if first_approver == user.email:
            raise HTTPException(
                409,
                "Dual control needs two distinct people. You gave the first "
                "signature; someone else must give the second.",
            )
        if not user.can_approve:
            raise HTTPException(
                403,
                "The second signature on a value-bearing change needs the "
                f"approver role. Your account is {user.role}.",
            )

        conn.execute(
            text(
                "update change_proposal set status = 'approved', "
                "corrected_json = cast(:c as jsonb) where id = :id"
            ),
            {
                "c": json.dumps({**corrected, "second_approved_by": user.email}),
                "id": proposal_id,
            },
        )
        _audit(conn, user.email, "proposal.approve.second", "change_proposal",
               proposal_id, None, {"first": first_approver, "second": user.email})
        conn.commit()

    return {
        "ok": True,
        "status": "approved",
        "awaiting_second": False,
        "first_approver": first_approver,
        "second_approver": user.email,
    }


# ---------------------------------------------------------------------------
# Publication and rollback
# ---------------------------------------------------------------------------

def _reindex_rule_text(conn) -> dict[str, Any]:
    """Re-index rule text once the current snapshot has changed (spec section
    3.5), so the next answer quotes the law it is computed from.

    Called after the commit: a failure here must not undo a publish or a
    rollback. The agent's next cycle finds the index stale and retries.
    """
    from app.retrieval import indexer

    try:
        report = indexer.index_rule_versions(conn)
    except Exception as exc:  # noqa: BLE001
        conn.rollback()
        logger.warning("rule text re-index failed: %s", exc)
        return {"ok": False, "chunks": 0, "errors": [str(exc)[:160]]}
    return {"ok": not report.errors, "chunks": report.chunks_written,
            "errors": report.errors}


@router.post("/snapshots/publish")
def publish(user: ApproverDep, payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    """Publishing is not a row update. It creates a new corpus snapshot."""
    changelog = (payload.get("changelog") or "").strip()
    if not changelog:
        raise HTTPException(
            400,
            "A changelog line is required. It is what users see in what changed.",
        )
    label = (payload.get("label") or date.today().strftime("%d %B %Y")).strip()

    with db_conn() as conn:
        result = publish_snapshot(conn, user.email, label, changelog)
        conn.commit()
        index = _reindex_rule_text(conn)
    return {"ok": True, **result, "index": index}


def _in_force(v: dict[str, Any], day: date) -> bool:
    return v["effective_from"] <= day and (v["effective_to"] is None or v["effective_to"] >= day)


def _copy_version(conn, v: dict[str, Any], effective_from: date, effective_to: date | None,
                  revision_no: int) -> dict[str, Any]:
    """A new row carrying `v` over a narrower window. Rule versions are shared
    by every snapshot that includes them, so a published row is never edited:
    the new snapshot gets a copy instead, and older snapshots keep theirs."""
    new_id = str(uuid.uuid4())
    conn.execute(
        text(
            "insert into rule_version (id, rule_key, revision_no, value_json, "
            "effective_from, effective_to, source_document_id, source_anchor_json, "
            "quoted_text, citation_label, status, supersedes_version_id, "
            "approved_by, approved_at, second_approved_by, second_approved_at, "
            "changelog_line) "
            "select :new, rule_key, :rev, value_json, :ef, :et, source_document_id, "
            "source_anchor_json, quoted_text, citation_label, 'published', id, "
            "approved_by, approved_at, second_approved_by, second_approved_at, "
            "changelog_line from rule_version where id = :id"
        ),
        {"new": new_id, "rev": revision_no, "ef": effective_from, "et": effective_to, "id": v["id"]},
    )
    return {**v, "id": new_id, "effective_from": effective_from, "effective_to": effective_to,
            "revision_no": revision_no}


def publish_snapshot(conn, actor: str, label: str, changelog: str) -> dict[str, Any]:
    """Build and switch to a new snapshot from the approved proposals.

    Does not commit, so the caller (or a test) decides. Every version in the
    current snapshot is carried forward; for each approved proposal only the
    version it overlaps is replaced, and only over the dates the proposal
    covers, so a rule with one version per year keeps the other years. The
    new snapshot must still resolve every required rule for every supported
    year, or nothing is published.
    """
    from app.compute.engine import REQUIRED_RULE_KEYS
    from app.core.config import get_settings
    from app.rules.resolver import AmbiguousRule, UnresolvedRule, resolve

    approved = conn.execute(
        text(
            "select * from change_proposal where status = 'approved' "
            "and rule_key is not null order by effective_from nulls first, created_at"
        )
    ).mappings().all()
    if not approved:
        raise HTTPException(400, "No approved proposals to publish.")

    unsigned = []
    for p in approved:
        signed = p["corrected_json"] or {}
        if _is_value_bearing(p["rule_key"]) and not (
            signed.get("approved_by") and signed.get("second_approved_by")
            and signed["approved_by"] != signed["second_approved_by"]
        ):
            unsigned.append(p["rule_key"])
        if _is_value_bearing(p["rule_key"]) and not p["effective_from"]:
            unsigned.append(f"{p['rule_key']} (no effective date)")
    if unsigned:
        raise HTTPException(
            409, f"These need two distinct signatures and a date before publishing: {', '.join(unsigned)}"
        )

    current = current_snapshot(conn)
    versions: list[dict[str, Any]] = []
    if current:
        versions = [
            dict(r) for r in conn.execute(
                text(
                    "select rv.id, rv.rule_key, rv.revision_no, rv.effective_from, rv.effective_to "
                    "  from snapshot_rule_version srv join rule_version rv on rv.id = srv.rule_version_id "
                    " where srv.snapshot_id = :s"
                ),
                {"s": str(current["id"])},
            ).mappings()
        ]

    def next_revision(key: str) -> int:
        top = conn.execute(
            text("select coalesce(max(revision_no), 0) from rule_version where rule_key = :k"), {"k": key}
        ).scalar_one()
        return int(top) + 1

    created: list[dict[str, Any]] = []
    for p in approved:
        key = p["rule_key"]
        start: date = p["effective_from"] or date.today()
        end: date | None = p["effective_to"]

        # Trim every version of this key that overlaps the new window.
        kept: list[dict[str, Any]] = []
        superseded: str | None = None
        for v in versions:
            overlaps = v["rule_key"] == key and v["effective_from"] <= (end or date.max) and (
                v["effective_to"] is None or v["effective_to"] >= start
            )
            if not overlaps:
                kept.append(v)
                continue
            superseded = superseded or v["id"]
            if v["effective_from"] < start:
                kept.append(_copy_version(conn, v, v["effective_from"], start - timedelta(days=1), next_revision(key)))
            if end is not None and (v["effective_to"] is None or v["effective_to"] > end):
                kept.append(_copy_version(conn, v, end + timedelta(days=1), v["effective_to"], next_revision(key)))
        versions = kept

        conn.execute(
            text(
                "insert into rule (rule_key, title, rule_type, unit) "
                "values (:k, :k, 'amount', 'LKR') on conflict do nothing"
            ),
            {"k": key},
        )
        signed = p["corrected_json"] or {}
        version_id = str(uuid.uuid4())
        revision = next_revision(key)
        conn.execute(
            text(
                "insert into rule_version (id, rule_key, revision_no, value_json, "
                "effective_from, effective_to, source_document_id, quoted_text, "
                "citation_label, status, supersedes_version_id, approved_by, approved_at, "
                "second_approved_by, second_approved_at, changelog_line) "
                "values (:id, :k, :rev, cast(:v as jsonb), :ef, :et, :doc, :q, :cite, "
                "'published', :sup, :ab, now(), :sb, "
                "case when cast(:sb as text) is null then null else now() end, :log)"
            ),
            {
                "id": version_id, "k": key, "rev": revision,
                "v": json.dumps(p["value_json"] or {}),
                "ef": start, "et": end, "doc": p["source_document_id"],
                "q": p["quoted_text"],
                "cite": (p["value_json"] or {}).get("citation_label") or key,
                "sup": superseded,
                "ab": signed.get("approved_by") or p["reviewed_by"] or actor,
                "sb": signed.get("second_approved_by"),
                "log": changelog,
            },
        )
        versions.append({"id": version_id, "rule_key": key, "revision_no": revision,
                         "effective_from": start, "effective_to": end})
        conn.execute(text("update change_proposal set status = 'published' where id = :id"), {"id": p["id"]})
        created.append({"rule_key": key, "rule_version_id": version_id,
                        "effective_from": start.isoformat()})

    snapshot_id = str(uuid.uuid4())
    conn.execute(
        text(
            "insert into corpus_snapshot (id, label, created_by, is_current, changelog) "
            "values (:id, :l, :by, false, :log)"
        ),
        {"id": snapshot_id, "l": label, "by": actor, "log": changelog},
    )
    for v in versions:
        conn.execute(
            text("insert into snapshot_rule_version (snapshot_id, rule_version_id) values (:s, :v)"),
            {"s": snapshot_id, "v": v["id"]},
        )

    # No gaps: every required rule must still resolve, for every supported
    # year, in the snapshot about to go live.
    gaps = []
    for key in [*REQUIRED_RULE_KEYS, "deadline.return_filing"]:
        for ya in get_settings().supported_yas:
            try:
                resolve(conn, key, ya, snapshot_id)
            except (UnresolvedRule, AmbiguousRule) as exc:
                gaps.append(f"{key} {ya}: {exc}")
    if gaps:
        conn.rollback()
        raise HTTPException(409, "Publishing would leave a gap, so nothing was published. " + "; ".join(gaps[:5]))

    conn.execute(text("update corpus_snapshot set is_current = false where is_current"))
    conn.execute(text("update corpus_snapshot set is_current = true where id = :id"), {"id": snapshot_id})
    _audit(conn, actor, "snapshot.publish", "corpus_snapshot", snapshot_id, None,
           {"label": label, "changelog": changelog, "rules": created})
    return {"snapshot_id": snapshot_id, "label": label, "changelog": changelog, "published": created}


@router.get("/snapshots")
def list_snapshots(user: ReviewerDep) -> dict[str, Any]:
    with db_conn() as conn:
        rows = conn.execute(
            text(
                "select s.id, s.label, s.created_at, s.created_by, s.is_current, "
                "       s.changelog, count(srv.rule_version_id) as rule_count "
                "  from corpus_snapshot s "
                "  left join snapshot_rule_version srv on srv.snapshot_id = s.id "
                " group by s.id order by s.created_at desc limit 50"
            )
        ).mappings().all()
    return {
        "snapshots": [{**dict(r), "id": str(r["id"])} for r in rows]
    }


@router.post("/snapshots/{snapshot_id}/rollback")
def rollback(snapshot_id: str, user: AdminDep) -> dict[str, Any]:
    """Rollback selects a previous snapshot and marks it current.

    Because every answer already records the snapshot it used, rollback never
    rewrites history. It only changes what new answers resolve against.
    """
    snapshot_id = _uuid_or_404(snapshot_id, "Snapshot")
    with db_conn() as conn:
        target = conn.execute(
            text("select id, label from corpus_snapshot where id = :id"),
            {"id": snapshot_id},
        ).mappings().first()
        if not target:
            raise HTTPException(404, "Snapshot not found")

        previous = current_snapshot(conn)
        keys = conn.execute(
            text(
                "select distinct rv.rule_key from snapshot_rule_version srv "
                "  join rule_version rv on rv.id = srv.rule_version_id "
                " where srv.snapshot_id = :id order by rv.rule_key"
            ),
            {"id": snapshot_id},
        ).scalars().all()

        conn.execute(text("update corpus_snapshot set is_current = false"))
        conn.execute(
            text("update corpus_snapshot set is_current = true where id = :id"),
            {"id": snapshot_id},
        )
        _audit(conn, user.email, "snapshot.rollback", "corpus_snapshot", snapshot_id,
               {"from": str(previous["id"]) if previous else None},
               {"to": snapshot_id, "affected_rule_keys": keys})
        conn.commit()
        index = _reindex_rule_text(conn)

    return {
        "ok": True,
        "current_snapshot_id": snapshot_id,
        "label": target["label"],
        "affected_rule_keys": keys,
        "index": index,
    }


# ---------------------------------------------------------------------------
# Corpus health, audit, users
# ---------------------------------------------------------------------------

def _covers(versions: list, start: date, end: date) -> bool:
    """True when the versions, taken in order, leave no day from start to end."""
    day = start
    for v in sorted(versions, key=lambda v: v["effective_from"]):
        if v["effective_from"] > day:
            return False
        if v["effective_to"] is None:
            return True
        day = max(day, v["effective_to"] + timedelta(days=1))
        if day > end:
            return True
    return day > end


@router.get("/health/corpus")
def corpus_health(user: ReviewerDep) -> dict[str, Any]:
    """Coverage matrix, staleness, SLA breaches (spec section 5.1 F)."""
    from app.compute.engine import REQUIRED_RULE_KEYS
    from app.core.config import get_settings
    from app.rules.resolver import UnresolvedRule, ya_start_date, resolve

    settings = get_settings()
    keys = REQUIRED_RULE_KEYS + ["deadline.return_filing"]

    with db_conn() as conn:
        snap = current_snapshot(conn)
        coverage = []
        if snap:
            for key in keys:
                row: dict[str, Any] = {"rule_key": key, "years": {}}
                versions = conn.execute(
                    text(
                        "select rv.effective_from, rv.effective_to, rv.citation_label "
                        "  from rule_version rv join snapshot_rule_version s on s.rule_version_id = rv.id "
                        " where s.snapshot_id = :s and rv.rule_key = :k and rv.status = 'published' "
                        " order by rv.effective_from"
                    ),
                    {"s": str(snap["id"]), "k": key},
                ).mappings().all()
                for ya in settings.supported_yas:
                    try:
                        rv = resolve(conn, key, ya, str(snap["id"]))
                        start = ya_start_date(ya)
                        end = date(start.year + 1, 3, 31)
                        # A year can be covered by several versions in turn, as
                        # when a circular changes a rule mid-year. Amber only
                        # when some day of the year has no version at all.
                        in_year = [v for v in versions if v["effective_from"] <= end
                                   and (v["effective_to"] is None or v["effective_to"] >= start)]
                        row["years"][ya] = {
                            "state": "green" if _covers(in_year, start, end) else "amber",
                            "citation": rv.citation_label,
                            "effective_from": rv.effective_from.isoformat(),
                            "effective_to": rv.effective_to.isoformat()
                            if rv.effective_to else None,
                            "later": [
                                {"citation": v["citation_label"], "effective_from": v["effective_from"].isoformat()}
                                for v in in_year if v["effective_from"] > rv.effective_from
                            ],
                        }
                    except Exception as exc:  # noqa: BLE001
                        row["years"][ya] = {"state": "red", "error": str(exc)[:120]}
                coverage.append(row)

        sources = conn.execute(
            text(
                "select source_id, name, priority, enabled, last_run_at, "
                "       last_status, last_error, last_change_at "
                "  from source order by priority, source_id"
            )
        ).mappings().all()

        open_props = conn.execute(
            text(
                "select priority, count(*) as n, min(created_at) as oldest "
                "  from change_proposal "
                " where status in ('needs_review','in_review','changes_requested') "
                " group by priority order by priority"
            )
        ).mappings().all()

        corrections = conn.execute(
            text(
                "select field, count(*) as n from reviewer_correction "
                " group by field order by n desc limit 10"
            )
        ).mappings().all()

        totals = conn.execute(
            text(
                "select "
                "  (select count(*) from change_proposal) as proposals, "
                "  (select count(*) from change_proposal where status='rejected') as rejected, "
                "  (select count(*) from rule_version where status='published') as published_versions, "
                "  (select count(*) from source_document) as documents"
            )
        ).mappings().one()

    from datetime import datetime, timezone

    now = datetime.now(timezone.utc)
    source_rows = []
    for s in sources:
        d = dict(s)
        if d["last_change_at"]:
            d["days_since_change"] = (now - d["last_change_at"]).days
        else:
            d["days_since_change"] = None
        # A high priority source silent for 90 days may mean the crawler broke.
        d["stale"] = (
            d["priority"] == "high"
            and (d["days_since_change"] is None or d["days_since_change"] > 90)
        )
        source_rows.append(d)

    return {
        "snapshot": {"id": str(snap["id"]), "label": snap["label"]} if snap else None,
        "coverage": coverage,
        "sources": source_rows,
        "open_proposals": [dict(r) for r in open_props],
        "correction_rate": [dict(r) for r in corrections],
        "totals": dict(totals),
    }


@router.get("/audit")
def audit_log(
    user: ReviewerDep,
    limit: int = Query(100, ge=1, le=500),
    action: str | None = Query(None),
) -> dict[str, Any]:
    clauses, params = ["1=1"], {"limit": limit}
    if action:
        clauses.append("e.action = :action")
        params["action"] = action

    with db_conn() as conn:
        rows = conn.execute(
            text(
                f"select e.id, e.actor, e.action, e.target_type, e.target_id, "
                f"       e.before_json, e.after_json, e.at, "
                f"       coalesce(u.name, u.email) as actor_name, u.email as actor_email "
                f"  from review_event e "
                f"  left join app_user u on u.id::text = e.actor or u.email = e.actor "
                f" where {' and '.join(clauses)} "
                f" order by e.at desc limit :limit"
            ),
            params,
        ).mappings().all()
    return {"events": [{**dict(r), "id": str(r["id"])} for r in rows]}


@router.get("/escalations")
def escalations(user: ReviewerDep) -> dict[str, Any]:
    """User flags, bound to the rule version and run that produced the figure,
    so a reviewer can reproduce the answer (spec section 5.1 G)."""
    with db_conn() as conn:
        rows = conn.execute(
            text(
                "select e.id, e.step_no, e.note, e.status, e.created_at, "
                "       e.computation_run_id, e.rule_version_id, "
                "       e.resolved_by, e.resolved_at, e.resolution, "
                "       coalesce(u.name, u.email) as flagged_by, "
                "       rv.rule_key, rv.citation_label, "
                "       r.ya, r.corpus_snapshot_id, r.facts_redacted_json "
                "  from escalation e "
                "  left join app_user u on u.id = e.flagged_by "
                "  left join rule_version rv on rv.id = e.rule_version_id "
                "  left join computation_run r on r.id = e.computation_run_id "
                " order by (e.status = 'open') desc, e.created_at desc limit 100"
            )
        ).mappings().all()
    return {
        "escalations": [
            {
                **dict(r),
                "id": str(r["id"]),
                "computation_run_id": str(r["computation_run_id"])
                if r["computation_run_id"] else None,
                "rule_version_id": str(r["rule_version_id"])
                if r["rule_version_id"] else None,
                "corpus_snapshot_id": str(r["corpus_snapshot_id"])
                if r["corpus_snapshot_id"] else None,
            }
            for r in rows
        ]
    }


@router.patch("/escalations/{escalation_id}")
def close_escalation(
    escalation_id: str, user: ReviewerDep, payload: dict[str, Any] = Body(...)
) -> dict[str, Any]:
    """Close a flag as resolved or dismissed, with a note, or reopen it."""
    escalation_id = _uuid_or_404(escalation_id, "Escalation")
    status = payload.get("status")
    if status not in ("resolved", "dismissed", "open"):
        raise HTTPException(400, "status must be resolved, dismissed or open")
    note = str(payload.get("note") or "").strip()[:2000]
    if status != "open" and not note:
        raise HTTPException(400, "Say what was found, so the next reviewer knows why it was closed.")

    with db_conn() as conn:
        before = conn.execute(
            text("select status, computation_run_id, step_no from escalation where id = :id"),
            {"id": escalation_id},
        ).mappings().first()
        if not before:
            raise HTTPException(404, "Escalation not found")
        try:
            conn.execute(
                text(
                    "update escalation set status = :s, resolution = :n, "
                    "resolved_by = case when :s = 'open' then null else :by end, "
                    "resolved_at = case when :s = 'open' then null else now() end "
                    "where id = :id"
                ),
                {"s": status, "n": note or None, "by": user.email, "id": escalation_id},
            )
        except IntegrityError as exc:
            raise HTTPException(409, "This step already has an open flag.") from exc
        _audit(conn, user.email, f"escalation.{status}", "escalation", escalation_id,
               {"status": before["status"]}, {"status": status, "note": note})
        conn.commit()
    return {"ok": True, "status": status}


@router.get("/users")
def list_users(user: AdminDep) -> dict[str, Any]:
    with db_conn() as conn:
        rows = conn.execute(
            text(
                "select id, email, name, picture, role, created_at, last_seen_at "
                "  from app_user order by created_at"
            )
        ).mappings().all()
    return {"users": [{**dict(r), "id": str(r["id"])} for r in rows]}


@router.patch("/users/{user_id}")
def set_role(
    user_id: str, user: AdminDep, payload: dict[str, Any] = Body(...)
) -> dict[str, Any]:
    user_id = _uuid_or_404(user_id, "User")
    role = payload.get("role")
    valid = {"free", "individual", "practice", "reviewer", "approver",
             "admin", "auditor"}
    if role not in valid:
        raise HTTPException(400, f"role must be one of {sorted(valid)}")

    with db_conn() as conn:
        before = conn.execute(
            text("select email, role from app_user where id = :id"), {"id": user_id}
        ).mappings().first()
        if not before:
            raise HTTPException(404, "User not found")
        # An admin removing their own admin role could lock everyone out.
        if str(user.id) == user_id and role != "admin":
            raise HTTPException(
                409, "You cannot remove your own admin role. Ask another admin."
            )

        conn.execute(
            text("update app_user set role = :r where id = :id"),
            {"r": role, "id": user_id},
        )
        _audit(conn, user.email, "user.role", "app_user", user_id,
               dict(before), {"role": role})
        conn.commit()
    return {"ok": True, "email": before["email"], "role": role}


# ---------------------------------------------------------------------------
# The corpus agent: status, manual cycle, re-extraction, index rebuild
# ---------------------------------------------------------------------------

@router.get("/agent/status")
def agent_status(user: ReviewerDep) -> dict[str, Any]:
    from app.corpus import scheduler

    with db_conn() as conn:
        cycles = conn.execute(
            text(
                "select id, trigger, started_at, finished_at, crawled_sources, "
                "       new_documents, revisions, extracted_documents, "
                "       proposals_created, chunks_indexed, llm_tokens, errors, summary "
                "  from agent_cycle order by started_at desc limit 12"
            )
        ).mappings().all()
        index_stats = conn.execute(
            text(
                "select count(*) as chunks, "
                "       count(*) filter (where embedding is not null) as embedded, "
                "       count(*) filter (where rule_key is not null) as rule_chunks, "
                "       count(distinct source_document_id) as documents "
                "  from chunk where status = 'published'"
            )
        ).mappings().one()
        pending = conn.execute(
            text(
                "select count(*) from change_proposal p join source_document d "
                "  on d.id = p.source_document_id "
                " where p.rule_key is null and p.status = 'needs_review' "
                "   and d.raw_text is not null"
            )
        ).scalar_one()

    return {
        **scheduler.status(),
        "cycles": [
            {**dict(c), "id": str(c["id"]),
             "started_at": c["started_at"].isoformat() if c["started_at"] else None,
             "finished_at": c["finished_at"].isoformat() if c["finished_at"] else None}
            for c in cycles
        ],
        "index": dict(index_stats),
        "awaiting_extraction": pending,
    }


@router.post("/agent/run")
def agent_run_now(user: ReviewerDep) -> dict[str, Any]:
    """Run one full agent cycle now, synchronously, and return what it did."""
    from app.corpus import scheduler

    report = scheduler.run_cycle(trigger=f"manual:{user.email}")
    with db_conn() as conn:
        _audit(conn, user.email, "agent.run", "agent_cycle", report.id, None,
               {"summary": report.summary})
        conn.commit()
    return report.to_json()


@router.post("/proposals/{proposal_id}/extract")
def reextract(proposal_id: str, user: ReviewerDep) -> dict[str, Any]:
    """Run the LLM extractor again on this proposal's document.

    Useful after a reviewer uploads a better copy, or when the first attempt
    failed. Creates new proposal rows for anything found; never touches a
    proposal the reviewer has already edited or approved.
    """
    from app.corpus import extractor

    proposal_id = _uuid_or_404(proposal_id, "Proposal")
    with db_conn() as conn:
        row = conn.execute(
            text(
                "select source_document_id, status from change_proposal where id = :id"
            ),
            {"id": proposal_id},
        ).mappings().first()
        if not row or not row["source_document_id"]:
            raise HTTPException(404, "Proposal or its document not found")
        if row["status"] in ("approved", "published"):
            raise HTTPException(409, "This proposal is already approved; re-extraction would not apply.")

        # Reset the extractor marker so it runs again, then run it.
        conn.execute(
            text(
                "update source_document set text_meta = text_meta - 'extractor_version' "
                " where id = :d"
            ),
            {"d": str(row["source_document_id"])},
        )
        conn.commit()
        report = extractor.extract_document(
            conn, str(row["source_document_id"]), replace_placeholder=True
        )
        _audit(conn, user.email, "proposal.reextract", "change_proposal",
               proposal_id, None, report.to_json())
        conn.commit()
    return report.to_json()


@router.post("/index/rebuild")
def rebuild_index(user: AdminDep) -> dict[str, Any]:
    """Drop and rebuild every retrieval chunk. Slow; admin only."""
    from app.retrieval import indexer

    with db_conn() as conn:
        report = indexer.rebuild_all(conn)
        _audit(conn, user.email, "index.rebuild", "chunk", "all", None, report.to_json())
        conn.commit()
    return report.to_json()


@router.get("/me")
def whoami(user: CurrentUserDep) -> dict[str, Any]:
    return {
        "id": user.id,
        "email": user.email,
        "name": user.name,
        "role": user.role,
        "is_reviewer": user.is_reviewer,
        "can_approve": user.can_approve,
    }
