"""Admin endpoints against the real database: review, dual control, publish,
escalations. Every row a test writes is removed again; publishing runs inside
a transaction that is rolled back, so the live corpus never moves."""

from __future__ import annotations

import json
import time
import uuid
from datetime import date

import jwt
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.core.config import get_settings
from app.db.session import db_conn
from app.main import app
from app.routers.admin import publish_snapshot
from app.rules.resolver import current_snapshot
from app.rules.resolver import resolve as _resolve

pytestmark = pytest.mark.db

client = TestClient(app)


@pytest.fixture
def staff():
    """Signed in users with a role. Returns a factory of (headers, email)."""
    emails: list[str] = []

    def make(role: str) -> tuple[dict[str, str], str]:
        email = f"admin-test-{role}-{uuid.uuid4().hex[:10]}@example.invalid"
        token = jwt.encode(
            {"email": email, "name": f"Test {role}", "exp": int(time.time()) + 3600},
            get_settings().auth_secret, algorithm="HS256",
        )
        headers = {"Authorization": f"Bearer {token}"}
        assert client.get("/admin/me", headers=headers).status_code == 200
        with db_conn() as conn:
            conn.execute(text("update app_user set role = :r where email = :e"), {"r": role, "e": email})
            conn.commit()
        emails.append(email)
        return headers, email

    yield make

    with db_conn() as conn:
        conn.execute(text("delete from review_event where actor = any(:e)"), {"e": emails})
        conn.execute(text("delete from app_user where email = any(:e)"), {"e": emails})
        conn.commit()


@pytest.fixture
def proposals():
    """Factory of proposals on a throwaway document. Cleans up after."""
    doc_id = str(uuid.uuid4())
    ids: list[str] = []
    with db_conn() as conn:
        conn.execute(
            text(
                "insert into source_document (id, family_id, source_id, url, sha256, doc_type, title) "
                "values (:id, :id, 'manual-upload', :u, :h, 'circular', 'admin test document')"
            ),
            {"id": doc_id, "u": f"https://example.invalid/admin-test/{doc_id}", "h": uuid.uuid4().hex},
        )
        conn.commit()

    def make(rule_key: str | None, value: dict | None, effective_from: date | None = None,
             effective_to: date | None = None, status: str = "needs_review",
             corrected: dict | None = None) -> str:
        pid = str(uuid.uuid4())
        with db_conn() as conn:
            conn.execute(
                text(
                    "insert into change_proposal (id, source_document_id, rule_key, operation, "
                    "value_json, effective_from, effective_to, status, priority, quoted_text, "
                    "corrected_json) values (:id, :d, :k, 'amend', cast(:v as jsonb), :ef, :et, "
                    ":s, 2, 'admin test', cast(:c as jsonb))"
                ),
                {"id": pid, "d": doc_id, "k": rule_key, "v": json.dumps(value) if value else None,
                 "ef": effective_from, "et": effective_to, "s": status,
                 "c": json.dumps(corrected) if corrected else None},
            )
            conn.commit()
        ids.append(pid)
        return pid

    yield make

    with db_conn() as conn:
        conn.execute(text("delete from reviewer_correction where proposal_id = any(cast(:i as uuid[]))"), {"i": ids})
        conn.execute(text("delete from review_event where target_id = any(:i)"), {"i": ids})
        conn.execute(text("delete from change_proposal where source_document_id = :d"), {"d": doc_id})
        conn.execute(text("delete from source_document where id = :d"), {"d": doc_id})
        conn.commit()


def resolve(conn, key: str, ya: str, snapshot_id: str | None = None):
    return _resolve(conn, key, ya, snapshot_id or str(current_snapshot(conn)["id"]))


def _status(pid: str) -> tuple[str, dict]:
    with db_conn() as conn:
        row = conn.execute(
            text("select status, corrected_json from change_proposal where id = :id"), {"id": pid}
        ).first()
    return row[0], row[1] or {}


def _published_value(key: str, ya: str) -> dict:
    """The live value, so tests reuse real figures rather than inventing any."""
    with db_conn() as conn:
        return dict(resolve(conn, key, ya).value_json)


# ---------------------------------------------------------------------------
# Ids and states
# ---------------------------------------------------------------------------

def test_malformed_and_unknown_ids_are_404(staff):
    headers, _ = staff("reviewer")
    missing = str(uuid.uuid4())
    assert client.get("/admin/proposals/not-a-uuid", headers=headers).status_code == 404
    assert client.post(f"/admin/proposals/{missing}/approve", headers=headers, json={}).status_code == 404
    assert client.post("/admin/proposals/x/reject", headers=headers, json={"reason": "r"}).status_code == 404
    assert client.patch("/admin/escalations/x", headers=headers, json={"status": "resolved", "note": "n"}).status_code == 404
    assert client.get("/admin/audit?limit=0", headers=headers).status_code == 422


def test_edit_cannot_approve_or_touch_a_closed_proposal(staff, proposals):
    headers, _ = staff("reviewer")
    pid = proposals("relief.personal", _published_value("relief.personal", "2026/2027"), date(2026, 4, 1))
    r = client.patch(f"/admin/proposals/{pid}", headers=headers, json={"status": "approved"})
    assert r.status_code == 400

    done = proposals("relief.personal", {"amount": "1"}, date(2026, 4, 1), status="rejected")
    r = client.patch(f"/admin/proposals/{done}", headers=headers, json={"quoted_text": "x"})
    assert r.status_code == 409
    assert client.post(f"/admin/proposals/{done}/reject", headers=headers, json={"reason": "again"}).status_code == 409


def test_approve_refuses_an_incomplete_proposal(staff, proposals):
    headers, _ = staff("approver")
    no_key = proposals(None, None)
    assert client.post(f"/admin/proposals/{no_key}/approve", headers=headers, json={}).status_code == 400
    no_date = proposals("relief.personal", _published_value("relief.personal", "2026/2027"))
    r = client.post(f"/admin/proposals/{no_date}/approve", headers=headers, json={})
    assert r.status_code == 400
    assert "date" in r.json()["detail"]


# ---------------------------------------------------------------------------
# Dual control
# ---------------------------------------------------------------------------

def test_dual_control_needs_two_people_and_an_approver(staff, proposals):
    first, first_email = staff("reviewer")
    other_reviewer, _ = staff("reviewer")
    approver, approver_email = staff("approver")
    pid = proposals("relief.personal", _published_value("relief.personal", "2026/2027"), date(2026, 4, 1))

    r = client.post(f"/admin/proposals/{pid}/approve", headers=first, json={})
    assert r.json()["awaiting_second"] is True
    assert _status(pid) == ("in_review", {"approved_by": first_email})

    # The same person twice is the thing dual control exists to stop.
    assert client.post(f"/admin/proposals/{pid}/approve", headers=first, json={}).status_code == 409
    # A second reviewer without the approver role cannot countersign.
    assert client.post(f"/admin/proposals/{pid}/approve", headers=other_reviewer, json={}).status_code == 403

    r = client.post(f"/admin/proposals/{pid}/approve", headers=approver, json={})
    assert r.status_code == 200
    status, signed = _status(pid)
    assert status == "approved"
    assert signed == {"approved_by": first_email, "second_approved_by": approver_email}
    assert client.post(f"/admin/proposals/{pid}/approve", headers=approver, json={}).status_code == 409


def test_changing_a_signed_value_clears_the_signatures(staff, proposals):
    """Whoever signed approved the old value, not the new one."""
    reviewer, _ = staff("reviewer")
    pid = proposals("relief.personal", _published_value("relief.personal", "2026/2027"), date(2026, 4, 1))
    client.post(f"/admin/proposals/{pid}/approve", headers=reviewer, json={})

    # A note is not what gets published, so the signature stands.
    r = client.patch(f"/admin/proposals/{pid}", headers=reviewer, json={"quoted_text": "fuller quote"})
    assert r.json()["signatures_cleared"] is False
    assert _status(pid)[1].get("approved_by")

    r = client.patch(f"/admin/proposals/{pid}", headers=reviewer, json={"effective_from": "2026-05-01"})
    assert r.json()["signatures_cleared"] is True
    status, signed = _status(pid)
    assert status == "needs_review"
    assert "approved_by" not in signed


# ---------------------------------------------------------------------------
# Publishing, inside a transaction that is always rolled back
# ---------------------------------------------------------------------------

def _stage(conn, key: str, value: dict, ef: date, et: date | None) -> None:
    """Make this the only approved proposal, fully signed."""
    conn.execute(text("update change_proposal set status = 'in_review' where status = 'approved'"))
    conn.execute(
        text(
            "insert into change_proposal (rule_key, operation, value_json, effective_from, "
            "effective_to, status, corrected_json, quoted_text) values (:k, 'amend', "
            "cast(:v as jsonb), :ef, :et, 'approved', cast(:c as jsonb), 'admin test')"
        ),
        {"k": key, "v": json.dumps(value), "ef": ef, "et": et,
         "c": json.dumps({"approved_by": "a@example.invalid", "second_approved_by": "b@example.invalid"})},
    )


def test_publishing_one_year_keeps_the_other_and_never_edits_old_rows():
    key = "deadline.return_filing"
    with db_conn() as conn:
        try:
            old_snap = current_snapshot(conn)
            before_2025 = resolve(conn, key, "2025/2026")
            before_2026 = resolve(conn, key, "2026/2027")
            old_rows = conn.execute(
                text(
                    "select rv.id, rv.effective_from, rv.effective_to from rule_version rv "
                    "join snapshot_rule_version s on s.rule_version_id = rv.id where s.snapshot_id = :s"
                ),
                {"s": str(old_snap["id"])},
            ).all()

            _stage(conn, key, dict(before_2026.value_json), date(2026, 4, 1), date(2027, 3, 31))
            result = publish_snapshot(conn, "admin-test", "admin test", "admin test")
            new_snap = result["snapshot_id"]

            after_2025 = resolve(conn, key, "2025/2026", new_snap)
            after_2026 = resolve(conn, key, "2026/2027", new_snap)
            assert after_2025.value_json == before_2025.value_json
            assert after_2025.effective_from == before_2025.effective_from
            assert after_2026.id == result["published"][0]["rule_version_id"]

            # Old snapshots keep exactly the rows they had.
            again = conn.execute(
                text("select id, effective_from, effective_to from rule_version where id = any(cast(:i as uuid[]))"),
                {"i": [str(r[0]) for r in old_rows]},
            ).all()
            assert sorted(map(tuple, again)) == sorted(map(tuple, old_rows))
            assert str(current_snapshot(conn)["id"]) == new_snap
        finally:
            conn.rollback()


def test_publish_that_would_leave_a_gap_publishes_nothing(monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "supported_yas", ("2024/2025", *settings.supported_yas))
    key = "deadline.return_filing"
    with db_conn() as conn:
        try:
            current = str(current_snapshot(conn)["id"])
            value = dict(resolve(conn, key, "2026/2027").value_json)
            _stage(conn, key, value, date(2026, 4, 1), date(2027, 3, 31))
            with pytest.raises(HTTPException) as err:
                publish_snapshot(conn, "admin-test", "admin test gap", "admin test")
            assert err.value.status_code == 409
            assert "gap" in err.value.detail
            assert str(current_snapshot(conn)["id"]) == current
        finally:
            conn.rollback()


def test_publish_refuses_a_single_signature():
    with db_conn() as conn:
        try:
            conn.execute(text("update change_proposal set status = 'in_review' where status = 'approved'"))
            conn.execute(
                text(
                    "insert into change_proposal (rule_key, value_json, effective_from, status, corrected_json) "
                    "values ('relief.personal', '{\"amount\": \"1\"}', '2026-04-01', 'approved', "
                    "'{\"approved_by\": \"a@example.invalid\"}')"
                )
            )
            with pytest.raises(HTTPException) as err:
                publish_snapshot(conn, "admin-test", "admin test", "admin test")
            assert err.value.status_code == 409
        finally:
            conn.rollback()


# ---------------------------------------------------------------------------
# Flags and escalations
# ---------------------------------------------------------------------------

@pytest.fixture
def run_id():
    rid = str(uuid.uuid4())
    ledger = {"steps": [{"step_no": 1, "label": "Assessable income", "rule_key": "income.assessable",
                         "rule_version_id": None}]}
    with db_conn() as conn:
        conn.execute(
            text("insert into computation_run (id, ya, ledger_json) values (:id, '2026/2027', cast(:l as jsonb))"),
            {"id": rid, "l": json.dumps(ledger)},
        )
        conn.commit()
    yield rid
    with db_conn() as conn:
        ids = conn.execute(text("select id::text from escalation where computation_run_id = :r"), {"r": rid}).scalars().all()
        conn.execute(text("delete from review_event where target_id = any(:i)"), {"i": ids})
        conn.execute(text("delete from escalation where computation_run_id = :r"), {"r": rid})
        conn.execute(text("delete from computation_run where id = :r"), {"r": rid})
        conn.commit()


def test_flag_validates_the_run_and_the_step(run_id):
    assert client.post(f"/v1/runs/{uuid.uuid4()}/flag", json={"step_no": 1}).status_code == 404
    assert client.post("/v1/runs/nope/flag", json={"step_no": 1}).status_code == 404
    assert client.post(f"/v1/runs/{run_id}/flag", json={"step_no": "1"}).status_code == 422
    assert client.post(f"/v1/runs/{run_id}/flag", json={"step_no": 9}).status_code == 422

    first = client.post(f"/v1/runs/{run_id}/flag", json={"step_no": 1, "note": "looks high"}).json()
    again = client.post(f"/v1/runs/{run_id}/flag", json={"step_no": 1}).json()
    assert first["duplicate"] is False
    assert again == {"escalation_id": first["escalation_id"], "status": "open", "duplicate": True}


def test_reviewer_closes_and_reopens_a_flag(staff, run_id):
    headers, email = staff("reviewer")
    eid = client.post(f"/v1/runs/{run_id}/flag", json={"step_no": 1}).json()["escalation_id"]

    assert client.patch(f"/admin/escalations/{eid}", headers=headers, json={"status": "resolved"}).status_code == 400
    assert client.patch(f"/admin/escalations/{eid}", headers=headers, json={"status": "gone", "note": "x"}).status_code == 400
    r = client.patch(f"/admin/escalations/{eid}", headers=headers,
                     json={"status": "dismissed", "note": "Figure matches the Act."})
    assert r.status_code == 200

    listed = client.get("/admin/escalations", headers=headers).json()["escalations"]
    mine = next(e for e in listed if e["id"] == eid)
    assert (mine["status"], mine["resolved_by"], mine["resolution"]) == ("dismissed", email, "Figure matches the Act.")

    # Closed, so the same step can be flagged again as a new complaint.
    new = client.post(f"/v1/runs/{run_id}/flag", json={"step_no": 1}).json()
    assert new["duplicate"] is False
    # And the old one cannot be reopened on top of it.
    assert client.patch(f"/admin/escalations/{eid}", headers=headers, json={"status": "open"}).status_code == 409


# ---------------------------------------------------------------------------
# Sources and audit
# ---------------------------------------------------------------------------

def test_source_create_and_update_errors(staff):
    headers, _ = staff("admin")
    taken = {"source_id": "manual-upload", "name": "x", "index_url": "https://example.invalid", "doc_type": "circular"}
    assert client.post("/admin/sources", headers=headers, json=taken).status_code == 409
    assert client.post("/admin/sources", headers=headers, json={**taken, "source_id": "t", "index_url": "ftp://x"}).status_code == 400
    assert client.post("/admin/sources", headers=headers, json={**taken, "name": " "}).status_code == 400
    assert client.patch(f"/admin/sources/no-such-{uuid.uuid4().hex[:6]}", headers=headers, json={"enabled": False}).status_code == 404


def test_audit_names_the_actor(staff, proposals):
    headers, email = staff("reviewer")
    pid = proposals("relief.personal", {"amount": "1"}, date(2026, 4, 1))
    client.post(f"/admin/proposals/{pid}/reject", headers=headers, json={"reason": "test"})
    events = client.get("/admin/audit?action=proposal.reject", headers=headers).json()["events"]
    mine = next(e for e in events if e["target_id"] == pid)
    assert mine["actor_email"] == email
    assert mine["actor_name"]


def test_summary_counts_what_needs_attention(staff, proposals):
    headers, _ = staff("reviewer")
    before = client.get("/admin/summary", headers=headers).json()
    proposals("relief.personal", {"amount": "1"}, date(2026, 4, 1))
    after = client.get("/admin/summary", headers=headers).json()
    assert after["open_proposals"] == before["open_proposals"] + 1
    assert after["snapshot"]["label"]
    assert client.get("/admin/summary").status_code == 401
