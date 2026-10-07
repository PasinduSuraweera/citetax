"""Reviewer upload reads PDF, DOCX, HTML and text like a crawl does (#40)."""

from __future__ import annotations

import io
import time
import uuid
import zipfile

import jwt
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.core.config import get_settings
from app.corpus import extractor
from app.db.session import db_conn
from app.main import app

pytestmark = pytest.mark.db

client = TestClient(app)

TEXT = (
    "This circular explains how the Inland Revenue Department processes "
    "returns submitted online through RAMIS, and what a taxpayer should keep."
)


def _pdf(lines: list[str]) -> bytes:
    """A minimal one page PDF. With lines it has a text layer; without, it is
    what a scanner produces as far as text extraction can tell."""
    ops = "".join(f"BT /F1 11 Tf 50 {760 - 16 * i} Td ({ln}) Tj ET\n" for i, ln in enumerate(lines))
    objs = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        "/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        f"<< /Length {len(ops)} >>\nstream\n{ops}endstream",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out, offsets = io.BytesIO(), []
    out.write(b"%PDF-1.4\n")
    for i, body in enumerate(objs, 1):
        offsets.append(out.tell())
        out.write(f"{i} 0 obj\n{body}\nendobj\n".encode())
    xref = out.tell()
    out.write(f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode())
    for off in offsets:
        out.write(f"{off:010d} 00000 n \n".encode())
    out.write(f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF".encode())
    return out.getvalue()


def _docx(paragraphs: list[str]) -> bytes:
    body = "".join(f"<w:p><w:r><w:t>{p}</w:t></w:r></w:p>" for p in paragraphs)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("word/document.xml",
                   '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
                   f"<w:body>{body}</w:body></w:document>")
    return buf.getvalue()


@pytest.fixture
def reviewer():
    email = f"upload-test-{uuid.uuid4().hex[:10]}@example.invalid"
    token = jwt.encode({"email": email, "name": "Upload Test", "exp": int(time.time()) + 3600},
                       get_settings().auth_secret, algorithm="HS256")
    h = {"Authorization": f"Bearer {token}"}
    assert client.get("/admin/me", headers=h).status_code == 200
    with db_conn() as conn:
        conn.execute(text("update app_user set role = 'reviewer' where email = :e"), {"e": email})
        conn.commit()
    docs: list[str] = []
    yield h, docs
    with db_conn() as conn:
        conn.execute(text("delete from review_event where target_id = any(:d) or actor = :e"), {"d": docs, "e": email})
        conn.execute(text("delete from change_proposal where source_document_id = any(cast(:d as uuid[]))"), {"d": docs})
        conn.execute(text("delete from source_document where id = any(cast(:d as uuid[]))"), {"d": docs})
        conn.execute(text("delete from app_user where email = :e"), {"e": email})
        conn.commit()


def _upload(headers, name: str, body: bytes, mime: str):
    tag = uuid.uuid4().hex[:8]  # a unique name and bytes, so reruns never collide
    return client.post(
        "/admin/sources/upload", headers=headers,
        files={"file": (f"{tag}-{name}", body + tag.encode() if mime == "text/plain" else body, mime)},
        data={"doc_type": "circular", "title": f"upload test {tag}"},
    )


def test_a_text_pdf_is_read_and_queued_for_the_agent(reviewer, monkeypatch):
    headers, docs = reviewer
    marker = uuid.uuid4().hex[:6]
    r = _upload(headers, "circular.pdf", _pdf([TEXT[:70], TEXT[70:], f"Ref {marker}"]), "application/pdf")
    assert r.status_code == 200, r.text
    doc = r.json()["document_id"]
    docs.append(doc)
    assert r.json()["pages"] == 1
    with db_conn() as conn:
        raw = conn.execute(text("select raw_text from source_document where id = :d"), {"d": doc}).scalar()
        assert "RAMIS" in raw

        # The next agent cycle extracts it: it is among the documents picked up.
        picked: list[str] = []
        monkeypatch.setattr(extractor, "extract_document", lambda c, d, b=None: picked.append(d) or extractor.ExtractReport(document_id=d))
        extractor.extract_pending(conn, limit=500)
    assert doc in picked


def test_a_scanned_pdf_reports_no_extractable_text(reviewer):
    headers, _ = reviewer
    r = _upload(headers, "scan.pdf", _pdf([]), "application/pdf")
    assert r.status_code == 422
    assert "No extractable text" in r.json()["detail"]


def test_docx_is_read_and_old_doc_is_refused_with_a_way_out(reviewer):
    headers, docs = reviewer
    marker = uuid.uuid4().hex[:6]
    r = _upload(headers, "circular.docx", _docx([TEXT, f"Ref {marker}"]),
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
    assert r.status_code == 200, r.text
    docs.append(r.json()["document_id"])

    r = _upload(headers, "old.doc", b"\xd0\xcf\x11\xe0 binary word", "application/msword")
    assert r.status_code == 400
    assert ".docx or PDF" in r.json()["detail"]
