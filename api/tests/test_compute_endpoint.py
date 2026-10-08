"""The structured /v1/compute endpoint treats APIT as the chat does (#110)."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app

pytestmark = pytest.mark.db
client = TestClient(app)


def _apit(body):
    return next(s for s in body["steps"] if s["rule_key"] == "credit.apit")


def test_left_out_the_employers_apit_is_assumed():
    r = client.post("/v1/compute", json={"ya": "2026/2027", "employment_income": "3300000"})
    assert r.status_code == 200
    body = r.json()
    assert _apit(body)["detail"]["assumed"] is True
    assert body["balance_payable"] == "0.00"


def test_a_stated_nil_apit_is_kept():
    r = client.post("/v1/compute", json={"ya": "2026/2027", "employment_income": "3300000", "apit_withheld": "0"})
    body = r.json()
    assert body["balance_payable"] == body["gross_tax"]
