"""citetax-api — the answer service.

HARD CONSTRAINT (spec §2.4): this process must never load model weights.
Resident memory target ≤ 400 MiB. If you are about to `import torch` here,
you are about to recreate the crash that caused this rebuild.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy.exc import OperationalError

from app.core.config import get_settings
from app.corpus import scheduler
from app.db.session import db_healthy
from app.routers import admin, conversations, payslip, public, sources

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
settings = get_settings()


@asynccontextmanager
async def lifespan(_: FastAPI):
    # The corpus agent runs on a timer inside this process for the dev build.
    # It crawls, extracts and indexes on its own; it never approves anything.
    scheduler.start()
    try:
        yield
    finally:
        scheduler.stop()


app = FastAPI(
    title="Citetax API",
    description="Sri Lanka personal income tax copilot. Every number, cited.",
    version="0.2.0",
    lifespan=lifespan,
)

logger = logging.getLogger("citetax.api")


# Registered before CORS so CORS wraps it: an unexpected error comes back as
# JSON the browser is allowed to read, instead of a bare 500 with no CORS
# headers that the web app can only report as "cannot reach the server".
@app.middleware("http")
async def errors_as_json(request: Request, call_next):
    try:
        return await call_next(request)
    except OperationalError:
        logger.exception("database unavailable on %s %s", request.method, request.url.path)
        return JSONResponse(
            {"detail": "The database could not be reached. Try again in a moment."}, status_code=503
        )
    except Exception:  # noqa: BLE001 — logged in full, summarised to the client
        logger.exception("unhandled error on %s %s", request.method, request.url.path)
        return JSONResponse({"detail": "Something went wrong on the server."}, status_code=500)


app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(public.router)
app.include_router(conversations.router)
app.include_router(payslip.router)

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
        "agent": scheduler.status(),
    }


@app.get("/")
def root() -> dict[str, str]:
    return {"service": "citetax-api", "docs": "/docs", "health": "/health"}
