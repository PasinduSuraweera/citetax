"""Endpoints for the platform, not for people.

On Cloud Run the API scales down between requests, so the corpus agent cannot
rely on a timer inside the process. Cloud Scheduler calls this endpoint on a
schedule instead, with a shared token in a header. Without CRON_TOKEN set the
endpoint refuses every call.
"""

from __future__ import annotations

import hmac
from typing import Annotated, Any

from fastapi import APIRouter, Header, HTTPException

from app.core.config import get_settings

router = APIRouter(prefix="/internal")


@router.post("/agent/run")
def scheduled_agent_run(x_cron_token: Annotated[str | None, Header()] = None) -> dict[str, Any]:
    token = get_settings().cron_token
    if not token or not x_cron_token or not hmac.compare_digest(token, x_cron_token):
        raise HTTPException(403, "Not allowed")
    from app.corpus import scheduler

    return scheduler.run_cycle(trigger="cloud-scheduler").to_json()
