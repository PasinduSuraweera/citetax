"""A payslip is sent to Gemini only with the user's agreement (#51)."""

from __future__ import annotations

import time
import uuid

import jwt
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.core.config import get_settings
from app.db.session import db_conn
from app.main import app
from app.payslip import extractor
from app.routers import payslip as payslip_router

client = TestClient(app)


@pytest.fixture
def headers():
    email = f"payslip-test-{uuid.uuid4().hex[:10]}@example.invalid"
    token = jwt.encode({"email": email, "name": "Payslip Test", "exp": int(time.time()) + 3600},
                       get_settings().auth_secret, algorithm="HS256")
    h = {"Authorization": f"Bearer {token}"}
    assert client.get("/v1/conversations", headers=h).status_code == 200
    yield h
    with db_conn() as conn:
        conn.execute(text("delete from app_user where email = :e"), {"e": email})
        conn.commit()


def _upload(headers, **form):
    files = {"file": ("payslip.png", b"\x89PNG\r\n\x1a\n not really an image", "image/png")}
    return client.post("/v1/payslip/extract", headers=headers, files=files, data={"ya": "2026/2027", **form})


def test_without_consent_the_file_never_reaches_gemini(headers, monkeypatch):
    def must_not_run(*_a, **_k):
        raise AssertionError("the payslip was sent without consent")

    monkeypatch.setattr(payslip_router, "extract", must_not_run)
    r = _upload(headers)
    assert r.status_code == 400
    assert "Gemini" in r.json()["detail"]
    assert _upload(headers, consent="yes").status_code == 400


def test_with_consent_the_file_is_read(headers, monkeypatch):
    sent = []

    def fake(body, mime):
        sent.append(mime)
        raise extractor.PayslipExtractionUnavailable("test: no model call")

    monkeypatch.setattr(payslip_router, "extract", fake)
    r = _upload(headers, consent="gemini")
    assert sent == ["image/png"]
    assert r.status_code != 400 or "Gemini" not in r.text
