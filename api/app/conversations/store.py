"""Every conversation read and write, and nothing else.

Rules this module keeps:

  - Every statement matches the conversation id AND the user id. A
    conversation id alone never finds anything, so someone else's id behaves
    exactly like one that does not exist.
  - PostgreSQL is the store of record. Writes commit here, and only after the
    commit is conversation_changed() called.
  - Reads never compute. An old answer is rebuilt from what was stored with
    it, through envelope.rehydrate.

Reads go through list_conversations and load_thread; writes through
append_turn, rename and delete. That is the seam a read cache would sit
behind if one is ever added (see conversation_changed).
"""

from __future__ import annotations

import base64
import binascii
import json
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import text
from sqlalchemy.engine import Connection

from app.conversations import envelope
from app.conversations.context import WINDOW_MESSAGES, ContextRow


class ConversationNotFound(Exception):
    """No such conversation for this user: never existed, deleted, or owned
    by someone else. Callers answer all three the same way."""


def conversation_changed(user_id: str) -> None:
    """Called after every committed write that changes what this user's
    conversation reads return.

    PostgreSQL is the only store today, so there is nothing to invalidate. A
    read cache added later keeps a per-user generation number in its keys and
    increments it here, which makes every cached page for the user unreachable
    in one call. It must never be called before the commit, and a failure in
    it must never undo or fail the write.
    """
    return None


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


def _summary(row) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "title": row["title"],
        "created_at": _iso(row["created_at"]),
        "updated_at": _iso(row["updated_at"]),
    }


# ---------------------------------------------------------------------------
# Sidebar
# ---------------------------------------------------------------------------

def encode_cursor(updated_at: str, conversation_id: str) -> str:
    raw = json.dumps({"u": updated_at, "i": conversation_id}).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def decode_cursor(cursor: str) -> tuple[str, str]:
    """Raises ValueError on anything that is not a cursor this API issued."""
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        data = json.loads(base64.urlsafe_b64decode(padded.encode()))
        updated_at = datetime.fromisoformat(data["u"]).isoformat()
        conversation_id = str(uuid.UUID(data["i"]))
    except (binascii.Error, json.JSONDecodeError, KeyError, TypeError, ValueError) as exc:
        raise ValueError("invalid cursor") from exc
    return updated_at, conversation_id


def list_conversations(
    conn: Connection, user_id: str, limit: int, cursor: str | None = None
) -> dict[str, Any]:
    """One page of the user's conversations, most recently active first.

    Keyset pagination on (updated_at, id): a chat that moves to the top while
    someone is paging cannot make a later page skip or repeat a row it had
    already passed.
    """
    params: dict[str, Any] = {"uid": user_id, "lim": limit + 1}
    after = ""
    if cursor:
        params["ts"], params["cid"] = decode_cursor(cursor)
        after = (
            " and (updated_at, id) < "
            "(cast(:ts as timestamptz), cast(:cid as uuid))"
        )
    rows = conn.execute(
        text(
            "select id, title, created_at, updated_at from conversation "
            " where user_id = :uid" + after +
            " order by updated_at desc, id desc limit :lim"
        ),
        params,
    ).mappings().all()

    items = [_summary(r) for r in rows[:limit]]
    next_cursor = None
    if len(rows) > limit and items:
        last = items[-1]
        next_cursor = encode_cursor(last["updated_at"], last["id"])
    return {"conversations": items, "next_cursor": next_cursor}


# ---------------------------------------------------------------------------
# Thread
# ---------------------------------------------------------------------------

_THREAD_SQL = (
    "select m.id, m.seq, m.role, m.kind, m.content, m.response_json, "
    "       m.created_at, "
    "       r.id as run_id, r.ya, r.ledger_json, r.answer_text, "
    "       r.verify_result, r.llm_usage, r.corpus_snapshot_id, "
    "       s.label as snapshot_label, s.changelog as snapshot_changelog "
    "  from conversation c "
    "  join conversation_message m on m.conversation_id = c.id "
    "  left join computation_run r on r.id = m.computation_run_id "
    "  left join corpus_snapshot s on s.id = r.corpus_snapshot_id "
    " where c.id = :cid and c.user_id = :uid{before} "
    " order by m.seq desc limit :lim"
)


def load_thread(
    conn: Connection,
    user_id: str,
    conversation_id: str,
    turns: int,
    before_seq: int | None = None,
) -> dict[str, Any] | None:
    """The newest `turns` turns before `before_seq`, oldest first.

    Pages are whole turns: a turn is always two messages written together,
    so a page of 2n messages that ends before a question starts on one.
    Returns None when the user has no such conversation.
    """
    meta = conn.execute(
        text(
            "select c.id, c.title, c.created_at, c.updated_at, "
            "       (select id from corpus_snapshot where is_current limit 1) "
            "         as current_snapshot_id "
            "  from conversation c where c.id = :cid and c.user_id = :uid"
        ),
        {"cid": conversation_id, "uid": user_id},
    ).mappings().first()
    if meta is None:
        return None
    current_id = str(meta["current_snapshot_id"]) if meta["current_snapshot_id"] else None

    params: dict[str, Any] = {"cid": conversation_id, "uid": user_id, "lim": turns * 2 + 1}
    before = ""
    if before_seq is not None:
        params["before"] = before_seq
        before = " and m.seq < :before"
    rows = conn.execute(text(_THREAD_SQL.format(before=before)), params).mappings().all()

    has_more = len(rows) > turns * 2
    rows = sorted(rows[: turns * 2], key=lambda r: r["seq"])

    by_seq = {r["seq"]: r for r in rows}
    out_turns: list[dict[str, Any]] = []
    for r in rows:
        if r["role"] != "user":
            continue
        reply = by_seq.get(r["seq"] + 1)
        assistant = None
        if reply is not None and reply["role"] == "assistant":
            run = dict(reply) if reply["run_id"] else None
            if run is not None:
                run["id"] = reply["run_id"]
            assistant = {
                "id": str(reply["id"]),
                "seq": reply["seq"],
                "kind": reply["kind"],
                "created_at": _iso(reply["created_at"]),
                "answer": envelope.rehydrate(dict(reply), run, current_id),
            }
        out_turns.append(
            {
                "seq": r["seq"],
                "question": {
                    "id": str(r["id"]),
                    "content": r["content"],
                    "created_at": _iso(r["created_at"]),
                },
                "reply": assistant,
            }
        )

    return {
        "conversation": _summary(meta),
        "turns": out_turns,
        "has_more": has_more,
        "before_seq": out_turns[0]["seq"] if (has_more and out_turns) else None,
        "current_snapshot_id": current_id,
    }


# ---------------------------------------------------------------------------
# Context for the next turn
# ---------------------------------------------------------------------------

def context_rows(
    conn: Connection,
    user_id: str,
    conversation_id: str,
    before_seq: int | None = None,
) -> list[ContextRow] | None:
    """The newest WINDOW_MESSAGES messages with what their runs recorded.

    One query does the ownership check and the read. The window is fixed, so
    this costs the same for a thread of four messages or four hundred.
    Returns None when the user has no such conversation.
    """
    before = " and seq < :before" if before_seq is not None else ""
    params: dict[str, Any] = {"cid": conversation_id, "uid": user_id, "win": WINDOW_MESSAGES}
    if before_seq is not None:
        params["before"] = before_seq
    rows = conn.execute(
        text(
            "select m.seq, m.role, m.kind, m.content, "
            "       m.response_json ->> 'intent' as env_intent, "
            "       m.response_json ->> 'ya' as env_ya, "
            "       r.id as run_id, r.intent as run_intent, r.ya as run_ya, "
            "       r.facts_redacted_json "
            "  from conversation c "
            "  left join lateral ( "
            "        select * from conversation_message "
            "         where conversation_id = c.id" + before +
            "         order by seq desc limit :win) m on true "
            "  left join computation_run r on r.id = m.computation_run_id "
            " where c.id = :cid and c.user_id = :uid"
        ),
        params,
    ).mappings().all()
    if not rows:
        return None
    return [
        ContextRow(
            seq=r["seq"],
            role=r["role"],
            kind=r["kind"],
            content=r["content"] or "",
            intent=r["run_intent"] or r["env_intent"],
            ya=r["run_ya"] or r["env_ya"],
            facts=r["facts_redacted_json"],
            run_id=str(r["run_id"]) if r["run_id"] else None,
        )
        for r in rows
        if r["seq"] is not None
    ]


@dataclass(frozen=True)
class ReaskSource:
    question: str
    question_seq: int
    facts: dict[str, Any]
    run_id: str


def reask_source(
    conn: Connection, user_id: str, conversation_id: str, message_id: str
) -> ReaskSource | None:
    """The question and stored facts behind an answered turn, for asking it
    again against the current snapshot. None unless the message is an answer
    with a run, in a conversation this user owns."""
    row = conn.execute(
        text(
            "select q.content as question, q.seq as question_seq, "
            "       r.facts_redacted_json as facts, r.id as run_id "
            "  from conversation c "
            "  join conversation_message a on a.conversation_id = c.id "
            "  join conversation_message q on q.conversation_id = c.id "
            "        and q.seq = a.seq - 1 and q.role = 'user' "
            "  join computation_run r on r.id = a.computation_run_id "
            " where c.id = :cid and c.user_id = :uid and a.id = :mid "
            "   and a.role = 'assistant' and a.kind = 'answer'"
        ),
        {"cid": conversation_id, "uid": user_id, "mid": message_id},
    ).mappings().first()
    if row is None:
        return None
    return ReaskSource(
        question=row["question"],
        question_seq=row["question_seq"],
        facts=row["facts"] or {},
        run_id=str(row["run_id"]),
    )


# ---------------------------------------------------------------------------
# Writes
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class AppendedTurn:
    conversation: dict[str, Any]
    created: bool
    question_id: str
    reply_id: str
    seq: int


def append_turn(
    conn: Connection,
    user_id: str,
    conversation_id: str | None,
    *,
    title: str,
    question: str,
    kind: str,
    content: str,
    run_id: str | None,
    response_json: dict[str, Any],
) -> AppendedTurn:
    """Add one question and its reply, creating the conversation on its
    first turn. One transaction; the conversation row is locked so two tabs
    posting at once cannot interleave their sequence numbers.

    Raises ConversationNotFound if the conversation is gone or not the
    user's, which includes one deleted while the question was running.
    """
    try:
        created = conversation_id is None
        if created:
            conv = conn.execute(
                text(
                    "insert into conversation (user_id, title) values (:uid, :t) "
                    "returning id, title, created_at, updated_at"
                ),
                {"uid": user_id, "t": title},
            ).mappings().one()
        else:
            conv = conn.execute(
                text(
                    "select id, title, created_at, updated_at from conversation "
                    " where id = :cid and user_id = :uid for update"
                ),
                {"cid": conversation_id, "uid": user_id},
            ).mappings().first()
            if conv is None:
                raise ConversationNotFound(conversation_id)

        cid = str(conv["id"])
        last = conn.execute(
            text(
                "select coalesce(max(seq), 0) from conversation_message "
                " where conversation_id = :cid"
            ),
            {"cid": cid},
        ).scalar_one()
        seq = int(last) + 1

        question_id = conn.execute(
            text(
                "insert into conversation_message (conversation_id, seq, role, content) "
                "values (:cid, :seq, 'user', :content) returning id"
            ),
            {"cid": cid, "seq": seq, "content": question},
        ).scalar_one()
        reply_id = conn.execute(
            text(
                "insert into conversation_message (conversation_id, seq, role, kind, "
                "content, computation_run_id, response_json) values "
                "(:cid, :seq, 'assistant', :kind, :content, :run, cast(:rj as jsonb)) "
                "returning id"
            ),
            {
                "cid": cid, "seq": seq + 1, "kind": kind, "content": content,
                "run": run_id, "rj": json.dumps(response_json, default=str),
            },
        ).scalar_one()

        touched = conn.execute(
            text(
                "update conversation set updated_at = now(), "
                # A chat that opened with "hi" takes the title of its first
                # real question.
                "  title = case when title = :placeholder and :t <> :placeholder "
                "               then :t else title end "
                " where id = :cid and user_id = :uid "
                "returning id, title, created_at, updated_at"
            ),
            {"cid": cid, "uid": user_id, "t": title, "placeholder": PLACEHOLDER_TITLE},
        ).mappings().one()
        conn.commit()
    except Exception:
        conn.rollback()
        raise

    conversation_changed(user_id)
    return AppendedTurn(
        conversation=_summary(touched),
        created=created,
        question_id=str(question_id),
        reply_id=str(reply_id),
        seq=seq,
    )


# The title of a chat that has had only greetings and the like so far.
PLACEHOLDER_TITLE = "New chat"


def rename(
    conn: Connection, user_id: str, conversation_id: str, title: str
) -> dict[str, Any] | None:
    row = conn.execute(
        text(
            "update conversation set title = :t "
            " where id = :cid and user_id = :uid "
            "returning id, title, created_at, updated_at"
        ),
        {"t": title, "cid": conversation_id, "uid": user_id},
    ).mappings().first()
    if row is None:
        conn.rollback()
        return None
    conn.commit()
    conversation_changed(user_id)
    return _summary(row)


def delete(conn: Connection, user_id: str, conversation_id: str) -> bool:
    """Permanently delete a conversation and its messages. The runs stay:
    they are the audit record. The audit log records that a deletion
    happened and how big it was, never what it said."""
    try:
        messages = conn.execute(
            text(
                "select count(m.id) from conversation c "
                "  left join conversation_message m on m.conversation_id = c.id "
                " where c.id = :cid and c.user_id = :uid group by c.id"
            ),
            {"cid": conversation_id, "uid": user_id},
        ).scalar()
        gone = conn.execute(
            text(
                "delete from conversation where id = :cid and user_id = :uid "
                "returning id"
            ),
            {"cid": conversation_id, "uid": user_id},
        ).first()
        if gone is None:
            conn.rollback()
            return False
        conn.execute(
            text(
                "insert into review_event (actor, action, target_type, target_id, "
                "before_json) values (:a, 'conversation.delete', 'conversation', "
                ":tid, cast(:b as jsonb))"
            ),
            {
                "a": user_id,
                "tid": conversation_id,
                "b": json.dumps({"messages": int(messages or 0)}),
            },
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise

    conversation_changed(user_id)
    return True
