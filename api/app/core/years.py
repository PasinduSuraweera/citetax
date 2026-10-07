"""Years of assessment: the one place that knows which are supported and which
one today falls in (#57).

The supported list lives in config (`SUPPORTED_YAS`). Everything else, the
router prompt, the clarify question, the golden set, the API and the web app,
reads it from here, so adding 2027/2028 is a config change plus the reviewer
signed rule versions for that year. A Sri Lankan year of assessment runs
1 April to 31 March, and "today" is read in Colombo time.
"""

from __future__ import annotations

import re
from datetime import date, datetime, timedelta, timezone

from app.core.config import get_settings

# Sri Lanka has no daylight saving: a fixed offset needs no tz database.
COLOMBO = timezone(timedelta(hours=5, minutes=30))


def supported() -> tuple[str, ...]:
    """Oldest first, as configured."""
    return tuple(sorted(get_settings().supported_yas))


def ya_containing(day: date) -> str:
    start = day.year if (day.month, day.day) >= (4, 1) else day.year - 1
    return f"{start}/{start + 1}"


def today_colombo() -> date:
    return datetime.now(COLOMBO).date()


def current(today: date | None = None) -> str:
    """The year of assessment today falls in, held to the supported range: past
    the newest supported year it is the newest, before the oldest the oldest."""
    years = supported()
    ya = ya_containing(today or today_colombo())
    if ya in years:
        return ya
    return years[-1] if ya > years[-1] else years[0]


def previous(ya: str) -> str | None:
    start = int(ya[:4])
    prior = f"{start - 1}/{start}"
    return prior if prior in supported() else None


_MENTION = re.compile(r"(?<!\d)(20\d{2})\s*[/-]\s*(?:20)?(\d{2})(?!\d)")


def mentioned(text: str) -> list[str]:
    """Years of assessment a text names ("2025/2026", "2025/26", "2025-26"),
    sorted. A bare "2025" is not counted: it is as often a date as a year of
    assessment."""
    found = set()
    for start, end in _MENTION.findall(text or ""):
        if int(end) == (int(start) + 1) % 100:
            found.add(f"{start}/{int(start) + 1}")
    return sorted(found)


def phrase(joiner: str = "or") -> str:
    """'2025/2026 or 2026/2027'; three years read '2025/2026, 2026/2027 or 2027/2028'."""
    years = list(supported())
    return years[0] if len(years) == 1 else f"{', '.join(years[:-1])} {joiner} {years[-1]}"
