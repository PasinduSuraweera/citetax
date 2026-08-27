"""Check every external service Citetax depends on, and say precisely what is
wrong with each one.

    py -3.12 preflight.py          # or: .venv\\Scripts\\python.exe preflight.py

Exits 0 only when everything required is working.
"""

from __future__ import annotations

import sys
from typing import Callable

sys.path.insert(0, ".")

from app.core.config import get_settings  # noqa: E402

OK, FAIL, WARN, SKIP = "  OK  ", " FAIL ", " WARN ", " SKIP "


class Report:
    def __init__(self) -> None:
        self.required_failed = 0

    def line(self, status: str, name: str, detail: str = "") -> None:
        print(f"[{status}] {name}" + (f"\n         {detail}" if detail else ""))
        if status == FAIL:
            self.required_failed += 1


def check_config(r: Report) -> None:
    print("\n--- Configuration ---")
    s = get_settings()
    if not s.database_url:
        r.line(FAIL, "DATABASE_URL", "Not set. Fill it in api/.env (see section 1).")
    elif not s.database_url.startswith("postgresql+psycopg://"):
        r.line(
            FAIL,
            "DATABASE_URL scheme",
            "Must start with postgresql+psycopg:// — change the 'postgresql://' "
            "prefix Supabase gives you.",
        )
    elif "[YOUR-PASSWORD]" in s.database_url or "PASSWORD@" in s.database_url:
        r.line(FAIL, "DATABASE_URL password", "Placeholder password not replaced.")
    else:
        r.line(OK, "DATABASE_URL", "set")

    if not s.groq_api_key:
        r.line(
            WARN,
            "GROQ_API_KEY",
            "Not set. Figures and citations still work; prose explanation is "
            "disabled (documented degradation, spec §13).",
        )
    elif not s.groq_api_key.startswith("gsk_"):
        r.line(WARN, "GROQ_API_KEY", "Does not start with 'gsk_' — check it.")
    else:
        r.line(OK, "GROQ_API_KEY", f"set, model {s.groq_model}")

    if s.embedding_backend == "none":
        r.line(SKIP, "EMBEDDING_BACKEND", "Set to 'none' — retrieval disabled (fine for now).")
    elif not s.google_api_key:
        r.line(WARN, "GOOGLE_API_KEY", "EMBEDDING_BACKEND=vertex but no key set.")
    else:
        r.line(OK, "GOOGLE_API_KEY", f"set, {s.embedding_model} ({s.embedding_dim}d)")


def check_database(r: Report) -> None:
    print("\n--- Supabase / Postgres ---")
    s = get_settings()
    if not s.database_url:
        r.line(SKIP, "connection", "DATABASE_URL not set")
        return

    try:
        from sqlalchemy import create_engine, text

        engine = create_engine(s.database_url, pool_pre_ping=True)
        with engine.connect() as conn:
            version = conn.execute(text("select version()")).scalar_one()
            r.line(OK, "connection", version.split(",")[0])

            has_vector = conn.execute(
                text("select exists (select 1 from pg_extension where extname='vector')")
            ).scalar_one()
            if has_vector:
                r.line(OK, "pgvector extension", "installed")
            else:
                r.line(
                    WARN,
                    "pgvector extension",
                    "Not installed. Run db/migrations/001_init.sql in the "
                    "Supabase SQL editor.",
                )

            tables = conn.execute(
                text(
                    "select table_name from information_schema.tables "
                    "where table_schema='public' order by table_name"
                )
            ).scalars().all()
            expected = {
                "rule", "rule_version", "corpus_snapshot", "snapshot_rule_version",
                "source_document", "change_proposal", "chunk", "computation_run",
                "review_event", "escalation",
            }
            missing = expected - set(tables)
            if missing:
                r.line(
                    FAIL,
                    "schema",
                    f"Missing {len(missing)} table(s): {', '.join(sorted(missing))}. "
                    "Run db/migrations/001_init.sql in the Supabase SQL editor.",
                )
                return
            r.line(OK, "schema", f"{len(expected)} tables present")

            n_rules = conn.execute(
                text("select count(*) from rule_version where status='published'")
            ).scalar_one()
            snap = conn.execute(
                text("select label from corpus_snapshot where is_current")
            ).scalar()
            if n_rules and snap:
                r.line(OK, "seed data", f"{n_rules} published rule versions, snapshot '{snap}'")
            else:
                r.line(
                    FAIL,
                    "seed data",
                    "No published rules or no current snapshot. "
                    "Run: .venv\\Scripts\\python.exe seed/rules_seed.py",
                )
    except Exception as exc:  # noqa: BLE001
        msg = str(exc)
        hint = ""
        if "could not translate host name" in msg or "getaddrinfo" in msg:
            hint = " → Host is wrong, or no internet."
        elif "password authentication failed" in msg:
            hint = " → Wrong password. URL-encode special characters (@ → %40)."
        elif "Tenant or user not found" in msg:
            hint = " → Username must be postgres.<project-ref> when using the pooler."
        r.line(FAIL, "connection", msg.split("\n")[0][:220] + hint)


def check_groq(r: Report) -> None:
    print("\n--- Groq (LLM) ---")
    s = get_settings()
    if not s.groq_api_key:
        r.line(SKIP, "chat completion", "GROQ_API_KEY not set")
        return
    try:
        from groq import Groq

        client = Groq(api_key=s.groq_api_key)
        resp = client.chat.completions.create(
            model=s.groq_model,
            messages=[{"role": "user", "content": "Reply with the single word: ready"}],
            max_tokens=10,
            temperature=0,
        )
        r.line(OK, "chat completion", f"{s.groq_model} → {resp.choices[0].message.content!r}")
    except Exception as exc:  # noqa: BLE001
        msg = str(exc)
        hint = ""
        if "invalid_api_key" in msg or "401" in msg:
            hint = " → Key rejected. Regenerate at console.groq.com/keys."
        elif "model_not_found" in msg or "404" in msg:
            hint = f" → Model '{s.groq_model}' unavailable on your account."
        elif "rate_limit" in msg or "429" in msg:
            hint = " → Rate limited; the key itself is valid."
        r.line(FAIL, "chat completion", msg.split("\n")[0][:220] + hint)


def check_embeddings(r: Report) -> None:
    print("\n--- Google embeddings ---")
    s = get_settings()
    if s.embedding_backend == "none":
        r.line(SKIP, "embed", "EMBEDDING_BACKEND=none")
        return
    if not s.google_api_key:
        r.line(SKIP, "embed", "GOOGLE_API_KEY not set")
        return
    try:
        from google import genai
        from google.genai import types

        client = genai.Client(api_key=s.google_api_key)
        resp = client.models.embed_content(
            model=s.embedding_model,
            contents="personal income tax relief",
            config=types.EmbedContentConfig(output_dimensionality=s.embedding_dim),
        )
        dim = len(resp.embeddings[0].values)
        if dim == s.embedding_dim:
            r.line(OK, "embed", f"{s.embedding_model} → {dim} dimensions")
        else:
            r.line(
                FAIL,
                "embed dimension",
                f"Model returned {dim} dims but EMBEDDING_DIM={s.embedding_dim} "
                f"and the chunk.embedding column is vector({s.embedding_dim}). "
                "These must match.",
            )
    except Exception as exc:  # noqa: BLE001
        r.line(WARN, "embed", str(exc).split("\n")[0][:220])


def check_spacy(r: Report) -> None:
    print("\n--- spaCy NER (privacy layer) ---")
    try:
        import spacy

        spacy.load("en_core_web_sm")
        r.line(OK, "en_core_web_sm", "loaded (~12 MB)")
    except OSError:
        r.line(
            WARN,
            "en_core_web_sm",
            "Not installed — regex redaction still works, name/employer recall "
            "is reduced. Install: .venv\\Scripts\\python.exe -m spacy download "
            "en_core_web_sm",
        )
    except Exception as exc:  # noqa: BLE001
        r.line(WARN, "spacy", str(exc)[:200])


def check_no_weights(r: Report) -> None:
    """Spec §2.4 — citetax-api must never load model weights."""
    print("\n--- Memory guard (spec §2.4) ---")
    banned = [m for m in ("torch", "sentence_transformers", "onnxruntime")
              if m in sys.modules]
    if banned:
        r.line(FAIL, "no model weights", f"Loaded in-process: {', '.join(banned)}")
    else:
        r.line(OK, "no model weights", "torch / sentence-transformers / onnxruntime absent")


def main() -> int:
    print("=" * 68)
    print("  Citetax preflight — checking every external service")
    print("=" * 68)

    r = Report()
    checks: list[Callable[[Report], None]] = [
        check_config, check_database, check_groq,
        check_embeddings, check_spacy, check_no_weights,
    ]
    for check in checks:
        try:
            check(r)
        except Exception as exc:  # noqa: BLE001
            r.line(FAIL, check.__name__, f"check itself crashed: {exc}")

    print("\n" + "=" * 68)
    if r.required_failed:
        print(f"  {r.required_failed} required check(s) FAILED — see the hints above.")
        return 1
    print("  All required checks passed. Ready to test.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
