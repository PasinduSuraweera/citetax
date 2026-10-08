"""Plans and their limits: Free, Individual and Team.

What a plan costs is set by what Citetax costs to run, not by what an answer
costs: an answer is about LKR 1 of model time (two calls on gpt-oss-120b,
around 6,500 tokens), while the database and hosting are around LKR 20,000 a
month whether anyone asks or not. So Free can be generous enough to show the
product, and paid plans pay for the fixed costs.

A question counts when it is answered. Refusals, clarifying questions and
greetings produce no run and cost nothing. Reviewers, approvers, admins and
auditors are never limited: they work on the corpus.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass
from datetime import date, datetime, timedelta

from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.engine import Connection

from app.core import years


@dataclass(frozen=True)
class Plan:
    key: str
    name: str
    # Answers a month. None means no limit.
    monthly_questions: int | None
    payslip: bool
    # The price as shown, in LKR. Nothing is charged yet.
    price_lkr: int
    price_unit: str


PLANS: dict[str, Plan] = {
    "free": Plan("free", "Free", 20, payslip=False, price_lkr=0, price_unit=""),
    "individual": Plan("individual", "Individual", 300, payslip=True,
                       price_lkr=1500, price_unit="per year of assessment"),
    "team": Plan("team", "Team", 1000, payslip=True,
                 price_lkr=5000, price_unit="per seat per month"),
}

# Someone not signed in, per address, per day in Colombo.
GUEST_DAILY_QUESTIONS = 5

STAFF_ROLES = ("reviewer", "approver", "admin", "auditor")


def plan_of(key: str | None) -> Plan:
    return PLANS.get(key or "free", PLANS["free"])


def month_start(today: date | None = None) -> date:
    today = today or years.today_colombo()
    return today.replace(day=1)


def next_month_start(today: date | None = None) -> date:
    start = month_start(today)
    return (start + timedelta(days=32)).replace(day=1)


def questions_used(conn: Connection, user_id: str, today: date | None = None) -> int:
    """Answers this calendar month, in Colombo time."""
    start = month_start(today)
    since = datetime(start.year, start.month, 1, tzinfo=years.COLOMBO)
    return int(conn.execute(
        text("select count(*) from computation_run where user_id = :u and created_at >= :since"),
        {"u": user_id, "since": since},
    ).scalar_one())


def usage(conn: Connection, user_id: str, plan_key: str, role: str) -> dict:
    plan = plan_of(plan_key)
    used = questions_used(conn, user_id)
    unlimited = role in STAFF_ROLES
    return {
        "plan": plan.key,
        "name": plan.name,
        "used": used,
        "limit": None if unlimited else plan.monthly_questions,
        "resets_on": next_month_start().isoformat(),
        "payslip": unlimited or plan.payslip,
        "staff": unlimited,
    }


def check_question_allowed(conn: Connection, user) -> None:
    """Raises 402 when a signed-in person has used this month's questions."""
    if user.role in STAFF_ROLES:
        return
    plan = plan_of(user.plan)
    if plan.monthly_questions is None:
        return
    used = questions_used(conn, user.id)
    if used < plan.monthly_questions:
        return
    resets = next_month_start()
    if plan.key == "free":
        more = f"Upgrade to Individual for {PLANS['individual'].monthly_questions} a month."
    else:
        more = "Contact us if you need more."
    raise HTTPException(
        402,
        f"You have used all {plan.monthly_questions} questions in your {plan.name} plan "
        f"this month. They reset on {resets.day} {resets:%B}. {more}",
    )


def check_payslip_allowed(user) -> None:
    if user is None:
        raise HTTPException(401, "Sign in to read a payslip")
    if user.role in STAFF_ROLES or plan_of(user.plan).payslip:
        return
    raise HTTPException(402, "Reading a payslip is part of the Individual and Team plans.")


class _GuestCounter:
    """Questions from someone not signed in, per address per day.

    Kept in memory, so it is per API instance and starts again on a restart.
    That is enough to stop a script running up the model bill; a person who
    wants more can sign in.
    """

    def __init__(self) -> None:
        self._day: date | None = None
        self._counts: dict[str, int] = {}
        self._lock = threading.Lock()

    def take(self, address: str, today: date | None = None) -> bool:
        today = today or years.today_colombo()
        with self._lock:
            if self._day != today:
                self._day, self._counts = today, {}
            used = self._counts.get(address, 0)
            if used >= GUEST_DAILY_QUESTIONS:
                return False
            self._counts[address] = used + 1
            return True

    def reset(self) -> None:
        with self._lock:
            self._day, self._counts = None, {}


guests = _GuestCounter()


def check_guest_allowed(address: str) -> None:
    if not guests.take(address):
        raise HTTPException(
            402,
            f"You have asked {GUEST_DAILY_QUESTIONS} questions today without an account. "
            "Sign in for free to ask more.",
        )
