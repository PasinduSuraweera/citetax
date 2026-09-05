"""Text extraction from documents the watcher and uploads bring in.

pypdf is pure Python and small, so it fits inside the no-model-weights rule.
Scanned PDFs with no text layer come back empty, and that is reported rather
than guessed at: an OCR step would be a separate service.
"""

from __future__ import annotations

import io
import logging
import re

logger = logging.getLogger(__name__)

_WS = re.compile(r"[ \t]+")
_BLANKS = re.compile(r"\n{3,}")
_TAG = re.compile(r"<[^>]+>")
_SCRIPT = re.compile(r"<(script|style)[^>]*>.*?</\1>", re.S | re.I)


def pdf_to_text(body: bytes, max_pages: int = 60) -> tuple[str, dict]:
    """Returns (text, meta). meta.pages_with_text tells you if it was scanned."""
    from pypdf import PdfReader

    meta = {"pages": 0, "pages_with_text": 0, "truncated": False}
    try:
        reader = PdfReader(io.BytesIO(body))
    except Exception as exc:  # noqa: BLE001
        meta["error"] = str(exc)[:160]
        return "", meta

    meta["pages"] = len(reader.pages)
    parts: list[str] = []
    for i, page in enumerate(reader.pages):
        if i >= max_pages:
            meta["truncated"] = True
            break
        try:
            t = page.extract_text() or ""
        except Exception:  # noqa: BLE001
            t = ""
        if t.strip():
            meta["pages_with_text"] += 1
            parts.append(f"[page {i + 1}]\n{t}")

    text = "\n\n".join(parts)
    text = _WS.sub(" ", text)
    text = _BLANKS.sub("\n\n", text)
    return text.strip(), meta


def html_to_text(body: bytes | str) -> str:
    html = body.decode("utf-8", "replace") if isinstance(body, bytes) else body
    html = _SCRIPT.sub(" ", html)
    # Keep paragraph structure: block tags become newlines before stripping.
    html = re.sub(r"</?(p|div|br|li|h[1-6]|tr|table|section|article)[^>]*>", "\n", html, flags=re.I)
    text = _TAG.sub(" ", html)
    text = re.sub(r"&nbsp;", " ", text)
    text = re.sub(r"&amp;", "&", text)
    text = re.sub(r"&[a-z]+;", " ", text)
    text = _WS.sub(" ", text)
    text = re.sub(r" *\n *", "\n", text)
    text = _BLANKS.sub("\n\n", text)
    return text.strip()


def extract_text(body: bytes, content_type: str, url: str = "") -> tuple[str, dict]:
    lower = (url or "").lower()
    ct = (content_type or "").lower()
    if "pdf" in ct or lower.endswith(".pdf"):
        return pdf_to_text(body)
    if "html" in ct or lower.endswith((".htm", ".html")) or body[:64].lstrip().lower().startswith(b"<!doctype html") or b"<html" in body[:512].lower():
        return html_to_text(body), {"kind": "html"}
    if "text/" in ct or lower.endswith(".txt"):
        return body.decode("utf-8", "replace").strip(), {"kind": "text"}
    # Unknown: try PDF magic, then treat as text.
    if body[:5] == b"%PDF-":
        return pdf_to_text(body)
    return body.decode("utf-8", "replace").strip(), {"kind": "unknown"}
