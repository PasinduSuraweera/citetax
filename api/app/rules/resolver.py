"""Deterministic rule resolution — spec §3.6. No LLM anywhere in this file.

Silence is a valid answer; a guess is not.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from typing import Any

from sqlalchemy import text
from sqlalchemy.engine import Connection


class UnresolvedRule(Exception):
    """Zero candidates survived. The answer is refused, not guessed."""

    def __init__(self, rule_key: str, ya: str):
        self.rule_key = rule_key
        self.ya = ya
        super().__init__(f"no rule in force found for {rule_key} in YA {ya}")


class AmbiguousRule(Exception):
    """More than one candidate survived. This should be impossible, so it is
    a data-integrity alarm that blocks the answer (spec §3.6)."""

    def __init__(self, rule_key: str, ya: str, n: int):
        self.rule_key = rule_key
        self.ya = ya
        self.n = n
        super().__init__(
            f"{n} rule versions in force for {rule_key} in YA {ya} — corpus integrity alarm"
        )


@dataclass(frozen=True)
class RuleVersion:
    id: str
    rule_key: str
    revision_no: int
    value_json: dict[str, Any]
    effective_from: date
    effective_to: date | None
    citation_label: str | None
    quoted_text: str | None
    rounding_mode: str = "half_up"
    supersedes_version_id: str | None = None
    source_document_id: str | None = None


@dataclass
class ResolvedRuleSet:
    """The rules a single computation was resolved against, plus the snapshot
    and the as-of date they were resolved at. Stored on the run so any answer
    is reproducible."""

    ya: str
    snapshot_id: str
    as_of: date | None = None
    rules: dict[str, RuleVersion] = field(default_factory=dict)

    def __getitem__(self, rule_key: str) -> RuleVersion:
        if rule_key not in self.rules:
            raise UnresolvedRule(rule_key, self.ya)
        return self.rules[rule_key]

    def get(self, rule_key: str) -> RuleVersion | None:
        return self.rules.get(rule_key)

    @property
    def version_ids(self) -> list[str]:
        return [r.id for r in self.rules.values()]


def ya_start_date(ya: str) -> date:
    """Sri Lankan year of assessment runs 1 April to 31 March.
    '2026/2027' starts 1 April 2026."""
    start_year = int(ya.split("/")[0])
    return date(start_year, 4, 1)


def ya_end_date(ya: str) -> date:
    end_year = int(ya.split("/")[1])
    return date(end_year, 3, 31)


_RESOLVE_SQL = text(
    """
    select rv.id, rv.rule_key, rv.revision_no, rv.value_json,
           rv.effective_from, rv.effective_to, rv.citation_label,
           rv.quoted_text, rv.supersedes_version_id, rv.source_document_id,
           coalesce(r.rounding_mode, 'half_up') as rounding_mode
      from rule_version rv
      join snapshot_rule_version srv on srv.rule_version_id = rv.id
      left join rule r on r.rule_key = rv.rule_key
     where rv.rule_key = :rule_key
       and srv.snapshot_id = :snapshot_id
       and rv.status = 'published'
       and rv.effective_from <= :as_of
       and (rv.effective_to is null or rv.effective_to >= :as_of)
     order by rv.effective_from desc, rv.revision_no desc
    """
)


def resolve(
    conn: Connection,
    rule_key: str,
    ya: str,
    snapshot_id: str,
    as_of: date | None = None,
) -> RuleVersion:
    """Pick the single rule version that governs `rule_key` for `ya`,
    as the corpus stood at `snapshot_id`.

    `as_of` is the date the rule must be in force on. It defaults to the first
    day of the year of assessment, which is right for annual figures like the
    band table and personal relief. A circular that takes effect mid-year, the
    August 2026 case this product exists for, is reached by passing that date:
    the same rule key then resolves to a different version depending on when
    the transaction happened.

    `as_of` is clamped to the year of assessment. Asking for a date outside the
    year would silently answer about a different year, which is exactly the
    confusion the year filter exists to prevent.

    Raises UnresolvedRule if zero survive, AmbiguousRule if more than one does.
    """
    when = as_of or ya_start_date(ya)
    lo, hi = ya_start_date(ya), ya_end_date(ya)
    when = min(max(when, lo), hi)

    rows = conn.execute(
        _RESOLVE_SQL,
        {"rule_key": rule_key, "snapshot_id": snapshot_id, "as_of": when},
    ).mappings().all()

    if not rows:
        raise UnresolvedRule(rule_key, ya)

    # The most recent effective_from wins: a circular issued in August
    # supersedes the position that stood in April. Two versions sharing both
    # effective_from and revision_no is a genuine ambiguity and an alarm.
    top = (rows[0]["effective_from"], rows[0]["revision_no"])
    contenders = [
        r for r in rows if (r["effective_from"], r["revision_no"]) == top
    ]
    if len(contenders) > 1:
        raise AmbiguousRule(rule_key, ya, len(contenders))

    row = contenders[0]
    return RuleVersion(
        id=str(row["id"]),
        rule_key=row["rule_key"],
        revision_no=row["revision_no"],
        value_json=row["value_json"],
        effective_from=row["effective_from"],
        effective_to=row["effective_to"],
        citation_label=row["citation_label"],
        quoted_text=row["quoted_text"],
        rounding_mode=row["rounding_mode"],
        supersedes_version_id=(
            str(row["supersedes_version_id"]) if row["supersedes_version_id"] else None
        ),
        source_document_id=(
            str(row["source_document_id"]) if row["source_document_id"] else None
        ),
    )


def resolve_many(
    conn: Connection,
    rule_keys: list[str],
    ya: str,
    snapshot_id: str,
    as_of: date | None = None,
    optional: list[str] | tuple[str, ...] = (),
) -> ResolvedRuleSet:
    """Resolve every rule a computation will need, up front (graph node 4).

    Resolving all of them before computing means an UnresolvedRule surfaces as
    a clean refusal rather than a half-finished ledger. `optional` keys are
    resolved when a version is in force and left out when not: a treatment
    that only some taxpayers need (#48) must not stop everyone's answer
    before its rule is signed and published.
    """
    out = ResolvedRuleSet(ya=ya, snapshot_id=snapshot_id, as_of=as_of)
    for key in rule_keys:
        out.rules[key] = resolve(conn, key, ya, snapshot_id, as_of)
    for key in optional:
        if key in out.rules:
            continue
        try:
            out.rules[key] = resolve(conn, key, ya, snapshot_id, as_of)
        except UnresolvedRule:
            pass
    return out


def current_snapshot(conn: Connection) -> dict[str, Any] | None:
    row = conn.execute(
        text(
            "select id, label, created_at, changelog from corpus_snapshot "
            "where is_current limit 1"
        )
    ).mappings().first()
    return dict(row) if row else None
