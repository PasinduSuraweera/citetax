"""Apply SQL migrations in db/migrations, in filename order, once each.

    .venv\\Scripts\\python.exe migrate.py

Idempotent: a migration that has already run is skipped. Each file runs in one
transaction, so a failure leaves nothing half applied.
"""

from __future__ import annotations

import hashlib
import sys
from pathlib import Path

sys.path.insert(0, ".")

from sqlalchemy import create_engine, text  # noqa: E402

from app.core.config import get_settings  # noqa: E402

MIGRATIONS = Path(__file__).resolve().parent.parent / "db" / "migrations"

_LEDGER = text(
    """
    create table if not exists schema_migration (
      filename   text primary key,
      sha256     text not null,
      applied_at timestamptz not null default now()
    )
    """
)


def main() -> int:
    settings = get_settings()
    if not settings.database_url:
        print("DATABASE_URL is not set")
        return 1

    engine = create_engine(settings.database_url)
    files = sorted(MIGRATIONS.glob("*.sql"))
    if not files:
        print(f"no migrations found in {MIGRATIONS}")
        return 1

    with engine.connect() as conn:
        conn.execute(_LEDGER)
        conn.commit()

        applied = {
            row[0]: row[1]
            for row in conn.execute(
                text("select filename, sha256 from schema_migration")
            ).all()
        }

    for path in files:
        sql = path.read_text(encoding="utf-8")
        digest = hashlib.sha256(sql.encode()).hexdigest()

        if path.name in applied:
            if applied[path.name] != digest:
                print(
                    f"  WARN  {path.name} already applied but its contents changed. "
                    "Add a new migration rather than editing an applied one."
                )
            else:
                print(f"  skip  {path.name}")
            continue

        print(f"  apply {path.name} ...", end=" ", flush=True)
        try:
            with engine.begin() as conn:
                conn.execute(text(sql))
                conn.execute(
                    text(
                        "insert into schema_migration (filename, sha256) "
                        "values (:f, :s)"
                    ),
                    {"f": path.name, "s": digest},
                )
            print("ok")
        except Exception as exc:  # noqa: BLE001
            print("FAILED")
            print(f"\n{str(exc)[:1200]}")
            return 1

    print("\nmigrations up to date")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
