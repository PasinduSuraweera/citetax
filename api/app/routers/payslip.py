"""Payslip upload — extraction preview only (spec §1.3).

Stateless: the uploaded bytes live only for the duration of the extraction
call. Nothing is written to the database here — no source_document row, no
storage write of any kind. The figures this returns are a preview; nothing is
computed or saved until the user confirms them through the existing
`/v1/compute` endpoint with `source: "payslip"`.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from app.core import plans
from app.core.auth import CurrentUserDep
from app.core.config import get_settings
from app.payslip.extractor import (
    PayslipExtractionUnavailable,
    extract,
    to_tax_facts_fields,
)

router = APIRouter(prefix="/v1/payslip")

_ALLOWED_TYPES = {"image/jpeg", "image/png", "image/webp", "application/pdf"}


@router.post("/extract")
async def extract_payslip(
    user: CurrentUserDep,
    file: UploadFile = File(...),
    ya: str = Form(...),
    consent: str = Form(""),
) -> dict[str, Any]:
    # Part of the Individual and Team plans (app.core.plans).
    plans.check_payslip_allowed(user)
    # The file goes to Google's Gemini whole, identifiers included. That only
    # happens with the user's explicit agreement, checked here as well as on
    # the upload screen, so no client can skip it (#51).
    if consent != "gemini":
        raise HTTPException(
            400,
            "Reading a payslip sends it to Google's Gemini model. Agree to that "
            "on the upload screen, or type the figures yourself.",
        )
    settings = get_settings()
    if ya not in settings.supported_yas:
        raise HTTPException(
            400,
            f"Year of assessment {ya} is not supported. "
            f"Supported: {', '.join(settings.supported_yas)}",
        )
    if file.content_type not in _ALLOWED_TYPES:
        raise HTTPException(
            400, "Upload a JPEG, PNG, WEBP photo, or a PDF of your payslip."
        )

    body = await file.read()
    if not body:
        raise HTTPException(400, "empty file")
    if len(body) > settings.payslip_max_bytes:
        raise HTTPException(
            413, f"File too large (max {settings.payslip_max_bytes // (1024 * 1024)}MB)."
        )

    try:
        extraction = extract(body, file.content_type)
    except PayslipExtractionUnavailable as exc:
        raise HTTPException(
            503,
            "Could not read that document right now. Try entering figures manually.",
        ) from exc
    finally:
        # Nothing from the upload survives this request — not the image, not
        # any intermediate OCR text.
        del body

    if not extraction.is_payslip or extraction.confidence < 0.5:
        raise HTTPException(
            422,
            "That doesn't look like a payslip or EA form — try a clearer photo, "
            "or enter figures manually.",
        )

    fields = to_tax_facts_fields(extraction)
    return {
        "ya": ya,
        "source": "payslip",
        "confidence": extraction.confidence,
        "pay_period": extraction.pay_period,
        "fields": {k: f"{v:.2f}" for k, v in fields.items()},
        "warnings": extraction.warnings,
    }
