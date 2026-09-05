"""Embedding provider (spec section 2.4 provider abstraction).

The chosen provider is hosted Gemini, which means no model weights in this
process. `gemini-embedding-001` returns 3072 dimensions by default, past
pgvector's 2000 dimension ceiling for an HNSW index, so every call asks for
768 to match the vector(768) column.

Task types matter for retrieval quality: a query and a document are embedded
differently, and mixing them up costs recall.
"""

from __future__ import annotations

import logging
from typing import Protocol

from app.core.config import get_settings

logger = logging.getLogger(__name__)


class EmbeddingProvider(Protocol):
    dim: int
    model_id: str

    def embed_documents(self, texts: list[str]) -> list[list[float]]: ...
    def embed_query(self, text: str) -> list[float]: ...


class GeminiProvider:
    def __init__(self) -> None:
        s = get_settings()
        self.dim = s.embedding_dim
        self.model_id = s.embedding_model
        self._key = s.google_api_key
        self._client = None

    def _c(self):
        if self._client is None:
            from google import genai

            self._client = genai.Client(api_key=self._key)
        return self._client

    def _embed(self, texts: list[str], task: str) -> list[list[float]]:
        import time

        from google.genai import types

        out: list[list[float]] = []
        # Modest batches so one bad chunk does not take down an indexing run,
        # and a short backoff on 429 because the free tier rate limits per
        # minute. Three tries, then the caller stores the chunk without a
        # vector and full text search still covers it.
        for i in range(0, len(texts), 16):
            batch = texts[i : i + 16]
            for attempt in range(3):
                try:
                    resp = self._c().models.embed_content(
                        model=self.model_id,
                        contents=batch,
                        config=types.EmbedContentConfig(
                            output_dimensionality=self.dim, task_type=task
                        ),
                    )
                    out.extend([list(e.values) for e in resp.embeddings])
                    break
                except Exception as exc:  # noqa: BLE001
                    if "429" in str(exc) and attempt < 2:
                        time.sleep(4 * (attempt + 1))
                        continue
                    raise
        return out

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        return self._embed(texts, "RETRIEVAL_DOCUMENT")

    def embed_query(self, text: str) -> list[float]:
        return self._embed([text], "RETRIEVAL_QUERY")[0]


class NoneProvider:
    """Dense retrieval disabled. Search falls back to Postgres full text."""

    dim = 0
    model_id = "none"

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        return [[] for _ in texts]

    def embed_query(self, text: str) -> list[float]:
        return []


def get_provider() -> EmbeddingProvider:
    s = get_settings()
    if s.embedding_backend == "vertex" and s.google_api_key:
        return GeminiProvider()
    return NoneProvider()


def dense_enabled() -> bool:
    s = get_settings()
    return s.embedding_backend == "vertex" and bool(s.google_api_key)
