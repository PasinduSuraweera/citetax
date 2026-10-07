"""One source of supported years, and today's year in Colombo time (#57)."""

from __future__ import annotations

from datetime import date

from fastapi.testclient import TestClient

from app.core import years
from app.core.config import get_settings
from app.graph import intent
from app.main import app

client = TestClient(app)


def test_the_year_of_assessment_turns_over_on_1_april():
    assert years.ya_containing(date(2027, 3, 31)) == "2026/2027"
    assert years.ya_containing(date(2027, 4, 1)) == "2027/2028"


def test_current_year_is_held_to_the_supported_range():
    assert years.current(date(2026, 10, 7)) == "2026/2027"
    # After 1 April 2027 with 2027/2028 not yet configured, the newest stays current.
    assert years.current(date(2027, 5, 1)) == "2026/2027"
    assert years.current(date(2020, 1, 1)) == "2025/2026"


def test_adding_a_year_is_a_config_change(monkeypatch):
    """The rollover: one setting moves the prompt, the clarify question and the API."""
    settings = get_settings()
    monkeypatch.setattr(settings, "supported_yas", ("2025/2026", "2026/2027", "2027/2028"))
    assert years.current(date(2027, 5, 1)) == "2027/2028"
    prompt = intent.system_prompt(date(2027, 5, 1))
    assert "today is in Y/A 2027/2028" in prompt
    assert '"last year" means 2026/2027' in prompt
    assert "2025/2026, 2026/2027 or 2027/2028" in prompt
    assert client.get("/v1/years").json()["supported"][-1] == "2027/2028"


def test_the_prompt_today_matches_the_old_wording():
    prompt = intent.system_prompt(date(2026, 10, 7))
    assert "it is 2025/2026 or 2026/2027" in prompt
    assert "today is in Y/A 2026/2027" in prompt
    assert '"last year" means 2025/2026' in prompt
    assert "{" not in prompt.split("RULE_KEYS")[0]


def test_unsupported_years_are_a_plain_400():
    for path in ("/v1/deadlines", "/v1/rules/relief.personal"):
        r = client.get(path, params={"ya": "2030/2031"})
        assert r.status_code == 400 and "not supported" in r.json()["detail"], path
    assert client.get("/v1/years").json()["supported"] == ["2025/2026", "2026/2027"]
