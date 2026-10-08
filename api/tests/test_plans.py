"""Plans: Free, Individual and Team, their limits, and asking for an upgrade."""

from __future__ import annotations

import time
import uuid
from datetime import date

import jwt
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.core import plans
from app.core.auth import User
from app.core.config import get_settings


def _user(plan="free", role="individual"):
    return User(id="u", email="u@example.invalid", name="U", role=role, plan=plan)


# --- unit --------------------------------------------------------------------

@pytest.mark.plan_limits
def test_a_guest_gets_five_questions_a_day():
    day = date(2026, 10, 8)
    assert all(plans.guests.take("1.2.3.4", day) for _ in range(plans.GUEST_DAILY_QUESTIONS))
    assert not plans.guests.take("1.2.3.4", day)
    assert plans.guests.take("5.6.7.8", day), "another address has its own allowance"
    assert plans.guests.take("1.2.3.4", date(2026, 10, 9)), "a new day starts again"


@pytest.mark.plan_limits
def test_a_guest_over_the_limit_is_asked_to_sign_in():
    for _ in range(plans.GUEST_DAILY_QUESTIONS):
        plans.check_guest_allowed("9.9.9.9")
    with pytest.raises(HTTPException) as e:
        plans.check_guest_allowed("9.9.9.9")
    assert e.value.status_code == 402 and "Sign in" in e.value.detail


@pytest.mark.plan_limits
def test_free_stops_at_its_monthly_limit(monkeypatch):
    monkeypatch.setattr(plans, "questions_used", lambda conn, uid, today=None: 19)
    plans.check_question_allowed(None, _user())
    monkeypatch.setattr(plans, "questions_used", lambda conn, uid, today=None: 20)
    with pytest.raises(HTTPException) as e:
        plans.check_question_allowed(None, _user())
    assert e.value.status_code == 402 and "Upgrade to Individual for 300 a month" in e.value.detail


@pytest.mark.plan_limits
def test_paid_plans_and_staff_go_further(monkeypatch):
    monkeypatch.setattr(plans, "questions_used", lambda conn, uid, today=None: 250)
    plans.check_question_allowed(None, _user("individual"))
    plans.check_question_allowed(None, _user("team"))
    monkeypatch.setattr(plans, "questions_used", lambda conn, uid, today=None: 10_000)
    plans.check_question_allowed(None, _user("free", role="approver"))


def test_payslip_reading_is_a_paid_feature():
    with pytest.raises(HTTPException) as e:
        plans.check_payslip_allowed(_user("free"))
    assert e.value.status_code == 402
    plans.check_payslip_allowed(_user("individual"))
    plans.check_payslip_allowed(_user("team"))
    plans.check_payslip_allowed(_user("free", role="admin"))


def test_the_month_resets_on_the_first():
    assert plans.next_month_start(date(2026, 10, 8)) == date(2026, 11, 1)
    assert plans.next_month_start(date(2026, 12, 31)) == date(2027, 1, 1)


def test_an_unknown_plan_is_free():
    assert plans.plan_of("gold").key == "free" and plans.plan_of(None).key == "free"


@pytest.mark.plan_limits
def test_a_greeting_never_uses_the_allowance():
    from app.routers.public import _check_allowance

    class Req:
        headers = {"x-forwarded-for": "7.7.7.7, 10.0.0.1"}
        client = None

    for _ in range(plans.GUEST_DAILY_QUESTIONS + 3):
        _check_allowance(None, None, Req(), "hi")
    for _ in range(plans.GUEST_DAILY_QUESTIONS):
        _check_allowance(None, None, Req(), "What do I owe on LKR 3,000,000?")
    with pytest.raises(HTTPException):
        _check_allowance(None, None, Req(), "What do I owe on LKR 3,000,000?")


# --- with the database -------------------------------------------------------

@pytest.fixture
def people():
    from app.db.session import db_conn
    from app.main import app

    client = TestClient(app)
    emails: list[str] = []

    def make(label: str, role: str | None = None) -> dict[str, str]:
        email = f"plan-test-{label}-{uuid.uuid4().hex[:10]}@example.invalid"
        token = jwt.encode({"email": email, "name": label, "exp": int(time.time()) + 3600},
                           get_settings().auth_secret, algorithm="HS256")
        headers = {"Authorization": f"Bearer {token}"}
        assert client.get("/v1/me/plan", headers=headers).status_code == 200
        if role:
            with db_conn() as conn:
                conn.execute(text("update app_user set role = :r where email = :e"), {"r": role, "e": email})
                conn.commit()
        emails.append(email)
        return headers

    yield client, make

    with db_conn() as conn:
        conn.execute(text("delete from review_event where actor = any(:e)"), {"e": emails})
        conn.execute(text("delete from app_user where email = any(:e)"), {"e": emails})
        conn.commit()


@pytest.mark.db
def test_a_new_account_is_free(people):
    client, make = people
    me = client.get("/v1/me/plan", headers=make("new")).json()
    assert (me["plan"], me["limit"], me["used"], me["payslip"]) == ("free", 20, 0, False)


@pytest.mark.db
def test_an_upgrade_is_requested_then_granted(people):
    client, make = people
    alice, admin = make("alice"), make("admin", role="admin")

    r = client.post("/v1/plan-requests", json={"plan": "team", "seats": 4}, headers=alice)
    assert r.status_code == 200
    r = client.post("/v1/plan-requests", json={"plan": "individual"}, headers=alice)
    assert r.status_code == 200, "asking again replaces the open request"
    assert client.get("/v1/me/plan", headers=alice).json()["request"]["plan"] == "individual"

    assert client.get("/admin/plan-requests", headers=alice).status_code == 403
    open_ = client.get("/admin/plan-requests", headers=admin).json()["requests"]
    mine = [x for x in open_ if x["id"] == r.json()["id"]]
    assert len(mine) == 1 and mine[0]["current_plan"] == "free"

    d = client.post(f"/admin/plan-requests/{mine[0]['id']}/decide", json={"decision": "grant"}, headers=admin)
    assert d.status_code == 200
    me = client.get("/v1/me/plan", headers=alice).json()
    assert (me["plan"], me["payslip"], me["request"]) == ("individual", True, None)

    again = client.post(f"/admin/plan-requests/{mine[0]['id']}/decide", json={"decision": "grant"}, headers=admin)
    assert again.status_code == 409


@pytest.mark.db
def test_an_admin_can_set_a_plan_directly(people):
    client, make = people
    bob, admin = make("bob"), make("admin2", role="admin")
    bob_id = next(u["id"] for u in client.get("/admin/users", headers=admin).json()["users"]
                  if u["email"].startswith("plan-test-bob"))
    r = client.patch(f"/admin/users/{bob_id}/plan", json={"plan": "team"}, headers=admin)
    assert r.status_code == 200
    assert client.get("/v1/me/plan", headers=bob).json()["plan"] == "team"
    assert client.patch(f"/admin/users/{bob_id}/plan", json={"plan": "gold"}, headers=admin).status_code == 400


@pytest.mark.db
def test_payslip_upload_is_refused_on_free(people):
    client, make = people
    r = client.post("/v1/payslip/extract", headers=make("carol"),
                    files={"file": ("p.png", b"x", "image/png")}, data={"ya": "2026/2027", "consent": "gemini"})
    assert r.status_code == 402
