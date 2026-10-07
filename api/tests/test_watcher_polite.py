"""The watcher obeys robots.txt, spaces out requests, and asks before
refetching (#54). The site is a mock; nothing leaves the machine."""

from __future__ import annotations

import time
import uuid

import httpx
import pytest
from sqlalchemy import text

from app.corpus import watcher
from app.db.session import db_conn

PAGE = (
    "<html><body><article><h1>Notice {n}</h1>"
    "<p>The Inland Revenue Department explains how returns are submitted online "
    "through RAMIS and which records a taxpayer should keep for the year.</p>"
    "<p>Reference {n}.</p></article></body></html>"
)


@pytest.fixture
def site(monkeypatch):
    """A fake host with a robots.txt that disallows /private/. Records every
    request, and answers 304 when the client sends the page's ETag back."""
    host = f"polite-{uuid.uuid4().hex[:8]}.example"
    base = f"https://{host}"
    requests: list[tuple[float, str, dict]] = []
    etag = '"v1"'

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append((time.monotonic(), request.url.path, dict(request.headers)))
        path = request.url.path
        if path == "/robots.txt":
            return httpx.Response(200, text="User-agent: *\nDisallow: /private/\n")
        if path == "/notices":
            return httpx.Response(200, text=(
                f'<a href="{base}/notice/public-1">a</a> <a href="{base}/private/notice/secret-2">b</a>'
            ), headers={"content-type": "text/html"})
        if path == "/notice/public-1":
            if request.headers.get("if-none-match") == etag:
                return httpx.Response(304)
            return httpx.Response(200, text=PAGE.format(n=host), headers={"content-type": "text/html", "etag": etag})
        return httpx.Response(404)

    monkeypatch.setattr(watcher, "_transport", httpx.MockTransport(handler))
    monkeypatch.setattr(watcher, "POLITE_DELAY", 0.2)
    source_id = f"test-{host}"
    with db_conn() as conn:
        conn.execute(text(
            "insert into source (source_id, name, index_url, discovery, doc_type, priority, enabled) "
            "values (:s, 'Polite test', :u, 'html_list', 'circular', 'low', true)"
        ), {"s": source_id, "u": f"{base}/notices"})
        conn.commit()
    yield source_id, base, requests
    with db_conn() as conn:
        docs = conn.execute(text("select id from source_document where source_id = :s"), {"s": source_id}).scalars().all()
        conn.execute(text("delete from change_proposal where source_document_id = any(:d)"), {"d": docs})
        conn.execute(text("delete from chunk where source_document_id = any(:d)"), {"d": docs})
        conn.execute(text("delete from source_document where source_id = :s"), {"s": source_id})
        conn.execute(text("delete from crawl_run where source_id = :s"), {"s": source_id})
        conn.execute(text("delete from source where source_id = :s"), {"s": source_id})
        conn.commit()


def test_a_disallowed_page_is_skipped_and_recorded(site):
    source_id, base, requests = site
    with db_conn() as conn:
        result = watcher.watch_source(conn, source_id)
        skipped = conn.execute(
            text("select skipped_json from crawl_run where source_id = :s order by started_at desc limit 1"),
            {"s": source_id},
        ).scalar()
    paths = [p for _, p, _ in requests]
    assert "/private/notice/secret-2" not in paths, "fetched a page robots.txt disallows"
    assert skipped == {"robots": [f"{base}/private/notice/secret-2"]}
    assert result.new_documents == 1


def test_requests_to_one_host_are_spaced_out(site):
    source_id, _, requests = site
    with db_conn() as conn:
        watcher.watch_source(conn, source_id)
    times = [t for t, _, _ in requests]
    gaps = [b - a for a, b in zip(times, times[1:])]
    assert gaps and min(gaps) >= 0.19, gaps


def test_an_unchanged_page_is_asked_for_conditionally(site):
    source_id, _, requests = site
    with db_conn() as conn:
        first = watcher.watch_source(conn, source_id)
        requests.clear()
        second = watcher.watch_source(conn, source_id)
    sent = next(h for _, p, h in requests if p == "/notice/public-1")
    assert sent.get("if-none-match") == '"v1"'
    assert (first.new_documents, second.new_documents, second.revisions, second.unchanged) == (1, 0, 0, 1)
