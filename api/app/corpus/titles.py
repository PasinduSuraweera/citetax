"""A readable title for a fetched document.

The title is what a reviewer sees in the inbox and what a taxpayer sees on a
source card, so it has to name the document, not the site that hosts it and
not whatever text happened to come first on the page.

Order of preference: the page's own og:title, its <title>, its first <h1>,
the first line of extracted text, and finally "Page on <host>". Each
candidate is cleaned and rejected if what is left is code, a file name, or
too short to name anything.
"""

from __future__ import annotations

import html as _html
import re
from urllib.parse import urlparse

MAX_LEN = 120

_OG = re.compile(
    r"<meta[^>]+property=[\"']og:title[\"'][^>]*content=[\"']([^\"']+)[\"']"
    r"|<meta[^>]+content=[\"']([^\"']+)[\"'][^>]*property=[\"']og:title[\"']",
    re.I,
)
_TITLE = re.compile(r"<title[^>]*>(.*?)</title>", re.I | re.S)
_H1 = re.compile(r"<h1[^>]*>(.*?)</h1>", re.I | re.S)
_TAG = re.compile(r"<[^>]+>")
# Script that leaked into a title: nothing after the first of these is title.
_CODE = re.compile(r"\s(?:window\.|document\.|function\s*\(|var\s|const\s|let\s)|[{};]")
# "Site :: Page", "Page | Site". Dashes are left alone: page titles use them.
_SEPARATORS = re.compile(r"\s*(?:::|\|)\s*")
# A lone file name, path or query string: "Tools.aspx?menuid=1605".
_SLUG = re.compile(r"^[^\s]*[.?=/][^\s]*$")
# "[page 1]" and similar markers the PDF extractor writes.
_MARKER = re.compile(r"^\[[^\]]*\]$")


def _squash(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", s.lower())


def _site_label(url: str) -> str:
    """The distinctive part of the host: "taxadvisor" for www.taxadvisor.lk."""
    host = (urlparse(url).hostname or "").removeprefix("www.")
    return _squash(host.split(".", 1)[0])


def clean_title(raw: str | None, url: str = "") -> str | None:
    """The document's own name from a raw title, or None if there is none."""
    if not raw:
        return None
    t = _html.unescape(_TAG.sub(" ", raw))
    t = re.sub(r"\s+", " ", t).strip()
    # A curly apostrophe decoded with the wrong charset: "Lanka�s".
    t = re.sub(r"(?<=\w)�(?=\w)", "'", t)
    t = _CODE.split(t, maxsplit=1)[0]
    parts = [p.strip(" -:") for p in _SEPARATORS.split(t)]
    parts = [p for p in parts if p]
    if not parts:
        return None
    # Drop the part that is the site's own name ("Tax Advisor - Instant Tax
    # Solutions" on taxadvisor.lk), unless it is all there is: a home page's
    # title is the site's name.
    site = _site_label(url)
    if site and len(site) >= 4 and len(parts) > 1:
        parts = [p for p in parts if site not in _squash(p)] or parts
    t = parts[-1] if len(parts) == 1 else max(parts, key=len)
    if len(t) < 3 or _SLUG.match(t) or _MARKER.match(t):
        return None
    if len(t) > MAX_LEN:
        t = t[:MAX_LEN].rsplit(" ", 1)[0] + "…"
    return t


def page_on(url: str) -> str:
    host = urlparse(url).hostname or ""
    host = host.removeprefix("www.")
    return f"Page on {host}" if host else "Untitled document"


def document_title(body: bytes | None, raw_text: str | None, url: str, is_html: bool) -> str:
    candidates: list[str | None] = []
    if body and is_html:
        head = body[:200_000].decode("utf-8", "replace")
        if m := _OG.search(head):
            candidates.append(m.group(1) or m.group(2))
        if m := _TITLE.search(head):
            candidates.append(m.group(1))
        if m := _H1.search(head):
            candidates.append(m.group(1))
    first_line = (raw_text or "").strip().split("\n", 1)[0]
    if len(first_line) <= 160:
        candidates.append(first_line)

    for c in candidates:
        if t := clean_title(c, url):
            return t
    return page_on(url)
