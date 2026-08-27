"""Admin API (spec section 5).

The admin panel is where the product's claim is actually true, so it is a
first-class surface rather than internal tooling.

Two invariants hold everywhere in this file:
  1. Publishing creates a new corpus snapshot; it is never a row update.
  2. Anything that changes a computed figure needs two distinct humans.
"""

from __future__ import annotations

import json
import uuid
from datetime import date
from typing import Any

from fastapi import APIRouter, Body, HTTPException, Query
from sqlalchemy import text

from app.admin import impact as impact_mod
from app.core.auth import AdminDep, ApproverDep, CurrentUserDep, ReviewerDep, User
from app.db.session import db_conn
from app.rules.resolver import RuleVersion, current_snapshot

router = APIRouter(prefix="/admin")

# Rule keys whose value feeds a computed figure. Changing one needs dual
# control (spec section 5.1 E).
VALUE_BEARING_PREFIXES = (
    "band.", "relief.", "credit.", "deduction.", "charge.", "deadline.", "apit.",
)


def _is_value_bearing(rule_key: str) -> bool:
    return rule_key.startswith(VALUE_BEARING_PREFIXES)


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
                       p.effective_to, p.quoted_text, p.assigned_to,
                       d.title as document_title, d.url as document_url,
                       d.revision_no, d.supersedes_id, d.doc_type, d.published_at
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
        d["is_revision_of_published"] = d["supersedes_id"] is not None
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


@router.get("/proposals/{proposal_id}")
def get_proposal(proposal_id: str, user: ReviewerDep) -> dict[str, Any]:
    """Document viewer payload: the extracted values plus the quoted sentence
    each came from, and the currently published version to diff against."""
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
    recorded as a correction, which becomes the extractor's eval set."""
    editable = {"rule_key", "operation", "value_json", "effective_from",
                "effective_to", "quoted_text", "assigned_to", "status"}
    changes = {k: v for k, v in payload.items() if k in editable}
    if not changes:
        raise HTTPException(400, "No editable fields supplied")

    with db_conn() as conn:
        before = conn.execute(
            text("select * from change_proposal where id = :id"), {"id": proposal_id}
        ).mappings().first()
        if not before:
            raise HTTPException(404, "Proposal not found")

        sets, params = [], {"id": proposal_id}
        for k, v in changes.items():
            if k == "value_json":
                sets.append("value_json = cast(:value_json as jsonb)")
                params["value_json"] = json.dumps(v)
            else:
                sets.append(f"{k} = :{k}")
                params[k] = v
        sets.append("reviewed_by = :actor")
        sets.append("reviewed_at = now()")
        params["actor"] = user.email

        conn.execute(
            text(f"update change_proposal set {', '.join(sets)} where id = :id"),
            params,
        )

        for field, after_value in changes.items():
            before_value = before[field] if field in before else None
            if json.dumps(before_value, default=str) == json.dumps(after_value, default=str):
                continue
            conn.execute(
                text(
                    "insert into reviewer_correction (proposal_id, field, "
                    "before_value, after_value, actor) values "
                    "(:p, :f, :b, :a, :actor)"
                ),
                {
                    "p": proposal_id, "f": field,
                    "b": json.dumps(before_value, default=str)[:2000],
                    "a": json.dumps(after_value, default=str)[:2000],
                    "actor": user.email,
                },
            )

        _audit(conn, user.email, "proposal.edit", "change_proposal",
               proposal_id, dict(before), changes)
        conn.commit()

    return {"ok": True, "corrections_recorded": len(changes)}


@router.post("/proposals/{proposal_id}/impact")
def proposal_impact(proposal_id: str, user: ReviewerDep) -> dict[str, Any]:
    """Run the golden set against the proposed corpus (spec section 5.1 D)."""
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
    reason = (payload.get("reason") or "").strip()
    if not reason:
        raise HTTPException(400, "A rejection must carry a reason")

    with db_conn() as conn:
        result = conn.execute(
            text(
                "update change_proposal set status = 'rejected', "
                "reject_reason = :r, reviewed_by = :a, reviewed_at = now() "
                "where id = :id returning rule_key"
            ),
            {"r": reason[:2000], "a": user.email, "id": proposal_id},
        ).first()
        if not result:
            raise HTTPException(404, "Proposal not found")
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
    with db_conn() as conn:
        row = conn.execute(
            text("select * from change_proposal where id = :id"), {"id": proposal_id}
        ).mappings().first()
        if not row:
            raise HTTPException(404, "Proposal not found")
        if row["status"] in ("published", "rejected"):
            raise HTTPException(409, f"Proposal is already {row['status']}")

        needs_dual = _is_value_bearing(row["rule_key"] or "")
        corrected = row["corrected_json"] or {}
        first_approver = corrected.get("approved_by")

        if not needs_dual:
            conn.execute(
                text(
                    "update change_proposal set status = 'approved', "
                    "reviewed_by = :a, reviewed_at = now() where id = :id"
                ),
                {"a": user.email, "id": proposal_id},
            )
            _audit(conn, user.email, "proposal.approve", "change_proposal",
                   proposal_id, None, {"dual_control": False})
            conn.commit()
            return {"ok": True, "status": "approved", "awaiting_second": False}

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

@router.post("/snapshots/publish")
def publish(user: ApproverDep, payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    """Publishing is not a row update. It creates a new corpus snapshot.

    Approved proposals become rule versions, the versions they supersede get an
    effective_to, and a new snapshot points at the resulting rule set.
    """
    changelog = (payload.get("changelog") or "").strip()
    if not changelog:
        raise HTTPException(
            400,
            "A changelog line is required. It is what users see in what changed.",
        )
    label = (payload.get("label") or date.today().strftime("%d %B %Y")).strip()

    with db_conn() as conn:
        approved = conn.execute(
            text(
                "select * from change_proposal where status = 'approved' "
                "order by created_at"
            )
        ).mappings().all()
        if not approved:
            raise HTTPException(400, "No approved proposals to publish")

        current = current_snapshot(conn)
        snapshot_id = str(uuid.uuid4())
        conn.execute(
            text(
                "insert into corpus_snapshot (id, label, created_by, is_current, "
                "changelog) values (:id, :l, :by, false, :log)"
            ),
            {"id": snapshot_id, "l": label, "by": user.email, "log": changelog},
        )

        # Carry forward every version in the current snapshot, except the rule
        # keys this publish replaces.
        replaced_keys = {p["rule_key"] for p in approved if p["rule_key"]}
        if current:
            conn.execute(
                text(
                    "insert into snapshot_rule_version (snapshot_id, rule_version_id) "
                    "select :new, srv.rule_version_id "
                    "  from snapshot_rule_version srv "
                    "  join rule_version rv on rv.id = srv.rule_version_id "
                    " where srv.snapshot_id = :old "
                    "   and (rv.rule_key <> all(:keys))"
                ),
                {
                    "new": snapshot_id,
                    "old": str(current["id"]),
                    "keys": list(replaced_keys) or [""],
                },
            )

        created: list[dict[str, Any]] = []
        for p in approved:
            if not p["rule_key"]:
                continue

            prior = conn.execute(
                text(
                    "select id, revision_no from rule_version "
                    " where rule_key = :k and status = 'published' "
                    " order by effective_from desc, revision_no desc limit 1"
                ),
                {"k": p["rule_key"]},
            ).mappings().first()

            conn.execute(
                text(
                    "insert into rule (rule_key, title, rule_type, unit) "
                    "values (:k, :k, 'amount', 'LKR') on conflict do nothing"
                ),
                {"k": p["rule_key"]},
            )

            approvals = p["corrected_json"] or {}
            version_id = str(uuid.uuid4())
            conn.execute(
                text(
                    "insert into rule_version (id, rule_key, revision_no, "
                    "value_json, effective_from, effective_to, "
                    "source_document_id, quoted_text, citation_label, status, "
                    "supersedes_version_id, approved_by, approved_at, "
                    "second_approved_by, second_approved_at, changelog_line) "
                    "values (:id, :k, :rev, cast(:v as jsonb), :ef, :et, :doc, "
                    ":q, :cite, 'published', :sup, :ab, now(), :sb, "
                    "case when :sb is null then null else now() end, :log)"
                ),
                {
                    "id": version_id,
                    "k": p["rule_key"],
                    "rev": (prior["revision_no"] + 1) if prior else 1,
                    "v": json.dumps(p["value_json"] or {}),
                    "ef": p["effective_from"] or date.today(),
                    "et": p["effective_to"],
                    "doc": p["source_document_id"],
                    "q": p["quoted_text"],
                    "cite": (p["value_json"] or {}).get("citation_label")
                            or p["rule_key"],
                    "sup": prior["id"] if prior else None,
                    "ab": approvals.get("approved_by") or p["reviewed_by"] or user.email,
                    "sb": approvals.get("second_approved_by"),
                    "log": changelog,
                },
            )
            conn.execute(
                text(
                    "insert into snapshot_rule_version (snapshot_id, rule_version_id) "
                    "values (:s, :v)"
                ),
                {"s": snapshot_id, "v": version_id},
            )

            # Close the window on the version this supersedes, so the new rule
            # takes over from its effective date and no overlap exists.
            if prior and p["effective_from"]:
                conn.execute(
                    text(
                        "update rule_version set effective_to = :d, "
                        "status = case when status = 'published' "
                        "  then 'superseded' else status end "
                        " where id = :id and (effective_to is null "
                        "   or effective_to > :d)"
                    ),
                    {"d": p["effective_from"] - __import__("datetime").timedelta(days=1),
                     "id": prior["id"]},
                )

            conn.execute(
                text("update change_proposal set status = 'published' where id = :id"),
                {"id": p["id"]},
            )
            created.append({"rule_key": p["rule_key"], "rule_version_id": version_id})

        conn.execute(text("update corpus_snapshot set is_current = false"))
        conn.execute(
            text("update corpus_snapshot set is_current = true where id = :id"),
            {"id": snapshot_id},
        )
        _audit(conn, user.email, "snapshot.publish", "corpus_snapshot",
               snapshot_id, None, {"label": label, "changelog": changelog,
                                   "rules": created})
        conn.commit()

    return {
        "ok": True,
        "snapshot_id": snapshot_id,
        "label": label,
        "changelog": changelog,
        "published": created,
    }


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

    return {
        "ok": True,
        "current_snapshot_id": snapshot_id,
        "label": target["label"],
        "affected_rule_keys": keys,
    }


# ---------------------------------------------------------------------------
# Corpus health, audit, users
# ---------------------------------------------------------------------------

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
                for ya in settings.supported_yas:
                    try:
                        rv = resolve(conn, key, ya, str(snap["id"]))
                        # Amber when the version does not span the whole year.
                        covers_end = rv.effective_to is None or rv.effective_to >= date(
                            int(ya.split("/")[1]), 3, 31
                        )
                        row["years"][ya] = {
                            "state": "green" if covers_end else "amber",
                            "citation": rv.citation_label,
                            "effective_from": rv.effective_from.isoformat(),
                            "effective_to": rv.effective_to.isoformat()
                            if rv.effective_to else None,
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
    limit: int = Query(100, le=500),
    action: str | None = Query(None),
) -> dict[str, Any]:
    clauses, params = ["1=1"], {"limit": limit}
    if action:
        clauses.append("action = :action")
        params["action"] = action

    with db_conn() as conn:
        rows = conn.execute(
            text(
                f"select id, actor, action, target_type, target_id, "
                f"       before_json, after_json, at "
                f"  from review_event where {' and '.join(clauses)} "
                f" order by at desc limit :limit"
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
                "       rv.rule_key, rv.citation_label, "
                "       r.ya, r.corpus_snapshot_id, r.facts_redacted_json "
                "  from escalation e "
                "  left join rule_version rv on rv.id = e.rule_version_id "
                "  left join computation_run r on r.id = e.computation_run_id "
                " order by e.created_at desc limit 100"
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


@router.get("/users")
def list_users(user: AdminDep) -> dict[str, Any]:
    with db_conn() as conn:
        rows = conn.execute(
            text(
                "select id, email, name, role, created_at, last_seen_at "
                "  from app_user order by created_at"
            )
        ).mappings().all()
    return {"users": [{**dict(r), "id": str(r["id"])} for r in rows]}


@router.patch("/users/{user_id}")
def set_role(
    user_id: str, user: AdminDep, payload: dict[str, Any] = Body(...)
) -> dict[str, Any]:
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
