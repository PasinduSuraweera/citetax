"""Resolver tests, including the mid-year revision case (spec section 1.1).

The August 2026 story: one circular issued on 6 August, revised on 12 August.
A general assistant cites whichever copy it indexed. Citetax must resolve to
the revision in force on the date being asked about.

These run against the real database, so they need DATABASE_URL and a seeded
corpus. They create their own rule keys and clean up after themselves.
"""

from __future__ import annotations

import json
import uuid
from datetime import date

import pytest
from sqlalchemy import text

from app.db.session import db_conn
from app.rules.resolver import (
    AmbiguousRule,
    UnresolvedRule,
    current_snapshot,
    resolve,
    ya_end_date,
    ya_start_date,
)

YA = "2026/2027"


@pytest.fixture
def corpus():
    """Insert a throwaway rule with several effective windows, in the current
    snapshot, and remove it afterwards."""
    rule_key = f"test.midyear.{uuid.uuid4().hex[:8]}"
    created: list[str] = []

    with db_conn() as conn:
        snap = current_snapshot(conn)
        assert snap is not None, "seed the corpus first"
        snapshot_id = str(snap["id"])

        conn.execute(
            text(
                "insert into rule (rule_key, title, rule_type, unit, rounding_mode) "
                "values (:k, 'Test rule', 'amount', 'LKR', 'half_up')"
            ),
            {"k": rule_key},
        )

        def add_version(amount: str, eff_from: date, eff_to: date | None, rev: int):
            vid = str(uuid.uuid4())
            conn.execute(
                text(
                    "insert into rule_version (id, rule_key, revision_no, value_json, "
                    "effective_from, effective_to, status, citation_label) values "
                    "(:id, :k, :rev, cast(:v as jsonb), :ef, :et, 'published', :cite)"
                ),
                {
                    "id": vid, "k": rule_key, "rev": rev,
                    "v": json.dumps({"amount": amount}),
                    "ef": eff_from, "et": eff_to,
                    "cite": f"Circular rev {rev}",
                },
            )
            conn.execute(
                text(
                    "insert into snapshot_rule_version (snapshot_id, rule_version_id) "
                    "values (:s, :v)"
                ),
                {"s": snapshot_id, "v": vid},
            )
            created.append(vid)
            return vid

        conn.commit()
        yield {
            "rule_key": rule_key,
            "snapshot_id": snapshot_id,
            "add_version": add_version,
            "conn": conn,
        }

        conn.execute(
            text("delete from snapshot_rule_version where rule_version_id = any(:ids)"),
            {"ids": created},
        )
        conn.execute(text("delete from rule_version where rule_key = :k"), {"k": rule_key})
        conn.execute(text("delete from rule where rule_key = :k"), {"k": rule_key})
        conn.commit()


def test_year_start_default_picks_the_april_version(corpus):
    """With no as_of, resolution answers for the start of the year."""
    add, conn = corpus["add_version"], corpus["conn"]
    add("1000", date(2026, 4, 1), None, 1)
    conn.commit()

    rv = resolve(conn, corpus["rule_key"], YA, corpus["snapshot_id"])
    assert rv.value_json["amount"] == "1000"


def test_midyear_circular_supersedes_from_its_effective_date(corpus):
    """The August 2026 case. A circular effective 6 August changes the answer
    for August onwards, and must not change the answer for May."""
    add, conn = corpus["add_version"], corpus["conn"]
    add("1000", date(2026, 4, 1), date(2026, 8, 5), 1)
    add("1800", date(2026, 8, 6), None, 2)
    conn.commit()

    key, snap = corpus["rule_key"], corpus["snapshot_id"]

    # Before the circular
    assert resolve(conn, key, YA, snap, as_of=date(2026, 5, 1)).value_json["amount"] == "1000"
    # Day before it takes effect
    assert resolve(conn, key, YA, snap, as_of=date(2026, 8, 5)).value_json["amount"] == "1000"
    # The day it takes effect
    assert resolve(conn, key, YA, snap, as_of=date(2026, 8, 6)).value_json["amount"] == "1800"
    # Later in the year
    assert resolve(conn, key, YA, snap, as_of=date(2027, 1, 1)).value_json["amount"] == "1800"


def test_second_revision_within_the_same_week_wins(corpus):
    """6 August issued, 12 August revised. Asking about 20 August must get the
    12 August text, not whichever was indexed first."""
    add, conn = corpus["add_version"], corpus["conn"]
    add("1000", date(2026, 4, 1), date(2026, 8, 5), 1)
    add("1800", date(2026, 8, 6), date(2026, 8, 11), 2)
    add("2000", date(2026, 8, 12), None, 3)
    conn.commit()

    key, snap = corpus["rule_key"], corpus["snapshot_id"]
    rv = resolve(conn, key, YA, snap, as_of=date(2026, 8, 20))
    assert rv.value_json["amount"] == "2000"
    assert rv.citation_label == "Circular rev 3"

    # The superseded window is still reachable for a date inside it.
    assert resolve(conn, key, YA, snap, as_of=date(2026, 8, 8)).value_json["amount"] == "1800"


def test_as_of_is_clamped_to_the_year_of_assessment(corpus):
    """A date outside the year would silently answer about a different year."""
    add, conn = corpus["add_version"], corpus["conn"]
    add("1000", date(2026, 4, 1), None, 1)
    conn.commit()

    key, snap = corpus["rule_key"], corpus["snapshot_id"]
    # Well before the year starts: clamps up to 1 April 2026.
    assert resolve(conn, key, YA, snap, as_of=date(2020, 1, 1)).value_json["amount"] == "1000"
    # Well after it ends: clamps down to 31 March 2027.
    assert resolve(conn, key, YA, snap, as_of=date(2099, 1, 1)).value_json["amount"] == "1000"


def test_gap_in_coverage_refuses(corpus):
    """A date no version covers must refuse, not fall back to a nearby one."""
    add, conn = corpus["add_version"], corpus["conn"]
    add("1000", date(2026, 4, 1), date(2026, 6, 30), 1)
    add("1800", date(2026, 9, 1), None, 2)
    conn.commit()

    key, snap = corpus["rule_key"], corpus["snapshot_id"]
    with pytest.raises(UnresolvedRule):
        resolve(conn, key, YA, snap, as_of=date(2026, 7, 15))


def test_overlapping_identical_windows_raise_the_integrity_alarm(corpus):
    """Two versions with the same effective_from and revision_no should be
    impossible, so it is monitored rather than silently resolved."""
    add, conn = corpus["add_version"], corpus["conn"]
    add("1000", date(2026, 4, 1), None, 1)
    add("9999", date(2026, 4, 1), None, 1)
    conn.commit()

    with pytest.raises(AmbiguousRule):
        resolve(conn, corpus["rule_key"], YA, corpus["snapshot_id"])


def test_ya_boundaries():
    assert ya_start_date("2026/2027") == date(2026, 4, 1)
    assert ya_end_date("2026/2027") == date(2027, 3, 31)


def test_seeded_rules_resolve_for_both_years():
    """The real corpus: one open-ended version serves both supported years."""
    with db_conn() as conn:
        snap = current_snapshot(conn)
        assert snap is not None
        for ya in ("2025/2026", "2026/2027"):
            rv = resolve(conn, "band.progressive", ya, str(snap["id"]))
            assert len(rv.value_json["bands"]) == 5
            rv = resolve(conn, "relief.personal", ya, str(snap["id"]))
            assert rv.value_json["amount"] == "1800000"
