"""The display record of an assistant message.

On save, the /v1/ask payload is split in two. What computation_run already
keeps authoritatively (the ledger, the verified explanation, the verify
result, the snapshot and the model usage) is left out and read back from the
run. The rest (trace, citations as shown, passages, filing card, comparison,
rule lookup) is what nothing else records, so it is kept here.

On read, the two halves are joined into the AnswerResponse shape the web app
already renders. Nothing is resolved or computed again: an old answer comes
back exactly as it was shown, stamped with the snapshot it ran against.
"""

from __future__ import annotations

from typing import Any

# Read from computation_run when the message has one.
RUN_FIELDS = ("computation", "explanation", "verify", "snapshot", "llm", "run_id")

# Never stored. Model usage is operational telemetry, not part of the answer,
# and the conversation fields describe the request, not the reply.
DROPPED_FIELDS = (
    "llm", "run_id", "conversation_id", "conversation", "message_id",
    "user_message", "message_persisted",
)


def split(payload: dict[str, Any], run_id: str | None) -> tuple[str, str, dict[str, Any]]:
    """(kind, content, response_json) for the assistant message."""
    kind = payload["kind"]
    if kind == "refusal":
        content = (payload.get("refusal") or {}).get("reason") or ""
    elif kind == "clarify":
        content = (payload.get("clarify") or {}).get("question") or ""
    else:
        # Verified prose only. Withheld prose is None and never stored.
        content = payload.get("explanation") or ""

    omit = set(DROPPED_FIELDS)
    if run_id:
        omit.update(RUN_FIELDS)
    envelope = {k: v for k, v in payload.items() if k not in omit}
    return kind, content, envelope


def rehydrate(
    message: dict[str, Any],
    run: dict[str, Any] | None,
    current_snapshot_id: str | None,
) -> dict[str, Any]:
    """The stored answer in the AnswerResponse shape, as it was shown."""
    answer: dict[str, Any] = dict(message.get("response_json") or {})
    answer["kind"] = message["kind"]

    if run is not None:
        ledger = run.get("ledger_json") or {}
        if ledger:
            answer["computation"] = ledger
        answer["explanation"] = run.get("answer_text")
        verify = run.get("verify_result") or None
        answer["verify"] = verify
        if verify and verify.get("badge"):
            answer["badge"] = verify["badge"]
        answer["snapshot"] = (
            {
                "id": str(run["corpus_snapshot_id"]),
                "label": run.get("snapshot_label"),
                "changelog": run.get("snapshot_changelog"),
            }
            if run.get("corpus_snapshot_id")
            else None
        )
        answer["llm"] = run.get("llm_usage") or None
        answer["run_id"] = str(run["id"])
        if run.get("ya"):
            answer["ya"] = run["ya"]
    elif answer["kind"] == "answer":
        # The run insert failed when this turn was answered, so the envelope
        # kept everything, and the prose is the message content.
        answer.setdefault("explanation", message.get("content") or None)

    snapshot = answer.get("snapshot") or None
    answer.setdefault("snapshot", None)
    answer["snapshot_is_current"] = (
        (str(snapshot.get("id")) == current_snapshot_id) if snapshot and current_snapshot_id
        else None
    )
    # Asking again reuses the stored facts, so it needs the run that holds them.
    answer["reaskable"] = run is not None and answer["kind"] == "answer"
    return answer
