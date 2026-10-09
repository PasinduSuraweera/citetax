"""The Cloud Scheduler endpoint refuses anything without the right token."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.core.config import get_settings
from app.main import app
from app.routers import internal

client = TestClient(app)


def test_refused_when_no_token_is_configured(monkeypatch):
    monkeypatch.setattr(get_settings(), "cron_token", "")
    assert client.post("/internal/agent/run", headers={"X-Cron-Token": "anything"}).status_code == 403


def test_refused_with_a_wrong_or_missing_token(monkeypatch):
    monkeypatch.setattr(get_settings(), "cron_token", "s3cret")
    assert client.post("/internal/agent/run").status_code == 403
    assert client.post("/internal/agent/run", headers={"X-Cron-Token": "nope"}).status_code == 403


def test_runs_one_cycle_with_the_right_token(monkeypatch):
    from app.corpus import scheduler

    class Report:
        def to_json(self):
            return {"summary": "ok"}

    monkeypatch.setattr(get_settings(), "cron_token", "s3cret")
    monkeypatch.setattr(scheduler, "run_cycle", lambda trigger: Report())
    r = client.post("/internal/agent/run", headers={"X-Cron-Token": "s3cret"})
    assert (r.status_code, r.json()) == (200, {"summary": "ok"})
    assert internal.router.prefix == "/internal"
