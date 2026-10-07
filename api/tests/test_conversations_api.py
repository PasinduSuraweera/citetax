"""Conversations end to end through the API, against the real database.

The tax pipeline is replaced by a stand in that runs the real engine on fixed
rules, so these tests cost no model tokens and are deterministic. Everything
else is real: routes, auth, SQL, ownership checks, the envelope, pagination.

They need DATABASE_URL, AUTH_SECRET and a published snapshot. Each test makes
its own throwaway users and removes them, their conversations, their runs
and their audit rows afterwards.
"""

from __future__ import annotations

import json
import time
import uuid
from decimal import Decimal

import jwt
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.compute.engine import compute
from app.compute.types import TaxFacts
from app.core.config import get_settings
from app.db.session import db_conn
from app.graph.answer import PLANS, AnswerResult, TraceEntry
from app.graph.verify import BadgeState, VerifyResult
from app.main import app
from app.privacy.redactor import CodedRedactor
from app.routers import public as public_mod
from app.rules.resolver import ResolvedRuleSet, RuleVersion, current_snapshot

pytestmark = pytest.mark.db

# Not entered as a context manager, so the corpus agent's scheduler in the
# app lifespan does not start.
client = TestClient(app)

_VALUES = {
    "income.assessable":      {"includes": ["employment"]},
    "deduction.epf_employee": {"employee_rate": "0.08"},
    "deduction.qualifying":   {"annual_cap": None},
    "relief.personal":        {"amount": "1800000"},
    "charge.taxable_income":  {"formula": "a-d-r"},
    "band.progressive":       {"bands": [
        {"upto": 1000000, "rate": "0.06"}, {"upto": 1500000, "rate": "0.18"},
        {"upto": 2000000, "rate": "0.24"}, {"upto": 2500000, "rate": "0.30"},
        {"upto": None, "rate": "0.36"},
    ]},
    "credit.foreign_wht":     {"allowed": True},
    "credit.apit":            {"allowed": True},
}
RULE_IDS = {k: str(uuid.uuid4()) for k in _VALUES}
_REDACT = CodedRedactor(use_ner=False)


def _rules(snapshot_id: str) -> ResolvedRuleSet:
    from datetime import date

    rs = ResolvedRuleSet(ya="2026/2027", snapshot_id=snapshot_id)
    for k, v in _VALUES.items():
        rs.rules[k] = RuleVersion(
            id=RULE_IDS[k], rule_key=k, revision_no=1, value_json=v,
            effective_from=date(2025, 4, 1), effective_to=None,
            citation_label=f"cite-{k}", quoted_text="…",
        )
    return rs


def _base(question: str, kind: str, intent: str) -> AnswerResult:
    r = AnswerResult(kind=kind, intent=intent, plan=list(PLANS[intent]), route_source="llm")
    # What Intake does: only the redacted text travels or is stored.
    r.redacted_question = _REDACT.redact(question).text
    r.trace = [TraceEntry(node="Route", status="ok", detail=f"{intent} via llm")]
    return r


def compute_answer(conn, question, facts_override, snapshot):
    r = _base(question, "answer", "compute")
    facts = facts_override or TaxFacts(ya="2026/2027", employment_income=Decimal("5000000"))
    r.facts, r.ya = facts, facts.ya
    r.snapshot = {"id": str(snapshot["id"]), "label": snapshot["label"],
                  "changelog": snapshot.get("changelog")}
    r.rules = _rules(r.snapshot["id"])
    r.computation = compute(facts, r.rules)
    r.prose = "The balance comes from the ledger."
    r.verify_result = VerifyResult(badge=BadgeState.ALL_CITED, ok=True, checked_numbers=3)
    return r


def refusal_answer(conn, question, facts_override, snapshot):
    r = _base(question, "refusal", "out_of_scope")
    r.badge = BadgeState.CANNOT_ANSWER
    r.refusal_reason = "Citetax covers personal income tax only."
    r.refusal_category = "VAT"
    return r


def clarify_answer(conn, question, facts_override, snapshot):
    r = _base(question, "clarify", "compute")
    r.facts = TaxFacts(ya="2026/2027")
    r.ya = "2026/2027"
    r.clarify_question = "What was your total income for the year?"
    return r


@pytest.fixture
def pipeline(monkeypatch):
    """Replaces run_answer_graph in the ask route and records every call."""
    state: dict = {"calls": [], "builder": compute_answer, "snapshot": None, "hook": None}

    def fake(conn, question, ya_override=None, facts_override=None, context=None,
             on_node=None, on_plan=None):
        state["calls"].append({"question": question, "facts_override": facts_override,
                               "context": context, "ya": ya_override})
        if state["hook"]:
            state["hook"]()
        snapshot = state["snapshot"] or current_snapshot(conn)
        assert snapshot is not None, "seed the corpus first"
        result = state["builder"](conn, question, facts_override, snapshot)
        # What the real graph reports to the streaming route as it runs.
        if on_plan is not None:
            on_plan(result.plan)
        if on_node is not None:
            for entry in result.trace:
                on_node(entry)
        return result

    monkeypatch.setattr(public_mod, "run_answer_graph", fake)
    return state


@pytest.fixture
def users():
    """Signed in test users. Returns a factory of auth headers."""
    emails: list[str] = []

    def make(label: str) -> dict[str, str]:
        email = f"conv-test-{label}-{uuid.uuid4().hex[:10]}@example.invalid"
        token = jwt.encode(
            {"email": email, "name": f"Test {label}", "exp": int(time.time()) + 3600},
            get_settings().auth_secret, algorithm="HS256",
        )
        headers = {"Authorization": f"Bearer {token}"}
        # First authenticated call creates the app_user row.
        assert client.get("/v1/conversations", headers=headers).status_code == 200
        emails.append(email)
        return headers

    yield make

    with db_conn() as conn:
        ids = conn.execute(
            text("select id from app_user where email = any(:e)"), {"e": emails}
        ).scalars().all()
        if ids:
            conn.execute(text("delete from conversation where user_id = any(:u)"), {"u": ids})
            conn.execute(text("delete from computation_run where user_id = any(:u)"), {"u": ids})
            conn.execute(text("delete from review_event where actor = any(:a)"),
                         {"a": [str(i) for i in ids]})
            conn.execute(text("delete from app_user where id = any(:u)"), {"u": ids})
        conn.commit()


def ask(headers, question="How much tax do I pay on LKR 5 million?", **extra):
    body = {"question": question, "ya": "2026/2027", **{k: v for k, v in extra.items() if v}}
    return client.post("/v1/ask", json=body, headers=headers or {})


def thread(headers, cid, **params):
    return client.get(f"/v1/conversations/{cid}", headers=headers, params=params)


def _count(sql: str, **params) -> int:
    with db_conn() as conn:
        return conn.execute(text(sql), params).scalar()


# ---------------------------------------------------------------------------
# Anonymous behaviour is unchanged
# ---------------------------------------------------------------------------

def test_anonymous_question_starts_no_conversation(pipeline):
    r = ask(None)
    assert r.status_code == 200
    body = r.json()
    assert "conversation_id" not in body and "message_persisted" not in body
    assert pipeline["calls"][0]["context"] is None
    # The anonymous run is still recorded, as before.
    run_id = body["run_id"]
    assert run_id
    with db_conn() as conn:
        conn.execute(text("delete from computation_run where id = :id"), {"id": run_id})
        conn.commit()


def test_conversation_id_without_a_valid_token_is_refused(pipeline):
    cid = str(uuid.uuid4())
    assert ask(None, conversation_id=cid).status_code == 401
    assert ask({"Authorization": "Bearer not-a-token"}, conversation_id=cid).status_code == 401
    assert pipeline["calls"] == []


def test_conversation_routes_need_sign_in():
    assert client.get("/v1/conversations").status_code == 401
    assert client.get(f"/v1/conversations/{uuid.uuid4()}").status_code == 401


# ---------------------------------------------------------------------------
# Creating, continuing, reading
# ---------------------------------------------------------------------------

def test_first_question_creates_a_conversation(pipeline, users):
    a = users("a")
    body = ask(a, "My NIC is 199012345678. How much tax do I pay on LKR 5 million?").json()

    assert body["message_persisted"] is True
    assert body["conversation_created"] is True
    cid = body["conversation_id"]
    assert body["conversation"]["title"] == "Tax on employment income · 2026/27"
    # The stored question is the redacted one, and that is what comes back.
    assert "199012345678" not in body["user_message"]
    assert "<NIC>" in body["user_message"]

    listed = client.get("/v1/conversations", headers=a).json()
    assert [c["id"] for c in listed["conversations"]] == [cid]

    page = thread(a, cid).json()
    assert page["has_more"] is False
    (turn,) = page["turns"]
    assert turn["question"]["content"] == body["user_message"]
    stored = turn["reply"]["answer"]
    # Rebuilt from the run, exactly as it was returned.
    assert stored["computation"] == body["computation"]
    assert stored["explanation"] == body["explanation"]
    assert stored["citations"] == body["citations"]
    assert stored["run_id"] == body["run_id"]
    assert stored["snapshot"]["id"] == body["snapshot"]["id"]
    assert stored["snapshot_is_current"] is True
    assert stored["reaskable"] is True

    with db_conn() as conn:
        raw = conn.execute(
            text("select content from conversation_message where conversation_id = :c"),
            {"c": cid},
        ).scalars().all()
        rv_ids = conn.execute(
            text("select rule_version_ids from computation_run where id = :r"),
            {"r": body["run_id"]},
        ).scalar_one()
    assert all("199012345678" not in c for c in raw)
    assert {str(i) for i in rv_ids} == set(RULE_IDS.values())


def test_follow_up_continues_the_same_conversation_with_bounded_context(pipeline, users):
    a = users("a")
    first = ask(a).json()
    cid = first["conversation_id"]
    other = ask(a, "When is my return due?").json()["conversation_id"]

    follow = ask(a, "What if I also earn LKR 500,000 from freelance work?",
                 conversation_id=cid).json()
    assert follow["conversation_id"] == cid
    assert follow["conversation_created"] is False

    ctx = pipeline["calls"][-1]["context"]
    assert ctx.questions == ("How much tax do I pay on LKR 5 million?",)
    assert ctx.facts == {"employment_income": Decimal("5000000.00")}
    assert ctx.facts_run_id == first["run_id"]
    assert ctx.ya == "2026/2027"
    assert "The balance comes from the ledger" not in ctx.prompt_block()

    # The continued chat moves to the top of Recent; the other one is intact.
    order = [c["id"] for c in client.get("/v1/conversations", headers=a).json()["conversations"]]
    assert order == [cid, other]

    turns = thread(a, cid).json()["turns"]
    assert [t["seq"] for t in turns] == [1, 3]
    assert turns[1]["question"]["content"].startswith("What if I also earn")


def test_refusal_and_clarify_turns_are_kept_without_a_run(pipeline, users):
    a = users("a")
    pipeline["builder"] = refusal_answer
    body = ask(a, "What is the VAT rate?").json()
    cid = body["conversation_id"]
    assert "run_id" not in body
    pipeline["builder"] = clarify_answer
    ask(a, "What do I owe?", conversation_id=cid)

    turns = thread(a, cid).json()["turns"]
    refusal, clarify = (t["reply"] for t in turns)
    assert refusal["kind"] == "refusal"
    assert refusal["answer"]["refusal"]["reason"].startswith("Citetax covers")
    assert refusal["answer"]["reaskable"] is False
    assert clarify["kind"] == "clarify"
    assert clarify["answer"]["clarify"]["question"].startswith("What was your total income")
    # A refused turn never feeds the next question's context.
    pipeline["builder"] = compute_answer
    ask(a, "LKR 3,000,000", conversation_id=cid)
    ctx = pipeline["calls"][-1]["context"]
    assert ctx.questions == ("What do I owe?",)
    assert ctx.pending_clarify.startswith("What was your total income")


def test_turn_survives_a_new_client_and_session(pipeline, users):
    """Nothing lives in the client: a second token for the same account (a
    new browser, a new device) reads the same thread from PostgreSQL."""
    a = users("a")
    cid = ask(a).json()["conversation_id"]
    email = jwt.decode(a["Authorization"].split()[1], options={"verify_signature": False})["email"]
    again = {"Authorization": "Bearer " + jwt.encode(
        {"email": email, "exp": int(time.time()) + 600}, get_settings().auth_secret,
        algorithm="HS256")}
    assert [t["seq"] for t in thread(again, cid).json()["turns"]] == [1]


# ---------------------------------------------------------------------------
# Ownership
# ---------------------------------------------------------------------------

def test_no_cross_user_access(pipeline, users):
    a, b = users("a"), users("b")
    first = ask(a).json()
    cid, msg = first["conversation_id"], first["message_id"]
    calls_before = len(pipeline["calls"])

    missing = thread(b, str(uuid.uuid4()))
    foreign = thread(b, cid)
    assert foreign.status_code == missing.status_code == 404
    assert foreign.json() == missing.json()

    assert client.patch(f"/v1/conversations/{cid}", json={"title": "mine"}, headers=b).status_code == 404
    assert client.delete(f"/v1/conversations/{cid}", headers=b).status_code == 404
    assert ask(b, "And for me?", conversation_id=cid).status_code == 404
    assert ask(b, "again", conversation_id=cid, reask_message_id=msg).status_code == 404
    # Nothing ran for any of those.
    assert len(pipeline["calls"]) == calls_before
    assert client.get("/v1/conversations", headers=b).json()["conversations"] == []

    # A's conversation is exactly as it was.
    page = thread(a, cid).json()
    assert page["conversation"]["title"] == first["conversation"]["title"]
    assert len(page["turns"]) == 1


def test_malformed_ids_are_rejected_before_any_query(users):
    a = users("a")
    assert thread(a, "not-a-uuid").status_code == 422
    assert client.delete("/v1/conversations/not-a-uuid", headers=a).status_code == 422
    assert ask(a, conversation_id="not-a-uuid").status_code == 422


# ---------------------------------------------------------------------------
# Rename and delete
# ---------------------------------------------------------------------------

def test_rename_strips_identifiers_and_does_not_reorder(pipeline, users):
    a = users("a")
    older = ask(a).json()["conversation_id"]
    newer = ask(a, "When is my return due?").json()["conversation_id"]

    r = client.patch(f"/v1/conversations/{older}",
                     json={"title": "  Salary chat for me@example.com  "}, headers=a)
    assert r.status_code == 200
    assert r.json()["title"] == "Salary chat for <EMAIL>"
    order = [c["id"] for c in client.get("/v1/conversations", headers=a).json()["conversations"]]
    assert order == [newer, older]

    assert client.patch(f"/v1/conversations/{older}", json={"title": "   "},
                        headers=a).status_code == 422


def test_delete_removes_the_thread_keeps_the_runs_and_audits_without_content(pipeline, users):
    a = users("a")
    body = ask(a).json()
    cid, run_id = body["conversation_id"], body["run_id"]
    ask(a, "What if I also earn LKR 500,000 from freelance work?", conversation_id=cid)

    assert client.delete(f"/v1/conversations/{cid}", headers=a).status_code == 204
    assert thread(a, cid).status_code == 404
    assert client.delete(f"/v1/conversations/{cid}", headers=a).status_code == 404
    assert _count("select count(*) from conversation_message where conversation_id = :c", c=cid) == 0
    # The run is the audit record and History still has it.
    assert _count("select count(*) from computation_run where id = :r", r=run_id) == 1
    history = client.get("/v1/history", headers=a).json()["runs"]
    assert run_id in [h["id"] for h in history]

    with db_conn() as conn:
        event = conn.execute(
            text("select action, before_json, after_json from review_event "
                 " where target_type = 'conversation' and target_id = :c"),
            {"c": cid},
        ).mappings().one()
    assert event["action"] == "conversation.delete"
    assert event["before_json"] == {"messages": 4}
    assert event["after_json"] is None


def test_question_running_while_its_conversation_is_deleted(pipeline, users):
    a = users("a")
    cid = ask(a).json()["conversation_id"]
    pipeline["hook"] = lambda: client.delete(f"/v1/conversations/{cid}", headers=a)
    body = ask(a, "What about EPF?", conversation_id=cid).json()
    # The answer still comes back; it just has nowhere to be saved.
    assert body["kind"] == "answer" and body["computation"]
    assert body["message_persisted"] is False
    assert body["conversation_id"] is None


# ---------------------------------------------------------------------------
# Pagination
# ---------------------------------------------------------------------------

def test_sidebar_pages_without_gaps_or_repeats(pipeline, users):
    a = users("a")
    made = [ask(a, f"Tax question {i} on LKR 5 million").json()["conversation_id"]
            for i in range(5)]

    seen: list[str] = []
    cursor = None
    for _ in range(5):
        params = {"limit": 2, **({"cursor": cursor} if cursor else {})}
        page = client.get("/v1/conversations", headers=a, params=params).json()
        seen += [c["id"] for c in page["conversations"]]
        cursor = page["next_cursor"]
        if not cursor:
            break
    assert seen == list(reversed(made))
    assert client.get("/v1/conversations", headers=a,
                      params={"cursor": "garbage!"}).status_code == 400
    assert client.get("/v1/conversations", headers=a,
                      params={"limit": 51}).status_code == 422


def test_thread_pages_by_whole_turns(pipeline, users):
    a = users("a")
    cid = ask(a, "Question one on LKR 5 million").json()["conversation_id"]
    for q in ("Question two on LKR 5 million", "Question three on LKR 5 million"):
        ask(a, q, conversation_id=cid)

    newest = thread(a, cid, turns=2).json()
    assert [t["question"]["content"] for t in newest["turns"]] == [
        "Question two on LKR 5 million", "Question three on LKR 5 million"]
    assert newest["has_more"] is True
    assert all(t["reply"] for t in newest["turns"])

    earlier = thread(a, cid, turns=2, before_seq=newest["before_seq"]).json()
    assert [t["question"]["content"] for t in earlier["turns"]] == [
        "Question one on LKR 5 million"]
    assert earlier["has_more"] is False


# ---------------------------------------------------------------------------
# Historical answers and asking again
# ---------------------------------------------------------------------------

@pytest.fixture
def old_snapshot():
    """A snapshot that is not current, standing in for law since superseded."""
    with db_conn() as conn:
        row = conn.execute(
            text("insert into corpus_snapshot (label, is_current, changelog) "
                 "values ('test: superseded snapshot', false, null) "
                 "returning id, label, changelog"),
        ).mappings().one()
        conn.commit()
    yield dict(row)
    with db_conn() as conn:
        conn.execute(text("delete from conversation_message where computation_run_id in "
                          "(select id from computation_run where corpus_snapshot_id = :s)"),
                     {"s": row["id"]})
        conn.execute(text("delete from computation_run where corpus_snapshot_id = :s"),
                     {"s": row["id"]})
        conn.execute(text("delete from corpus_snapshot where id = :s"), {"s": row["id"]})
        conn.commit()


def test_old_answer_is_shown_as_given_and_asked_again_as_a_new_turn(
    pipeline, users, old_snapshot, monkeypatch,
):
    a = users("a")
    pipeline["snapshot"] = old_snapshot
    first = ask(a, "How much tax do I pay on LKR 5 million?").json()
    cid, old_msg, old_run = first["conversation_id"], first["message_id"], first["run_id"]
    pipeline["snapshot"] = None

    # Opening the thread must not run the pipeline, resolve or compute.
    import app.compute.engine as engine
    import app.rules.resolver as resolver

    def forbidden(*_a, **_k):
        raise AssertionError("an old answer was recomputed")

    with monkeypatch.context() as m:
        m.setattr(resolver, "resolve_many", forbidden)
        m.setattr(engine, "compute", forbidden)
        m.setattr(public_mod, "run_answer_graph", forbidden)
        (turn,) = thread(a, cid).json()["turns"]
    old = turn["reply"]["answer"]
    assert old["snapshot"]["label"] == "test: superseded snapshot"
    assert old["snapshot_is_current"] is False
    assert old["computation"] == first["computation"]

    again = ask(a, "ignored by the server", conversation_id=cid,
                reask_message_id=old_msg).json()
    call = pipeline["calls"][-1]
    # The stored question and the stored facts, not the client's text.
    assert call["question"] == "How much tax do I pay on LKR 5 million?"
    assert call["facts_override"].employment_income == Decimal("5000000.00")
    assert call["context"].questions == ()
    assert again["run_id"] != old_run
    assert again["snapshot"]["id"] != str(old_snapshot["id"])

    turns = thread(a, cid).json()["turns"]
    assert len(turns) == 2
    assert turns[0]["reply"]["answer"]["run_id"] == old_run
    assert turns[0]["reply"]["answer"]["snapshot_is_current"] is False
    assert turns[1]["reply"]["answer"]["snapshot_is_current"] is True

    # A message that is not an answer with a run cannot be asked again.
    assert ask(a, "x", conversation_id=cid,
               reask_message_id=turns[0]["question"]["id"]).status_code == 404
    assert ask(a, "x", reask_message_id=old_msg).status_code == 422


# ---------------------------------------------------------------------------
# Streaming
# ---------------------------------------------------------------------------

def ask_stream(headers, question="How much tax do I pay on LKR 5 million?", **extra):
    body = {"question": question, "ya": "2026/2027", **{k: v for k, v in extra.items() if v}}
    with client.stream("POST", "/v1/ask/stream", json=body, headers=headers or {}) as r:
        assert r.status_code == 200
        assert r.headers["content-type"].startswith("application/x-ndjson")
        return [json.loads(line) for line in r.iter_lines() if line]


def test_stream_sends_plan_steps_then_the_saved_turn(pipeline, users):
    a = users("a")
    events = ask_stream(a)

    assert [e["type"] for e in events] == ["plan", "step", "done"]
    assert events[0]["plan"] == PLANS["compute"]
    assert events[1]["node"] == "Route"
    done = events[-1]["payload"]
    assert done["kind"] == "answer" and done["message_persisted"] is True
    cid = done["conversation_id"]

    # A follow-up over the stream lands in the same conversation.
    follow = ask_stream(a, "What about EPF?", conversation_id=cid)[-1]["payload"]
    assert follow["conversation_id"] == cid and follow["seq"] == 3


def test_stream_reports_a_missing_conversation_as_an_error_event(pipeline, users):
    a = users("a")
    events = ask_stream(a, conversation_id=str(uuid.uuid4()))
    assert events == [{"type": "error", "status": 404, "message": "Conversation not found"}]
    assert pipeline["calls"] == []


# ---------------------------------------------------------------------------
# Removing answers from history
# ---------------------------------------------------------------------------

def _history_ids(headers) -> list[str]:
    return [r["id"] for r in client.get("/v1/history", headers=headers).json()["runs"]]


def _drop_runs(ids: list[str]) -> None:
    # Detached runs no longer belong to the test user, so the fixture's
    # cleanup cannot find them; remove them here.
    with db_conn() as conn:
        conn.execute(text("delete from conversation_message where computation_run_id = any(cast(:ids as uuid[]))"), {"ids": ids})
        conn.execute(text("delete from computation_run where id = any(cast(:ids as uuid[]))"), {"ids": ids})
        conn.commit()


def test_one_answer_can_be_removed_and_is_kept_for_audit(pipeline, users):
    a = users("a")
    first = ask(a).json()["run_id"]
    second = ask(a, "What about EPF?").json()["run_id"]
    try:
        assert client.delete(f"/v1/history/{first}", headers=a).status_code == 204
        assert _history_ids(a) == [second]
        # Gone from the account, still there as an anonymous record.
        assert _count("select count(*) from computation_run where id = :id and user_id is null", id=first) == 1
        assert client.get(f"/v1/history/{first}", headers=a).status_code == 404
        assert client.delete(f"/v1/history/{first}", headers=a).status_code == 404
    finally:
        _drop_runs([first])


def test_history_can_be_cleared_and_chats_stay(pipeline, users):
    a = users("a")
    body = ask(a).json()
    runs = [body["run_id"], ask(a, "And with EPF?", conversation_id=body["conversation_id"]).json()["run_id"]]
    try:
        r = client.delete("/v1/history", headers=a)
        assert r.status_code == 200 and r.json() == {"removed": 2}
        assert _history_ids(a) == []
        # The chat is separate and keeps its answers.
        assert len(thread(a, body["conversation_id"]).json()["turns"]) == 2
    finally:
        _drop_runs(runs)


def test_someone_elses_answer_cannot_be_removed(pipeline, users):
    a, b = users("a"), users("b")
    run = ask(a).json()["run_id"]
    assert client.delete(f"/v1/history/{run}", headers=b).status_code == 404
    assert client.delete("/v1/history/not-a-uuid", headers=b).status_code == 404
    assert client.delete(f"/v1/history/{run}").status_code == 401
    assert _history_ids(a) == [run]
