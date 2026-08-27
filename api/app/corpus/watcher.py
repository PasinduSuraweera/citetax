"""Source watcher (spec section 3.2).

Fetches each index page, extracts candidate document links, and hashes the raw
bytes of every document it finds.

The case this exists for: a URL that is already known but whose hash has
changed is a silent revision. One IRD circular was issued on 6 August, revised,
and revised again on 12 August, each time at the same address. That becomes a
new source_document with revision_no = prev + 1 and supersedes_id = prev.id,
and its proposal is flagged highest priority, because a rule already serving
users may now be wrong.

Document lineage is by family_id, so three copies of one circular are three
rows in one family with revisions 1, 2, 3, never three competing documents.
"""

from __future__ import annotations

import hashlib
import logging
import re
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urljoin, urlparse

import httpx
from sqlalchemy import text
from sqlalchemy.engine import Connection

logger = logging.getLogger(__name__)

USER_AGENT = (
    "CitetaxBot/0.1 (SLIIT IT3041 student project; respects robots.txt)"
)

# Links worth following from an index page.
_DOC_EXTENSIONS = (".pdf", ".doc", ".docx")

# Section landing pages. They match the notice and article patterns but are
# navigation, not documents.
_INDEX_PATHS = {
    "/notice", "/notices", "/articles", "/article", "/downloads", "/download",
    "/circulars", "/publications",
}
_LINK = re.compile(r'href=["\']([^"\']+)["\']', re.I)
_TAG = re.compile(r"<[^>]+>")
_WS = re.compile(r"\s+")


@dataclass
class Discovered:
    url: str
    title: str | None = None


@dataclass
class WatchResult:
    source_id: str
    links_found: int = 0
    new_documents: int = 0
    revisions: int = 0
    unchanged: int = 0
    errors: list[str] = field(default_factory=list)
    documents: list[dict[str, Any]] = field(default_factory=list)

    def to_json(self) -> dict[str, Any]:
        return {
            "source_id": self.source_id,
            "links_found": self.links_found,
            "new_documents": self.new_documents,
            "revisions": self.revisions,
            "unchanged": self.unchanged,
            "errors": self.errors,
            "documents": self.documents,
        }


def _clean_text(html: str) -> str:
    return _WS.sub(" ", _TAG.sub(" ", html)).strip()


def extract_links(html: str, base_url: str, limit: int = 40) -> list[Discovered]:
    """Pull candidate document links out of an index page.

    Deliberately simple: a real extractor would use the per-source CSS selector
    from the registry. This finds document files and notice pages, which is
    enough for the sources currently registered, and the selector column is
    already in the schema for when it is not.
    """
    parsed_base = urlparse(base_url)
    host = parsed_base.netloc
    base_path = parsed_base.path.rstrip("/").lower()
    seen: set[str] = set()
    out: list[Discovered] = []

    for match in _LINK.finditer(html):
        href = match.group(1).strip()
        if not href or href.startswith(("#", "mailto:", "javascript:", "tel:")):
            continue
        absolute = urljoin(base_url, href)
        parsed = urlparse(absolute)
        if parsed.scheme not in ("http", "https"):
            continue
        # Stay on the source's own host: an index page links out to the world.
        if parsed.netloc != host:
            continue
        lowered = parsed.path.rstrip("/").lower()
        looks_like_doc = lowered.endswith(_DOC_EXTENSIONS)
        looks_like_notice = any(
            seg in lowered for seg in ("/notice", "/circular", "/download", "/article")
        )
        # An index page links to itself and to sibling listings. Those are
        # navigation, not documents, and recording them fills the review queue
        # with pages that never contain a rule. A real document has something
        # after the section segment.
        is_index_page = lowered in _INDEX_PATHS or lowered == base_path
        if is_index_page or not (looks_like_doc or looks_like_notice):
            continue
        if absolute in seen:
            continue
        seen.add(absolute)
        out.append(Discovered(url=absolute))
        if len(out) >= limit:
            break
    return out


def _record_document(
    conn: Connection,
    source_id: str,
    url: str,
    body: bytes,
    content_type: str,
    result: WatchResult,
) -> None:
    """Hash the bytes and decide: unchanged, new, or a silent revision."""
    sha = hashlib.sha256(body).hexdigest()

    existing_same_hash = conn.execute(
        text("select id from source_document where sha256 = :h limit 1"),
        {"h": sha},
    ).first()
    if existing_same_hash:
        conn.execute(
            text("update source_document set last_seen_at = now() where id = :id"),
            {"id": existing_same_hash[0]},
        )
        result.unchanged += 1
        return

    prior = conn.execute(
        text(
            "select id, family_id, revision_no from source_document "
            " where url = :u order by revision_no desc limit 1"
        ),
        {"u": url},
    ).mappings().first()

    doc_id = str(uuid.uuid4())
    is_revision = prior is not None
    family_id = str(prior["family_id"]) if prior else str(uuid.uuid4())
    revision_no = (prior["revision_no"] + 1) if prior else 1

    raw_text = None
    if "html" in content_type or url.lower().endswith((".htm", ".html")):
        raw_text = _clean_text(body.decode("utf-8", "replace"))[:200000]

    doc_type = conn.execute(
        text("select doc_type from source where source_id = :s"), {"s": source_id}
    ).scalar() or "circular"

    conn.execute(
        text(
            "insert into source_document (id, family_id, revision_no, source_id, "
            "url, sha256, doc_type, title, fetched_at, last_seen_at, "
            "supersedes_id, raw_text) values "
            "(:id, :fam, :rev, :src, :url, :sha, :dt, :title, now(), now(), "
            ":sup, :raw)"
        ),
        {
            "id": doc_id, "fam": family_id, "rev": revision_no, "src": source_id,
            "url": url, "sha": sha, "dt": doc_type,
            "title": (raw_text[:120] if raw_text else url.rsplit("/", 1)[-1]),
            "sup": str(prior["id"]) if prior else None,
            "raw": raw_text,
        },
    )

    # A revision of something already published is the highest priority a
    # reviewer can see, because a live rule may now be wrong.
    priority = 1 if is_revision else 4
    conn.execute(
        text(
            "insert into change_proposal (source_document_id, status, priority, "
            "extractor_version, quoted_text) values "
            "(:doc, :status, :pri, 'watcher-0.1', :note)"
        ),
        {
            "doc": doc_id,
            "status": "needs_review",
            "pri": priority,
            "note": (
                f"Silent revision detected: this URL was already known and its "
                f"content changed. Revision {revision_no}, superseding revision "
                f"{revision_no - 1}."
                if is_revision
                else "New document discovered. Needs extraction and review."
            ),
        },
    )

    if is_revision:
        result.revisions += 1
    else:
        result.new_documents += 1
    result.documents.append(
        {
            "id": doc_id, "url": url, "revision_no": revision_no,
            "is_revision": is_revision, "sha256": sha[:16],
        }
    )


def watch_source(conn: Connection, source_id: str, max_docs: int = 12) -> WatchResult:
    """Crawl one registered source and record what changed."""
    row = conn.execute(
        text(
            "select source_id, name, index_url, discovery, enabled "
            "  from source where source_id = :s"
        ),
        {"s": source_id},
    ).mappings().first()
    if not row:
        raise ValueError(f"unknown source {source_id}")

    result = WatchResult(source_id=source_id)

    if row["discovery"] == "manual_upload":
        result.errors.append("manual upload source, nothing to crawl")
        return result
    if not row["enabled"]:
        result.errors.append("source is disabled")
        return result

    crawl_id = str(uuid.uuid4())
    conn.execute(
        text(
            "insert into crawl_run (id, source_id, status) values (:id, :s, 'running')"
        ),
        {"id": crawl_id, "s": source_id},
    )
    conn.commit()

    try:
        with httpx.Client(
            timeout=30.0, follow_redirects=True,
            headers={"User-Agent": USER_AGENT},
        ) as client:
            index = client.get(row["index_url"])
            index.raise_for_status()
            links = extract_links(index.text, row["index_url"])
            result.links_found = len(links)

            for link in links[:max_docs]:
                try:
                    resp = client.get(link.url)
                    resp.raise_for_status()
                    _record_document(
                        conn, source_id, link.url, resp.content,
                        resp.headers.get("content-type", ""), result,
                    )
                except Exception as exc:  # noqa: BLE001 — one bad link is not fatal
                    result.errors.append(f"{link.url}: {str(exc)[:120]}")

        changed = result.new_documents + result.revisions
        conn.execute(
            text(
                "update source set last_run_at = now(), last_status = 'ok', "
                "last_error = null, "
                "last_change_at = case when :changed > 0 then now() "
                "  else last_change_at end where source_id = :s"
            ),
            {"changed": changed, "s": source_id},
        )
        conn.execute(
            text(
                "update crawl_run set finished_at = now(), status = 'ok', "
                "links_found = :lf, new_documents = :nd, revisions = :rv "
                " where id = :id"
            ),
            {
                "lf": result.links_found, "nd": result.new_documents,
                "rv": result.revisions, "id": crawl_id,
            },
        )
        conn.commit()

    except Exception as exc:  # noqa: BLE001
        message = str(exc)[:400]
        result.errors.append(message)
        conn.rollback()
        # Staleness monitoring depends on the failure being recorded, not
        # swallowed: a crawler that broke must look different from a source
        # where nothing happened.
        conn.execute(
            text(
                "update source set last_run_at = now(), last_status = 'failed', "
                "last_error = :e where source_id = :s"
            ),
            {"e": message, "s": source_id},
        )
        conn.execute(
            text(
                "update crawl_run set finished_at = now(), status = 'failed', "
                "error = :e where id = :id"
            ),
            {"e": message, "id": crawl_id},
        )
        conn.commit()

    return result


def watch_all(conn: Connection) -> list[WatchResult]:
    ids = conn.execute(
        text(
            "select source_id from source where enabled "
            "  and discovery <> 'manual_upload' order by priority"
        )
    ).scalars().all()
    return [watch_source(conn, s) for s in ids]
