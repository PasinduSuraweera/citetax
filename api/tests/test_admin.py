"""Impact preview and role tests (spec sections 5.1 D and 5.1 E)."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest

from app.admin.impact import golden_set, preview
from app.core.auth import User
from app.db.session import db_conn
from app.rules.resolver import RuleVersion, current_snapshot


def _snapshot_id() -> str:
    with db_conn() as conn:
        snap = current_snapshot(conn)
        assert snap is not None, "seed the corpus first"
        return str(snap["id"])


# ---------------------------------------------------------------------------
# Golden set
# ---------------------------------------------------------------------------

def test_golden_set_covers_both_years_and_band_edges():
    scenarios = golden_set()
    years = {s.ya for s in scenarios}
    assert years == {"2025/2026", "2026/2027"}
    names = {s.name for s in scenarios}
    assert "at relief threshold" in names
    assert "top band" in names
    assert len(scenarios) >= 40


# ---------------------------------------------------------------------------
# Impact preview
# ---------------------------------------------------------------------------

def test_identical_proposal_changes_nothing():
    """A proposal that matches the published rule must show zero movement,
    otherwise the reviewer cannot trust the ones that do move."""
    snapshot_id = _snapshot_id()
    with db_conn() as conn:
        report = preview(conn, snapshot_id, {})
    assert report.total >= 40
    assert report.changed == 0
    assert report.obligation_flips == 0
    assert report.errors == []


def test_raising_relief_lowers_tax_and_flips_obligations():
    """The consequence a reviewer is actually approving."""
    snapshot_id = _snapshot_id()
    bigger_relief = RuleVersion(
        id="proposed", rule_key="relief.personal", revision_no=99,
        value_json={"amount": "3000000"},
        effective_from=date(2025, 4, 1), effective_to=None,
        citation_label="proposed", quoted_text=None,
    )
    with db_conn() as conn:
        report = preview(conn, snapshot_id, {"relief.personal": bigger_relief})

    assert report.changed > 0
    # Every change must reduce tax: relief only ever subtracts.
    assert report.max_delta is not None and report.max_delta <= 0
    # Someone must stop having to file.
    assert report.obligation_flips > 0
    flips = [c for c in report.cases if c.obligation_flip]
    assert all(c.old_must_file and not c.new_must_file for c in flips)


def test_changing_bands_moves_the_top_earners_most():
    snapshot_id = _snapshot_id()
    steeper = RuleVersion(
        id="proposed", rule_key="band.progressive", revision_no=99,
        value_json={"bands": [
            {"upto": 1000000, "rate": "0.06"},
            {"upto": 1500000, "rate": "0.18"},
            {"upto": 2000000, "rate": "0.24"},
            {"upto": 2500000, "rate": "0.30"},
            {"upto": None, "rate": "0.45"},
        ]},
        effective_from=date(2025, 4, 1), effective_to=None,
        citation_label="proposed", quoted_text=None,
    )
    with db_conn() as conn:
        report = preview(conn, snapshot_id, {"band.progressive": steeper})

    assert report.changed > 0
    assert report.min_delta is not None and report.min_delta > 0  # tax goes up
    high = next(c for c in report.cases if c.scenario == "high earner")
    low = next(c for c in report.cases if c.scenario == "below relief")
    assert high.delta > 0
    assert low.delta == 0  # under the threshold, nothing to tax


def test_impact_report_serialises_money_as_strings():
    """Money must not become a float on the way to the reviewer."""
    snapshot_id = _snapshot_id()
    with db_conn() as conn:
        payload = preview(conn, snapshot_id, {}).to_json()
    assert isinstance(payload["cases"][0]["old_balance"], str)
    assert payload["cases"][0]["old_balance"].count(".") == 1


def test_broken_proposal_reports_an_error_rather_than_crashing():
    snapshot_id = _snapshot_id()
    nonsense = RuleVersion(
        id="proposed", rule_key="band.progressive", revision_no=99,
        value_json={"bands": []},   # a band table with no bands
        effective_from=date(2025, 4, 1), effective_to=None,
        citation_label="proposed", quoted_text=None,
    )
    with db_conn() as conn:
        report = preview(conn, snapshot_id, {"band.progressive": nonsense})
    assert report.errors
    assert all(c.error for c in report.cases)


# ---------------------------------------------------------------------------
# Roles and dual control
# ---------------------------------------------------------------------------

def _user(role: str) -> User:
    return User(id="u", email=f"{role}@example.com", name=role, role=role)


@pytest.mark.parametrize(
    "role,reviewer,approver",
    [
        ("individual", False, False),
        ("practice", False, False),
        ("reviewer", True, False),
        ("approver", True, True),
        ("admin", True, True),
    ],
)
def test_role_capabilities(role, reviewer, approver):
    u = _user(role)
    assert u.is_reviewer is reviewer
    assert u.can_approve is approver


def test_auditor_is_read_only_and_not_a_reviewer():
    """An auditor reads the log; they do not approve law."""
    u = _user("auditor")
    assert u.is_reviewer is False
    assert u.can_approve is False
    assert u.at_least("reviewer") is False


def test_role_hierarchy():
    assert _user("admin").at_least("reviewer") is True
    assert _user("reviewer").at_least("approver") is False
    assert _user("individual").at_least("reviewer") is False
