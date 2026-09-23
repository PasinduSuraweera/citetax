"""Conversations: list, open, rename, delete.

There is no create and no post-a-message route here. A conversation is
created by its first question and grows by further questions, all through
/v1/ask, which stays the only place an answer is produced.

Every route needs a signed in user and sees only that user's conversations.
A conversation that does not exist and one that belongs to someone else get
the same 404, so an id alone reveals nothing.
"""

from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Response

from app.conversations import store, titles
from app.core.auth import CurrentUserDep
from app.db.session import db_conn
from app.routers.schemas import RenameConversationRequest

router = APIRouter(prefix="/v1/conversations", tags=["conversations"])

_NOT_FOUND = "Conversation not found"


@router.get("")
def list_conversations(
    user: CurrentUserDep,
    limit: int = Query(20, ge=1, le=50),
    cursor: str | None = Query(None, max_length=512),
) -> dict[str, Any]:
    """The sidebar: your conversations, most recently active first. Pass the
    returned next_cursor to get the next page."""
    with db_conn() as conn:
        try:
            return store.list_conversations(conn, user.id, limit, cursor)
        except ValueError as exc:
            raise HTTPException(400, "Invalid cursor") from exc


@router.get("/{conversation_id}")
def get_conversation(
    conversation_id: uuid.UUID,
    user: CurrentUserDep,
    turns: int = Query(10, ge=1, le=25),
    before_seq: int | None = Query(None, ge=1),
) -> dict[str, Any]:
    """The newest turns of one conversation, oldest first, each answer exactly
    as it was given and stamped with its snapshot. Pass the returned
    before_seq to load the turns before them."""
    with db_conn() as conn:
        page = store.load_thread(conn, user.id, str(conversation_id), turns, before_seq)
    if page is None:
        raise HTTPException(404, _NOT_FOUND)
    return page


@router.patch("/{conversation_id}")
def rename_conversation(
    conversation_id: uuid.UUID,
    body: RenameConversationRequest,
    user: CurrentUserDep,
) -> dict[str, Any]:
    title = titles.clean_rename(body.title)
    if not title:
        raise HTTPException(422, "The title cannot be empty")
    with db_conn() as conn:
        row = store.rename(conn, user.id, str(conversation_id), title)
    if row is None:
        raise HTTPException(404, _NOT_FOUND)
    return row


@router.delete("/{conversation_id}", status_code=204)
def delete_conversation(conversation_id: uuid.UUID, user: CurrentUserDep) -> Response:
    """Permanent. The conversation and its messages go; the runs behind its
    answers stay in History as the audit record."""
    with db_conn() as conn:
        deleted = store.delete(conn, user.id, str(conversation_id))
    if not deleted:
        raise HTTPException(404, _NOT_FOUND)
    return Response(status_code=204)
