"""Which database the tests may touch (#61).

Tests marked `db` need Postgres. They run against a throwaway database named by
TEST_DATABASE_URL (CI starts one per run), or against the shared Supabase only
when CITETAX_TEST_SHARED_DB=1 says so on purpose. Otherwise they are skipped,
and DATABASE_URL is blanked, so a test that reaches for a database without the
marker fails loudly instead of quietly writing to the team's data.

This runs before any app module is imported, so the settings see the result.
"""

from __future__ import annotations

import os

import pytest

_TEST_DB = os.getenv("TEST_DATABASE_URL", "").strip()
_SHARED_OK = os.getenv("CITETAX_TEST_SHARED_DB") == "1"

if _TEST_DB:
    os.environ["DATABASE_URL"] = _TEST_DB
elif not _SHARED_OK:
    os.environ["DATABASE_URL"] = ""

# The background agent never runs under test.
os.environ["WATCH_INTERVAL_MINUTES"] = "0"

DATABASE_AVAILABLE = bool(_TEST_DB or _SHARED_OK)


@pytest.fixture(autouse=True)
def _lift_plan_limits(request, monkeypatch):
    """Tests ask many questions as one user or one address, and test accounts
    are on Free; plan limits would stop them partway. Only tests marked
    `plan_limits` run with them."""
    if "plan_limits" in request.keywords:
        from app.core import plans

        plans.guests.reset()
        return
    from app.core import plans

    monkeypatch.setattr(plans, "check_question_allowed", lambda *a, **k: None)
    monkeypatch.setattr(plans, "check_guest_allowed", lambda *a, **k: None)
    monkeypatch.setattr(plans, "check_payslip_allowed", lambda *a, **k: None)


def pytest_collection_modifyitems(config, items):
    if DATABASE_AVAILABLE:
        return
    skip = pytest.mark.skip(
        reason="needs a database: set TEST_DATABASE_URL to a throwaway Postgres, "
        "or CITETAX_TEST_SHARED_DB=1 to use the shared one on purpose"
    )
    for item in items:
        if "db" in item.keywords:
            item.add_marker(skip)
