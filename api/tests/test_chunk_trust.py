"""Passages carry their trust and their year (#44)."""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import text

from app.core import years
from app.db.session import db_conn
from app.retrieval import search


def test_years_a_text_names_are_found():
    assert years.mentioned("Changes for Y/A 2025/26 and 2026/2027, from 2024") == ["2025/2026", "2026/2027"]
    assert years.mentioned("Rs. 1,200,000 in 2024 and 2025") == []
    assert years.mentioned("2026/2028 is not a year") == []


@pytest.mark.db
def test_a_year_specific_passage_is_not_retrieved_for_another_year():
    word = f"zqx{uuid.uuid4().hex[:8]}"
    doc = str(uuid.uuid4())
    with db_conn() as conn:
        conn.execute(text(
            "insert into source_document (id, family_id, source_id, url, sha256, doc_type, title, raw_text) "
            "values (:d, :d, 'manual-upload', :u, :h, 'circular', 'year test', 'x')"
        ), {"d": doc, "u": f"https://example.invalid/{doc}", "h": uuid.uuid4().hex})
        chunk = str(uuid.uuid4())
        conn.execute(text(
            "insert into chunk (id, source_document_id, text, status, trust, applies_to_ya) "
            "values (:c, :d, :t, 'published', 'secondary', array['2024/2025'])"
        ), {"c": chunk, "d": doc, "t": f"The {word} relief for Y/A 2024/2025 was different."})
        conn.commit()
        try:
            other_year, _ = search.search(conn, word, ya="2026/2027")
            any_year, _ = search.search(conn, word)
            assert chunk not in [p.chunk_id for p in other_year]
            mine = [p for p in any_year if p.chunk_id == chunk]
            assert [p.trust for p in mine] == ["secondary"]
        finally:
            conn.execute(text("delete from chunk where source_document_id = :d"), {"d": doc})
            conn.execute(text("delete from source_document where id = :d"), {"d": doc})
            conn.commit()
