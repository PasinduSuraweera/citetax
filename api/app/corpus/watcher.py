"""Source watcher (spec section 3.2).

Fetches each index page, extracts candidate document links, and fingerprints
every document it finds by what it says rather than by its bytes.

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
import json
import logging
import re
import time
import uuid
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urljoin, urlparse
from urllib.robotparser import RobotFileParser

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
# Page 2, 3, ... of a listing: excerpts of old articles, not a document.
_PAGINATED = re.compile(r"/page/\d+$")

# Share of a page's text that is links above which it is a listing, not a
# document. Measured: articles run 0.17 to 0.54, listings and pages whose
# content loads by script 0.96 to 1.0.
LISTING_LINK_SHARE = 0.9

# Seconds between two requests to the same host, unless robots.txt asks for
# more with Crawl-delay (#54).
POLITE_DELAY = 1.0
# Tests swap in an httpx.MockTransport; None means the real network.
_transport: httpx.BaseTransport | None = None


class PoliteClient:
    """Fetches the way the User-Agent says it does: robots.txt is read once per
    host and obeyed, requests to one host are spaced out, and a page fetched
    before is asked for only if it changed."""

    def __init__(self, client: httpx.Client):
        self.client = client
        self.robots: dict[str, RobotFileParser | None] = {}
        self.last_hit: dict[str, float] = {}

    def _rules(self, url: str) -> RobotFileParser | None:
        parts = urlparse(url)
        host = f"{parts.scheme}://{parts.netloc}"
        if host not in self.robots:
            rp: RobotFileParser | None = RobotFileParser()
            try:
                resp = self._get(f"{host}/robots.txt")
                if resp.status_code >= 500:
                    rp = None  # server trouble: crawl nothing on this host this time
                elif resp.status_code >= 400:
                    rp.parse([])  # no robots.txt: everything is allowed
                else:
                    rp.parse(resp.text.splitlines())
            except httpx.HTTPError:
                rp = None
            self.robots[host] = rp
        return self.robots[host]

    def allowed(self, url: str) -> bool:
        rp = self._rules(url)
        return rp is not None and rp.can_fetch(USER_AGENT, url)

    def _get(self, url: str, headers: dict[str, str] | None = None) -> httpx.Response:
        parts = urlparse(url)
        rp = self.robots.get(f"{parts.scheme}://{parts.netloc}")
        asked = rp.crawl_delay(USER_AGENT) if rp else None
        delay = max(POLITE_DELAY, float(asked or 0))
        wait = self.last_hit.get(parts.netloc, 0) + delay - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        try:
            return self.client.get(url, headers=headers)
        finally:
            self.last_hit[parts.netloc] = time.monotonic()

    def get(self, url: str, validators: dict[str, str] | None = None) -> httpx.Response:
        headers = {}
        if validators and validators.get("etag"):
            headers["If-None-Match"] = validators["etag"]
        if validators and validators.get("last_modified"):
            headers["If-Modified-Since"] = validators["last_modified"]
        return self._get(url, headers or None)


def _same_text(a: str | None, b: str | None) -> bool:
    norm = lambda t: re.sub(r"\s+", " ", t or "").strip()  # noqa: E731
    return bool(norm(a)) and norm(a) == norm(b)


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
    skipped: list[str] = field(default_factory=list)
    skip_reasons: dict[str, list[str]] = field(default_factory=dict)
    errors: list[str] = field(default_factory=list)
    documents: list[dict[str, Any]] = field(default_factory=list)

    def skip(self, url: str, reason: str) -> None:
        self.skipped.append(url)
        self.skip_reasons.setdefault(reason, []).append(url)

    def to_json(self) -> dict[str, Any]:
        return {
            "source_id": self.source_id,
            "links_found": self.links_found,
            "new_documents": self.new_documents,
            "revisions": self.revisions,
            "unchanged": self.unchanged,
            "skipped": self.skipped,
            "skip_reasons": self.skip_reasons,
            "errors": self.errors,
            "documents": self.documents,
        }


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
        is_index_page = (
            lowered in _INDEX_PATHS or lowered == base_path or bool(_PAGINATED.search(lowered))
        )
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
    validators: dict[str, str | None] | None = None,
) -> None:
    """Decide: unchanged, new, or a silent revision.

    Bytes decide the quick case. Otherwise the page's own words decide, so a
    rewritten view state or a new sidebar post is not a revision.
    """
    sha = hashlib.sha256(body).hexdigest()

    existing_same_hash = conn.execute(
        text("select id from source_document where sha256 = :h limit 1"),
        {"h": sha},
    ).first()
    validators = {k: v for k, v in (validators or {}).items() if v}
    if existing_same_hash:
        conn.execute(
            text(
                "update source_document set last_seen_at = now(), "
                "text_meta = coalesce(text_meta, '{}'::jsonb) || cast(:m as jsonb) where id = :id"
            ),
            {"id": existing_same_hash[0], "m": json.dumps(validators)},
        )
        result.unchanged += 1
        return

    # Extract text from whatever arrived: HTML, PDF, or plain text. A PDF with
    # no text layer yields an empty string, which the extractor reports as
    # "no extractable text" rather than guessing.
    from app.corpus.pdf import content_fingerprint, extract_text

    raw_text, text_meta = extract_text(body, content_type, url)
    is_html = (text_meta or {}).get("kind") == "html"
    fingerprint, link_share = content_fingerprint(body, raw_text, is_html)

    # A page that is almost all links is a listing or a page whose content
    # loads by script. Neither states a rule.
    if is_html and link_share >= LISTING_LINK_SHARE:
        result.skip(url, "listing")
        return

    prior = conn.execute(
        text(
            "select id, family_id, revision_no, raw_text, "
            "       text_meta->>'fingerprint' as fingerprint "
            "  from source_document where url = :u order by revision_no desc limit 1"
        ),
        {"u": url},
    ).mappings().first()

    if prior and (
        prior["fingerprint"] == fingerprint
        or (not prior["fingerprint"] and _same_text(prior["raw_text"], raw_text))
    ):
        conn.execute(
            text(
                "update source_document set last_seen_at = now(), "
                "text_meta = coalesce(text_meta, '{}'::jsonb) || cast(:m as jsonb) "
                "where id = :id"
            ),
            {"id": prior["id"], "m": json.dumps({"fingerprint": fingerprint, **validators})},
        )
        result.unchanged += 1
        return

    doc_id = str(uuid.uuid4())
    is_revision = prior is not None
    family_id = str(prior["family_id"]) if prior else str(uuid.uuid4())
    revision_no = (prior["revision_no"] + 1) if prior else 1
    text_meta = {**(text_meta or {}), "fingerprint": fingerprint, "link_share": link_share, **validators}
    raw_text = (raw_text or "")[:200000] or None

    doc_type = conn.execute(
        text("select doc_type from source where source_id = :s"), {"s": source_id}
    ).scalar() or "circular"

    from app.corpus.titles import document_title

    title = document_title(body, raw_text, url, is_html=is_html)

    conn.execute(
        text(
            "insert into source_document (id, family_id, revision_no, source_id, "
            "url, sha256, doc_type, title, fetched_at, last_seen_at, "
            "supersedes_id, raw_text, text_meta) values "
            "(:id, :fam, :rev, :src, :url, :sha, :dt, :title, now(), now(), "
            ":sup, :raw, cast(:tm as jsonb))"
        ),
        {
            "id": doc_id, "fam": family_id, "rev": revision_no, "src": source_id,
            "url": url, "sha": sha, "dt": doc_type,
            "title": title,
            "sup": str(prior["id"]) if prior else None,
            "raw": raw_text,
            "tm": json.dumps(text_meta),
        },
    )

    # A revision of a document a published rule was taken from is the highest
    # priority a reviewer can see, because a live rule may now be wrong. A
    # revision of anything else is just another page to read.
    feeds_published = is_revision and conn.execute(
        text(
            "select 1 from rule_version rv "
            "  join source_document sd on sd.id = rv.source_document_id "
            " where sd.family_id = :fam and rv.status = 'published' limit 1"
        ),
        {"fam": family_id},
    ).first() is not None
    priority = 1 if feeds_published else 4
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
                f"Silent revision of a published rule's source: this URL was "
                f"already known and its content changed. Revision {revision_no}, "
                f"superseding revision {revision_no - 1}."
                if feeds_published
                else f"Revised document: its content changed. Revision {revision_no}."
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


def watch_source(
    conn: Connection, source_id: str, max_docs: int = 12, triggered_by: str = "manual"
) -> WatchResult:
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
            "insert into crawl_run (id, source_id, status, triggered_by) "
            "values (:id, :s, 'running', :by)"
        ),
        {"id": crawl_id, "s": source_id, "by": triggered_by},
    )
    conn.commit()

    try:
        with httpx.Client(
            timeout=30.0, follow_redirects=True,
            headers={"User-Agent": USER_AGENT}, transport=_transport,
        ) as raw_client:
            client = PoliteClient(raw_client)
            if not client.allowed(row["index_url"]):
                raise RuntimeError(f"robots.txt does not allow {row['index_url']}")
            index = client.get(row["index_url"])
            index.raise_for_status()
            links = extract_links(index.text, row["index_url"])
            result.links_found = len(links)

            for link in links[:max_docs]:
                try:
                    if not client.allowed(link.url):
                        result.skip(link.url, "robots")
                        continue
                    known = conn.execute(
                        text(
                            "select id, text_meta->>'etag' as etag, "
                            "       text_meta->>'last_modified' as last_modified "
                            "  from source_document where url = :u order by revision_no desc limit 1"
                        ),
                        {"u": link.url},
                    ).mappings().first()
                    resp = client.get(link.url, dict(known) if known else None)
                    if resp.status_code == 304 and known:
                        conn.execute(
                            text("update source_document set last_seen_at = now() where id = :id"),
                            {"id": known["id"]},
                        )
                        result.unchanged += 1
                        continue
                    # A dead link on someone else's page is their broken
                    # link, not a failed crawl.
                    if 400 <= resp.status_code < 500:
                        result.skip(link.url, "gone")
                        continue
                    resp.raise_for_status()
                    _record_document(
                        conn, source_id, link.url, resp.content,
                        resp.headers.get("content-type", ""), result,
                        {"etag": resp.headers.get("etag"),
                         "last_modified": resp.headers.get("last-modified")},
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
                "links_found = :lf, new_documents = :nd, revisions = :rv, "
                "skipped_json = cast(:sk as jsonb) where id = :id"
            ),
            {
                "lf": result.links_found, "nd": result.new_documents,
                "rv": result.revisions, "id": crawl_id,
                "sk": json.dumps(result.skip_reasons),
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


def watch_all(conn: Connection, triggered_by: str = "scheduler") -> list[WatchResult]:
    ids = conn.execute(
        text(
            "select source_id from source where enabled "
            "  and discovery <> 'manual_upload' order by priority"
        )
    ).scalars().all()
    return [watch_source(conn, s, triggered_by=triggered_by) for s in ids]
