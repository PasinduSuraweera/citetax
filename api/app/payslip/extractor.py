"""Payslip/EA form extraction (spec §1.3, "payslip upload" — previously unbuilt).

The hard rule in requirements.txt is no local model weights, so this cannot be
pytesseract or any local OCR. It calls the hosted Gemini vision model this repo
already depends on (`google-genai`, used today only for embeddings) with a
schema that has no room for a name, NIC, employer or address — the same
minimisation boundary `TaxFacts` enforces (`app/compute/types.py`), applied one
layer earlier so an identifier has nowhere to land even if the model volunteers
one.

Nothing here is persisted. The caller holds the raw bytes only for the
duration of this call and discards them immediately after.
"""

from __future__ import annotations

import logging
from decimal import Decimal, InvalidOperation
from typing import Literal

from pydantic import BaseModel

from app.core.config import get_settings

logger = logging.getLogger(__name__)

_PROMPT = """You are reading a Sri Lankan payslip or EA (employer) form to extract
figures for a tax calculation. Extract ONLY the fields in the schema.

Rules:
- Never transcribe or repeat a name, NIC/passport number, address, employer
  name, or account number anywhere in your response, including in warnings.
  If the document is legible but you notice one, simply omit it — do not
  describe it either.
- gross_salary is the gross pay for the period shown (before deductions).
- epf_employee is the employee's own EPF contribution for the period, not the
  employer's contribution.
- apit_withheld is tax already deducted at source (APIT/PAYE) for the period.
- pay_period is "monthly" if this is a single pay period, "annual" if it is a
  yearly summary (e.g. an EA form).
- If a field is not present on the document, leave it null. Do not guess.
- is_payslip is false if this is not a payslip/EA form at all (e.g. a random
  photo) — in that case leave every figure null.
- confidence reflects how legible and complete the document was, 0 to 1.
"""


class PayslipExtractionUnavailable(Exception):
    """The extraction call itself failed (network, quota, malformed response)."""


class _GeminiPayslipResponse(BaseModel):
    """Raw shape asked of the model. Plain JSON types only — Gemini's schema
    support does not cover Decimal, so the conversion happens after the call."""

    is_payslip: bool
    confidence: float
    pay_period: Literal["monthly", "annual"] | None = None
    gross_salary: float | None = None
    epf_employee: float | None = None
    apit_withheld: float | None = None
    warnings: list[str] = []


def _response_schema() -> dict:
    """Built by hand as a plain dict, not a `types.Schema` instance or a
    Pydantic model class.

    The google-genai SDK's `t_schema` transformer only passes a plain `dict`
    through untouched. Anything else gets routed through
    `origin.model_json_schema()` — including a `types.Schema` instance, since
    `Schema` is itself a Pydantic model, so that call describes the *shape of
    the Schema class*, not the schema we built. And a Pydantic model class's
    own `X | None` field becomes `anyOf: [{type: X}, {type: "null"}]`, which
    the SDK naively uppercases to `"NULL"` — not a legal Gemini type, so
    `Schema.model_validate` rejects it. A plain dict sidesteps both problems;
    "optional" is expressed as `nullable: true` on the real type, the way
    Gemini's schema actually supports it.
    """

    def nullable(schema_type: str, **kw) -> dict:
        return {"type": schema_type, "nullable": True, **kw}

    return {
        "type": "OBJECT",
        "properties": {
            "is_payslip": {"type": "BOOLEAN"},
            "confidence": {"type": "NUMBER"},
            "pay_period": nullable("STRING", enum=["monthly", "annual"]),
            "gross_salary": nullable("NUMBER"),
            "epf_employee": nullable("NUMBER"),
            "apit_withheld": nullable("NUMBER"),
            "warnings": {"type": "ARRAY", "items": {"type": "STRING"}},
        },
        "required": ["is_payslip", "confidence"],
    }


class PayslipExtraction(BaseModel):
    """What the rest of the app sees. No name/employer/NIC field exists here,
    mirroring TaxFacts's minimisation boundary at the schema level."""

    is_payslip: bool
    confidence: float
    pay_period: Literal["monthly", "annual"] | None
    gross_salary: Decimal | None
    epf_employee: Decimal | None
    apit_withheld: Decimal | None
    warnings: list[str]


def _to_decimal(value: float | None) -> Decimal | None:
    if value is None:
        return None
    try:
        # Via str(), not Decimal(value) directly, so a binary float like
        # 250000.00000001 never leaks into a figure that crosses the wire.
        return Decimal(str(value))
    except InvalidOperation:
        return None


def extract(file_bytes: bytes, mime_type: str) -> PayslipExtraction:
    """Hosted vision call. Raises PayslipExtractionUnavailable on any failure —
    the caller falls back to asking the user to type figures instead."""
    settings = get_settings()
    if not settings.google_api_key:
        raise PayslipExtractionUnavailable("GOOGLE_API_KEY is not configured")

    try:
        from google import genai
        from google.genai import types

        client = genai.Client(api_key=settings.google_api_key)
        resp = client.models.generate_content(
            model=settings.payslip_extraction_model,
            contents=[
                types.Part.from_bytes(data=file_bytes, mime_type=mime_type),
                _PROMPT,
            ],
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_schema=_response_schema(),
            ),
        )
        raw = _GeminiPayslipResponse.model_validate_json(resp.text)
    except Exception as exc:  # noqa: BLE001 — any failure here is the same to the caller
        logger.warning("payslip extraction failed: %s", exc)
        raise PayslipExtractionUnavailable(str(exc)[:200]) from exc

    return PayslipExtraction(
        is_payslip=raw.is_payslip,
        confidence=raw.confidence,
        pay_period=raw.pay_period,
        gross_salary=_to_decimal(raw.gross_salary),
        epf_employee=_to_decimal(raw.epf_employee),
        apit_withheld=_to_decimal(raw.apit_withheld),
        warnings=raw.warnings,
    )


def to_tax_facts_fields(extraction: PayslipExtraction) -> dict[str, Decimal]:
    """Annualizes monthly figures, matching the convention in
    `app/graph/intake.py` (`salary *= 12` when the question reads as monthly)."""
    multiplier = Decimal(12) if extraction.pay_period == "monthly" else Decimal(1)
    fields: dict[str, Decimal] = {}
    if extraction.gross_salary is not None:
        fields["employment_income"] = extraction.gross_salary * multiplier
    if extraction.epf_employee is not None:
        fields["epf_employee"] = extraction.epf_employee * multiplier
    if extraction.apit_withheld is not None:
        fields["apit_withheld"] = extraction.apit_withheld * multiplier
    return fields
