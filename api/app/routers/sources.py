"""Source registry and crawl control (spec section 5.1 I)."""

from __future__ import annotations

import json
import uuid
from typing import Any

from fastapi import APIRouter, Body, File, Form, HTTPException, UploadFile
from sqlalchemy import text

from app.core.auth import AdminDep, ReviewerDep
from app.corpus import watcher
from app.db.session import db_conn

router = APIRouter(prefix="/admin/sources")


@router.get("")
def list_sources(user: ReviewerDep) -> dict[str, Any]:
    with db_conn() as conn:
        rows = conn.execute(
            text(
                "select s.*, "
                "  (select count(*) from source_document d "
                "    where d.source_id = s.source_id) as document_count "
                "  from source s order by s.priority, s.source_id"
            )
        ).mappings().all()
        recent = conn.execute(
            text(
                "select source_id, started_at, finished_at, status, links_found, "
                "       new_documents, revisions, error "
                "  from crawl_run order by started_at desc limit 20"
            )
        ).mappings().all()
    from datetime import datetime, timezone

    now = datetime.now(timezone.utc)
    sources = []
    for r in rows:
        d = dict(r)
        d["days_since_change"] = (now - d["last_change_at"]).days if d.get("last_change_at") else None
        sources.append(d)
    return {
        "sources": sources,
        "recent_crawls": [dict(r) for r in recent],
    }


@router.post("")
def create_source(user: AdminDep, payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    required = {"source_id", "name", "index_url", "doc_type"}
    missing = sorted(k for k in required if not str(payload.get(k) or "").strip())
    if missing:
        raise HTTPException(400, f"Fill in: {', '.join(missing)}")
    if not str(payload["index_url"]).startswith(("http://", "https://")):
        raise HTTPException(400, "The index URL must start with http:// or https://")

    with db_conn() as conn:
        taken = conn.execute(
            text("select 1 from source where source_id = :s"), {"s": payload["source_id"]}
        ).first()
        if taken:
            raise HTTPException(409, f"A source called {payload['source_id']} already exists.")
        conn.execute(
            text(
                "insert into source (source_id, name, index_url, discovery, "
                "selector, doc_type, schedule, priority, enabled) values "
                "(:sid, :n, :u, :d, :sel, :dt, :sch, :p, :en)"
            ),
            {
                "sid": payload["source_id"], "n": payload["name"],
                "u": payload["index_url"],
                "d": payload.get("discovery", "html_list"),
                "sel": payload.get("selector"),
                "dt": payload["doc_type"],
                "sch": payload.get("schedule", "daily"),
                "p": payload.get("priority", "normal"),
                "en": payload.get("enabled", True),
            },
        )
        conn.commit()
    return {"ok": True, "source_id": payload["source_id"]}


@router.patch("/{source_id}")
def update_source(
    source_id: str, user: AdminDep, payload: dict[str, Any] = Body(...)
) -> dict[str, Any]:
    editable = {"name", "index_url", "discovery", "selector", "doc_type",
                "schedule", "priority", "enabled"}
    changes = {k: v for k, v in payload.items() if k in editable}
    if not changes:
        raise HTTPException(400, "no editable fields supplied")

    sets = ", ".join(f"{k} = :{k}" for k in changes)
    with db_conn() as conn:
        n = conn.execute(
            text(f"update source set {sets} where source_id = :sid"),
            {**changes, "sid": source_id},
        ).rowcount
        if not n:
            raise HTTPException(404, "Source not found")
        conn.commit()
    return {"ok": True, "changed": sorted(changes)}


@router.post("/{source_id}/crawl")
def crawl_now(source_id: str, user: ReviewerDep) -> dict[str, Any]:
    """Crawl-now button. Runs synchronously so the reviewer sees the result.

    In production this is a Cloud Run Job on a daily schedule; running it
    inline here keeps the demo honest without adding a queue.
    """
    with db_conn() as conn:
        try:
            result = watcher.watch_source(conn, source_id)
        except ValueError as exc:
            raise HTTPException(404, str(exc)) from exc
    return result.to_json()


@router.post("/crawl-all")
def crawl_all(user: ReviewerDep) -> dict[str, Any]:
    with db_conn() as conn:
        results = watcher.watch_all(conn)
    return {
        "results": [r.to_json() for r in results],
        "total_new": sum(r.new_documents for r in results),
        "total_revisions": sum(r.revisions for r in results),
    }


_UPLOAD_TYPES = (".pdf", ".docx", ".html", ".htm", ".txt")


@router.post("/upload")
async def upload_document(
    user: ReviewerDep,
    file: UploadFile = File(...),
    doc_type: str = Form("circular"),
    title: str = Form(""),
) -> dict[str, Any]:
    """Manual upload is a first-class source (spec section 3.1).

    A PDF that arrives by other means enters the same pipeline and gets the
    same lineage and audit treatment as a crawled one.
    """
    import hashlib

    from app.corpus.pdf import content_fingerprint, extract_text

    name = (file.filename or "").lower()
    if not name.endswith(_UPLOAD_TYPES):
        raise HTTPException(
            400,
            "Upload a PDF, Word (.docx), HTML or text file. For an old .doc file, "
            "save it as .docx or PDF first.",
        )
    body = await file.read()
    if not body:
        raise HTTPException(400, "empty file")
    sha = hashlib.sha256(body).hexdigest()

    # The same text extraction a crawled document gets (#40). The file itself
    # is not kept, so text is the only thing a reviewer will ever see of it.
    raw_text, text_meta = extract_text(body, file.content_type or "", name)
    raw_text = (raw_text or "").strip()[:200000]
    if len(raw_text) < 80:
        detail = (
            "No extractable text: this PDF has no text layer, so it is probably a scan. "
            "Citetax cannot read scans yet. Upload a text PDF, or the circular's web page."
            if name.endswith(".pdf")
            else "No extractable text was found in this file."
        )
        raise HTTPException(422, detail)
    is_html = (text_meta or {}).get("kind") == "html"
    fingerprint, link_share = content_fingerprint(body, raw_text, is_html)
    text_meta = {**(text_meta or {}), "fingerprint": fingerprint, "link_share": link_share}

    with db_conn() as conn:
        existing = conn.execute(
            text("select id, url from source_document where sha256 = :h"),
            {"h": sha},
        ).mappings().first()
        if existing:
            raise HTTPException(
                409,
                "This exact document is already in the corpus. Upload a changed "
                "version to record a revision.",
            )

        pseudo_url = f"upload://{file.filename}"
        prior = conn.execute(
            text(
                "select id, family_id, revision_no from source_document "
                " where url = :u order by revision_no desc limit 1"
            ),
            {"u": pseudo_url},
        ).mappings().first()

        doc_id = str(uuid.uuid4())
        family_id = str(prior["family_id"]) if prior else str(uuid.uuid4())
        conn.execute(
            text(
                "insert into source_document (id, family_id, revision_no, "
                "source_id, url, sha256, doc_type, title, fetched_at, "
                "last_seen_at, supersedes_id, uploaded_by, raw_text, text_meta) values "
                "(:id, :fam, :rev, 'manual-upload', :url, :sha, :dt, :t, now(), "
                "now(), :sup, :by, :raw, cast(:tm as jsonb))"
            ),
            {
                "id": doc_id,
                "fam": family_id,
                "rev": (prior["revision_no"] + 1) if prior else 1,
                "url": pseudo_url, "sha": sha, "dt": doc_type,
                "t": title or file.filename,
                "sup": str(prior["id"]) if prior else None,
                "by": user.email, "raw": raw_text, "tm": json.dumps(text_meta),
            },
        )

        is_revision = prior is not None
        # P1 only when a live rule came from this document, as for crawls (#27).
        feeds_published = is_revision and conn.execute(
            text(
                "select 1 from rule_version rv join source_document sd on sd.id = rv.source_document_id "
                " where sd.family_id = :fam and rv.status = 'published' limit 1"
            ),
            {"fam": family_id},
        ).first() is not None
        proposal_id = str(uuid.uuid4())
        conn.execute(
            text(
                "insert into change_proposal (id, source_document_id, status, "
                "priority, extractor_version, quoted_text) values "
                "(:id, :doc, 'needs_review', :pri, 'manual-0.1', :note)"
            ),
            {
                "id": proposal_id, "doc": doc_id,
                "pri": 1 if feeds_published else 4,
                "note": (
                    f"Uploaded revision {prior['revision_no'] + 1} of a document "
                    "already in the corpus."
                    if is_revision
                    else "Uploaded document awaiting extraction and review."
                ),
            },
        )
        conn.execute(
            text(
                "insert into review_event (actor, action, target_type, target_id, "
                "after_json) values (:a, 'document.upload', 'source_document', "
                ":t, cast(:j as jsonb))"
            ),
            {
                "a": user.email, "t": doc_id,
                "j": json.dumps({"filename": file.filename, "sha256": sha,
                                 "bytes": len(body)}),
            },
        )
        conn.commit()

    return {
        "ok": True,
        "document_id": doc_id,
        "proposal_id": proposal_id,
        "is_revision": is_revision,
        "sha256": sha[:16],
        "characters": len(raw_text),
        "pages": (text_meta or {}).get("pages"),
    }


@router.get("/documents")
def list_documents(user: ReviewerDep) -> dict[str, Any]:
    """Document families, so the three copies of one circular read as one
    lineage rather than three competing documents."""
    with db_conn() as conn:
        rows = conn.execute(
            text(
                "select id, family_id, revision_no, source_id, url, title, "
                "       doc_type, fetched_at, last_seen_at, supersedes_id, "
                "       uploaded_by, sha256, "
                "       coalesce((text_meta->>'listing')::boolean, false) as listing "
                "  from source_document order by fetched_at desc limit 100"
            )
        ).mappings().all()

    families: dict[str, list[dict[str, Any]]] = {}
    for r in rows:
        d = {**dict(r), "id": str(r["id"]), "family_id": str(r["family_id"])}
        d["supersedes_id"] = str(d["supersedes_id"]) if d["supersedes_id"] else None
        d["sha256"] = d["sha256"][:16] if d["sha256"] else None
        families.setdefault(d["family_id"], []).append(d)

    return {
        "families": [
            {
                "family_id": fam,
                "revisions": sorted(docs, key=lambda x: x["revision_no"], reverse=True),
                "latest_revision": max(d["revision_no"] for d in docs),
                "has_revisions": len(docs) > 1,
                # A listing page is not a document; its revisions were noise.
                "listing": max(docs, key=lambda x: x["revision_no"])["listing"],
            }
            for fam, docs in families.items()
        ]
    }
