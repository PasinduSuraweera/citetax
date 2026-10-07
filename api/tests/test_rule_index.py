"""Rule text in the retrieval index must follow the current snapshot (#45).

Retrieval quotes rule text to the model. If the index still holds the text a
publish replaced, the answer quotes superseded law. These tests run against a
fake connection that answers the indexer's reads and records every statement:
no database and no network.
"""

from __future__ import annotations

from contextlib import contextmanager

from app.corpus import scheduler
from app.retrieval import embeddings, indexer
from app.retrieval.indexer import IndexReport
from app.routers import admin


class _Rows:
    def __init__(self, rows):
        self._rows = rows

    def mappings(self):
        return self

    def all(self):
        return self._rows


class FakeConn:
    """`snapshot` is what the current snapshot holds; `chunks` is what the
    index holds, as (rule_key, text, has_embedding)."""

    def __init__(self, snapshot=(), chunks=()):
        self.snapshot = list(snapshot)
        self.chunks = list(chunks)
        self.sql: list[str] = []
        self.params: list = []
        self.rolled_back = False

    def execute(self, stmt, params=None):
        sql = " ".join(str(stmt).split()).lower()
        self.sql.append(sql)
        self.params.append(params)
        if sql.startswith("select rv.rule_key"):
            return _Rows(self.snapshot)
        if sql.startswith("select rule_key, text"):
            return _Rows(self.chunks)
        return _Rows([])

    def commit(self):
        pass

    def rollback(self):
        self.rolled_back = True

    def inserted_texts(self) -> list[str]:
        return [p["t"] for s, p in zip(self.sql, self.params)
                if s.startswith("insert into chunk")]


def _version(key, quote, label=None):
    return {"rule_key": key, "quoted_text": quote, "citation_label": label}


NEW = _version("relief.personal", "Personal relief is 1,800,000.", "s.52")
OLD_TEXT = "s.52: Personal relief is 1,200,000."
NEW_TEXT = "s.52: Personal relief is 1,800,000."


def test_index_reads_the_current_snapshot_not_the_published_status():
    conn = FakeConn(snapshot=[NEW])

    indexer.index_rule_versions(conn)

    read = conn.sql[0]
    assert "corpus_snapshot" in read and "is_current" in read
    assert "status" not in read
    assert conn.inserted_texts() == [NEW_TEXT]


def test_identical_texts_are_indexed_once():
    # Two versions of one rule for different years can quote the same law.
    conn = FakeConn(snapshot=[NEW, dict(NEW)])

    report = indexer.index_rule_versions(conn)

    assert conn.inserted_texts() == [NEW_TEXT]
    assert report.rule_versions == 1


def test_index_matching_the_snapshot_is_not_stale(monkeypatch):
    monkeypatch.setattr(embeddings, "dense_enabled", lambda: False)
    conn = FakeConn(snapshot=[NEW], chunks=[("relief.personal", NEW_TEXT, False)])

    assert indexer.rule_index_is_stale(conn) is False


def test_superseded_text_still_indexed_is_stale(monkeypatch):
    monkeypatch.setattr(embeddings, "dense_enabled", lambda: False)
    conn = FakeConn(snapshot=[NEW], chunks=[("relief.personal", OLD_TEXT, False)])

    assert indexer.rule_index_is_stale(conn) is True


def test_current_text_missing_from_the_index_is_stale(monkeypatch):
    # The shared database's state when this was found: a publish added a
    # rule version and the index never learned of it.
    monkeypatch.setattr(embeddings, "dense_enabled", lambda: False)
    apit = _version("credit.apit", "APIT deducted is a credit.")
    conn = FakeConn(snapshot=[NEW, apit], chunks=[("relief.personal", NEW_TEXT, False)])

    assert indexer.rule_index_is_stale(conn) is True


def test_missing_embedding_is_stale_only_with_dense_retrieval_on(monkeypatch):
    conn = FakeConn(snapshot=[NEW], chunks=[("relief.personal", NEW_TEXT, False)])

    monkeypatch.setattr(embeddings, "dense_enabled", lambda: True)
    assert indexer.rule_index_is_stale(conn) is True

    monkeypatch.setattr(embeddings, "dense_enabled", lambda: False)
    assert indexer.rule_index_is_stale(conn) is False


def test_reindex_failure_does_not_undo_a_publish(monkeypatch):
    def boom(conn):
        raise RuntimeError("embedding service down")

    monkeypatch.setattr(indexer, "index_rule_versions", boom)
    conn = FakeConn()

    result = admin._reindex_rule_text(conn)

    assert result["ok"] is False
    assert "embedding service down" in result["errors"][0]
    assert conn.rolled_back


def test_reindex_reports_what_it_wrote(monkeypatch):
    monkeypatch.setattr(
        indexer, "index_rule_versions", lambda conn: IndexReport(chunks_written=11)
    )

    assert admin._reindex_rule_text(FakeConn()) == {"ok": True, "chunks": 11, "errors": []}


def _run_cycle(monkeypatch, stale: bool) -> list[str]:
    calls: list[str] = []

    @contextmanager
    def fake_db():
        yield FakeConn()

    monkeypatch.setattr(scheduler, "db_conn", fake_db)
    monkeypatch.setattr(scheduler.watcher, "watch_all", lambda conn: [])
    monkeypatch.setattr(scheduler.extractor, "extract_pending", lambda conn, **kw: [])
    monkeypatch.setattr(indexer, "rule_index_is_stale", lambda conn: stale)
    monkeypatch.setattr(
        indexer, "index_rule_versions",
        lambda conn: calls.append("rules") or IndexReport(chunks_written=11),
    )
    monkeypatch.setattr(
        indexer, "index_unindexed_documents", lambda conn, limit: IndexReport()
    )
    report = scheduler.run_cycle(trigger="test")
    assert report.errors == []
    return calls


def test_agent_cycle_reindexes_rule_text_when_stale(monkeypatch):
    assert _run_cycle(monkeypatch, stale=True) == ["rules"]


def test_agent_cycle_leaves_a_current_index_alone(monkeypatch):
    # Rule chunks existing is no longer the test: whether they are current is.
    assert _run_cycle(monkeypatch, stale=False) == []
