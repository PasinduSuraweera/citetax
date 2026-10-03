"""The rules seed must never destroy history (issue #41).

The database is shared, so a reseed that cleared saved answers, conversations
or published rule versions would wipe every teammate's work. These tests run
seed() against a fake connection that records each statement: no database and
no network.
"""

from __future__ import annotations

from seed.rules_seed import DEADLINE_VERSIONS, SHARED_VERSIONS, SNAPSHOT_LABEL, seed


class _Result:
    def __init__(self, scalar=None, row=None):
        self._scalar = scalar
        self._row = row

    def scalar_one(self):
        return self._scalar

    def mappings(self):
        return self

    def first(self):
        return self._row


class FakeConn:
    """Answers the two reads seed() makes and records every statement."""

    def __init__(self, snapshots: int, current: dict | None = None):
        self.snapshots = snapshots
        self.current = current
        self.sql: list[str] = []

    def execute(self, stmt, params=None):
        sql = " ".join(str(stmt).split()).lower()
        self.sql.append(sql)
        if sql.startswith("select count(*) from corpus_snapshot"):
            return _Result(scalar=self.snapshots)
        if sql.startswith("select s.label"):
            return _Result(row=self.current)
        return _Result()

    def writes(self) -> list[str]:
        return [s for s in self.sql if not s.startswith("select")]


def _destructive(sql: list[str]) -> list[str]:
    return [s for s in sql if s.startswith(("delete", "truncate", "drop"))]


def test_populated_corpus_is_left_untouched():
    conn = FakeConn(snapshots=3, current={"label": "1 October 2026", "versions": 11})

    result = seed(conn)

    assert result == {"seeded": False, "label": "1 October 2026", "versions": 11}
    assert conn.writes() == []


def test_snapshots_without_a_current_one_are_still_left_untouched():
    # A corpus mid-rollback has history worth keeping even with no current row.
    conn = FakeConn(snapshots=2, current=None)

    result = seed(conn)

    assert result["seeded"] is False
    assert conn.writes() == []


def test_empty_database_gets_one_snapshot_of_every_seed_version():
    conn = FakeConn(snapshots=0)

    result = seed(conn)

    expected = len(SHARED_VERSIONS) + len(DEADLINE_VERSIONS)
    assert result["seeded"] is True
    assert result["versions"] == expected
    assert result["label"] == SNAPSHOT_LABEL

    def count(prefix: str) -> int:
        return sum(s.startswith(prefix) for s in conn.sql)

    assert count("insert into rule_version") == expected
    assert count("insert into corpus_snapshot") == 1
    assert count("insert into snapshot_rule_version") == expected


def test_seed_never_deletes_on_either_path():
    for conn in (FakeConn(snapshots=0), FakeConn(snapshots=1, current=None)):
        seed(conn)
        assert _destructive(conn.sql) == []
        assert not any(s.startswith("update") for s in conn.sql)


def test_seed_takes_the_lock_before_checking_for_a_corpus():
    conn = FakeConn(snapshots=0)

    seed(conn)

    assert "pg_advisory_xact_lock" in conn.sql[0]
    assert conn.sql[1].startswith("select count(*) from corpus_snapshot")
