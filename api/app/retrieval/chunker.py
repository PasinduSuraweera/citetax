"""Chunk law text for retrieval.

Sentence aware, overlapping windows. Tax text is dense with figures and
cross references, so chunks stay short enough that a retrieved passage is
readable on its own, and overlap enough that a sentence split across a
boundary is still recoverable from one of them.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

_SENT = re.compile(r"(?<=[.;:])\s+(?=[A-Z(\"'“])")
_WS = re.compile(r"\s+")


@dataclass
class Chunk:
    text: str
    ordinal: int
    char_start: int
    char_end: int


def chunk_text(
    text: str,
    target_chars: int = 700,
    overlap_sentences: int = 1,
    min_chars: int = 120,
) -> list[Chunk]:
    text = _WS.sub(" ", text or "").strip()
    if not text:
        return []
    if len(text) <= target_chars:
        return [Chunk(text=text, ordinal=0, char_start=0, char_end=len(text))]

    sentences = [s.strip() for s in _SENT.split(text) if s.strip()]
    chunks: list[Chunk] = []
    buf: list[str] = []
    buf_len = 0
    cursor = 0
    ordinal = 0

    def flush(start_hint: int) -> None:
        nonlocal buf, buf_len, ordinal
        if not buf:
            return
        body = " ".join(buf)
        if len(body) < min_chars and chunks:
            # Too small to stand alone: fold into the previous chunk.
            prev = chunks[-1]
            merged = f"{prev.text} {body}"
            chunks[-1] = Chunk(merged, prev.ordinal, prev.char_start, prev.char_start + len(merged))
        else:
            chunks.append(Chunk(body, ordinal, start_hint, start_hint + len(body)))
            ordinal += 1
        keep = buf[-overlap_sentences:] if overlap_sentences else []
        buf = list(keep)
        buf_len = sum(len(s) + 1 for s in buf)

    for s in sentences:
        if buf_len + len(s) > target_chars and buf:
            flush(cursor)
        buf.append(s)
        buf_len += len(s) + 1
        cursor = text.find(s, cursor) if s in text[cursor:] else cursor
    flush(cursor)
    return chunks
