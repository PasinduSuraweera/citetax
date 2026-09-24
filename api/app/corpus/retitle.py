"""Re-title documents the watcher stored before titles were cleaned.

    .venv\\Scripts\\python.exe -m app.corpus.retitle           # show changes
    .venv\\Scripts\\python.exe -m app.corpus.retitle --apply   # write them

The page HTML is not kept, so this works from what is: the stored title, then
the first line of the stored text, then the URL's host. Uploads keep the title
their reviewer typed.
"""

from __future__ import annotations

import sys

from sqlalchemy import text

from app.corpus.titles import clean_title, page_on
from app.db.session import db_conn


def main(apply: bool) -> int:
    with db_conn() as conn:
        rows = conn.execute(
            text(
                "select id, url, title, raw_text from source_document "
                " where url not like 'upload://%'"
            )
        ).mappings().all()

        changes = []
        for r in rows:
            first_line = (r["raw_text"] or "").strip().split("\n", 1)[0]
            new = (
                clean_title(r["title"], r["url"])
                or (clean_title(first_line, r["url"]) if len(first_line) <= 160 else None)
                or page_on(r["url"])
            )
            # The old watcher cut titles at 120 characters, site name included.
            # Mark the ones that were cut mid-title, not ones that only ran
            # long because script text followed the title.
            old = (r["title"] or "").rstrip()
            if len(old) >= 120 and old.endswith(new) and not new.endswith("…"):
                new += "…"
            if new != r["title"]:
                changes.append((r["id"], r["title"], new))

        for _, old, new in changes:
            print(f"  {old!r:70.70}  ->  {new!r}")
        print(f"\n{len(changes)} of {len(rows)} titles {'updated' if apply else 'would change'}")

        if apply and changes:
            for doc_id, _, new in changes:
                conn.execute(
                    text("update source_document set title = :t where id = :id"),
                    {"t": new, "id": doc_id},
                )
            conn.commit()
    return 0


if __name__ == "__main__":
    raise SystemExit(main(apply="--apply" in sys.argv))
