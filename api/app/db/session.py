"""Database access. Supabase Postgres 16 + pgvector.

citetax-api should be granted SELECT only, and only on the published-only views
(spec §2.3), so it is structurally incapable of serving an unreviewed rule.
"""

from __future__ import annotations

from contextlib import contextmanager
from typing import Iterator

from sqlalchemy import create_engine, text
from sqlalchemy.engine import Connection, Engine

from app.core.config import get_settings

_engine: Engine | None = None


def get_engine() -> Engine:
    global _engine
    if _engine is None:
        settings = get_settings()
        if not settings.database_url:
            raise RuntimeError(
                "DATABASE_URL is not set. Copy .env.example to .env and paste your "
                "Supabase connection string."
            )
        _engine = create_engine(
            settings.database_url,
            pool_size=5,
            max_overflow=5,
            pool_pre_ping=True,   # Supabase drops idle connections
            pool_recycle=300,
        )
    return _engine


@contextmanager
def db_conn() -> Iterator[Connection]:
    with get_engine().connect() as conn:
        yield conn


def db_healthy() -> tuple[bool, str]:
    """Used by /health so a misconfigured database is visible immediately
    rather than as a 500 on the first question."""
    try:
        with db_conn() as conn:
            conn.execute(text("select 1"))
        return True, "ok"
    except Exception as exc:  # noqa: BLE001 — surfaced to an operator, not a user
        return False, str(exc)[:200]
