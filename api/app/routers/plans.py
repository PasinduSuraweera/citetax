"""Plans: what each costs, what an account is on, and asking for an upgrade.

There is no payment gateway yet. An upgrade is a request that an admin grants
by hand, and the grant is recorded in the audit log like every other change.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, HTTPException
from sqlalchemy import text

from app.core import plans
from app.core.auth import AdminDep, CurrentUserDep
from app.db.session import db_conn
from app.routers.admin import _audit, _uuid_or_404

router = APIRouter()


def _plan_json(p: plans.Plan) -> dict[str, Any]:
    return {
        "key": p.key, "name": p.name, "monthly_questions": p.monthly_questions,
        "payslip": p.payslip, "price_lkr": p.price_lkr, "price_unit": p.price_unit,
    }


@router.get("/v1/plans")
def list_plans() -> dict[str, Any]:
    """The plans as the pricing page shows them. Public."""
    return {
        "plans": [_plan_json(p) for p in plans.PLANS.values()],
        "guest_daily_questions": plans.GUEST_DAILY_QUESTIONS,
    }


@router.get("/v1/me/plan")
def my_plan(user: CurrentUserDep) -> dict[str, Any]:
    with db_conn() as conn:
        out = plans.usage(conn, user.id, user.plan, user.role)
        req = conn.execute(
            text("select id, plan, seats, created_at from plan_request "
                 " where user_id = :u and status = 'open'"),
            {"u": user.id},
        ).mappings().first()
    out["request"] = {**dict(req), "id": str(req["id"])} if req else None
    return out


@router.post("/v1/plan-requests")
def request_plan(user: CurrentUserDep, payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    """Ask for Individual or Team. Asking again replaces an open request."""
    plan = payload.get("plan")
    if plan not in ("individual", "team"):
        raise HTTPException(400, "plan must be individual or team")
    if plan == user.plan:
        raise HTTPException(409, f"You are already on the {plans.plan_of(plan).name} plan.")
    try:
        seats = int(payload.get("seats") or 1)
    except (TypeError, ValueError):
        raise HTTPException(400, "seats must be a number") from None
    if plan == "individual":
        seats = 1
    if not 1 <= seats <= 500:
        raise HTTPException(400, "seats must be between 1 and 500")
    note = str(payload.get("note") or "").strip()[:1000] or None

    with db_conn() as conn:
        conn.execute(
            text("update plan_request set status = 'withdrawn', decided_at = now() "
                 " where user_id = :u and status = 'open'"),
            {"u": user.id},
        )
        row = conn.execute(
            text("insert into plan_request (user_id, plan, seats, note) "
                 "values (:u, :p, :s, :n) returning id, created_at"),
            {"u": user.id, "p": plan, "s": seats, "n": note},
        ).mappings().one()
        _audit(conn, user.email, "plan.request", "plan_request", str(row["id"]),
               None, {"plan": plan, "seats": seats})
        conn.commit()
    return {"ok": True, "id": str(row["id"]), "plan": plan, "seats": seats}


@router.delete("/v1/plan-requests/open")
def withdraw_request(user: CurrentUserDep) -> dict[str, Any]:
    with db_conn() as conn:
        n = conn.execute(
            text("update plan_request set status = 'withdrawn', decided_at = now() "
                 " where user_id = :u and status = 'open'"),
            {"u": user.id},
        ).rowcount
        conn.commit()
    return {"ok": True, "withdrawn": n}


# --- admin -------------------------------------------------------------------

@router.get("/admin/plan-requests")
def admin_requests(user: AdminDep, status: str = "open") -> dict[str, Any]:
    if status not in ("open", "granted", "declined", "withdrawn", "all"):
        raise HTTPException(400, "unknown status")
    with db_conn() as conn:
        rows = conn.execute(
            text(
                "select r.id, r.plan, r.seats, r.note, r.status, r.created_at, r.decided_by, "
                "       r.decided_at, u.id as user_id, u.email, u.name, u.plan as current_plan "
                "  from plan_request r join app_user u on u.id = r.user_id "
                " where (:s = 'all' or r.status = :s) order by r.created_at desc limit 200"
            ),
            {"s": status},
        ).mappings().all()
    return {"requests": [
        {**dict(r), "id": str(r["id"]), "user_id": str(r["user_id"])} for r in rows
    ]}


@router.post("/admin/plan-requests/{request_id}/decide")
def decide_request(
    request_id: str, user: AdminDep, payload: dict[str, Any] = Body(...)
) -> dict[str, Any]:
    request_id = _uuid_or_404(request_id, "Request")
    decision = payload.get("decision")
    if decision not in ("grant", "decline"):
        raise HTTPException(400, "decision must be grant or decline")
    with db_conn() as conn:
        req = conn.execute(
            text("select r.user_id, r.plan, r.seats, r.status, u.plan as current_plan, u.email "
                 "  from plan_request r join app_user u on u.id = r.user_id where r.id = :id"),
            {"id": request_id},
        ).mappings().first()
        if not req:
            raise HTTPException(404, "Request not found")
        if req["status"] != "open":
            raise HTTPException(409, f"This request is already {req['status']}.")
        status = "granted" if decision == "grant" else "declined"
        conn.execute(
            text("update plan_request set status = :s, decided_by = :by, decided_at = now() "
                 " where id = :id"),
            {"s": status, "by": user.email, "id": request_id},
        )
        if decision == "grant":
            _set_plan(conn, str(req["user_id"]), req["plan"], user.email)
        _audit(conn, user.email, f"plan.{status}", "plan_request", request_id,
               {"plan": req["current_plan"]}, {"plan": req["plan"], "seats": req["seats"]})
        conn.commit()
    return {"ok": True, "status": status, "email": req["email"], "plan": req["plan"]}


@router.patch("/admin/users/{user_id}/plan")
def set_user_plan(
    user_id: str, user: AdminDep, payload: dict[str, Any] = Body(...)
) -> dict[str, Any]:
    """Change a plan directly, without a request: a refund, a trial, a fix."""
    user_id = _uuid_or_404(user_id, "User")
    plan = payload.get("plan")
    if plan not in plans.PLANS:
        raise HTTPException(400, f"plan must be one of {sorted(plans.PLANS)}")
    with db_conn() as conn:
        before = conn.execute(
            text("select email, plan from app_user where id = :id"), {"id": user_id}
        ).mappings().first()
        if not before:
            raise HTTPException(404, "User not found")
        _set_plan(conn, user_id, plan, user.email)
        _audit(conn, user.email, "user.plan", "app_user", user_id, dict(before), {"plan": plan})
        conn.commit()
    return {"ok": True, "email": before["email"], "plan": plan}


def _set_plan(conn, user_id: str, plan: str, by: str) -> None:
    conn.execute(
        text("update app_user set plan = :p, plan_granted_by = :by, plan_granted_at = now() "
             " where id = :id"),
        {"p": plan, "by": by, "id": user_id},
    )
    # A plan granted directly settles any request for it.
    conn.execute(
        text("update plan_request set status = 'granted', decided_by = :by, decided_at = now() "
             " where user_id = :id and status = 'open' and plan = :p"),
        {"p": plan, "by": by, "id": user_id},
    )
