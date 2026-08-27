"""citetax-api — the answer service.

HARD CONSTRAINT (spec §2.4): this process must never load model weights.
Resident memory target ≤ 400 MiB. If you are about to `import torch` here,
you are about to recreate the crash that caused this rebuild.
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import get_settings
from app.db.session import db_healthy
from app.routers import admin, public, sources

settings = get_settings()

app = FastAPI(
    title="Citetax API",
    description="Sri Lanka personal income tax copilot. Every number, cited.",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(public.router)
# Admin routes carry their own role dependencies. In production these sit
# behind IAP on a separate service (spec section 2.2); locally the role on the
# account is the gate.
app.include_router(admin.router)
app.include_router(sources.router)


@app.get("/health")
def health() -> dict[str, object]:
    """Surfaces configuration problems immediately rather than as a 500 on the
    first question."""
    ok, detail = db_healthy()
    return {
        "status": "ok" if ok else "degraded",
        "database": {"ok": ok, "detail": detail},
        "llm": {
            "configured": settings.llm_enabled,
            "model": settings.groq_model if settings.llm_enabled else None,
        },
        "embedding_backend": settings.embedding_backend,
        "supported_yas": list(settings.supported_yas),
    }


@app.get("/")
def root() -> dict[str, str]:
    return {"service": "citetax-api", "docs": "/docs", "health": "/health"}
