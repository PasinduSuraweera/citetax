"""Configuration. Everything that differs between laptop and Cloud Run lives here."""

from functools import lru_cache
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    # --- Database (Supabase Postgres 16 + pgvector) ---
    database_url: str = ""

    # --- LLM (hosted, spec §2.1) ---
    groq_api_key: str = ""
    groq_model: str = "openai/gpt-oss-120b"

    # --- Embeddings (spec §2.4 provider abstraction) ---
    # `vertex` is the chosen provider: hosted, no local weights, 768 dims.
    # `none` disables dense retrieval and falls back to Postgres FTS alone.
    embedding_backend: Literal["vertex", "none"] = "vertex"
    # gemini-embedding-001 returns 3072 dimensions by default, which is past
    # pgvector's 2000-dimension ceiling for an HNSW index. The model supports
    # truncation, so ask for 768 and keep the existing vector(768) column.
    embedding_dim: int = 768
    embedding_model: str = "gemini-embedding-001"
    google_api_key: str = ""
    google_project_id: str = ""

    # --- Payslip upload (hosted vision extraction, no local OCR) ---
    payslip_extraction_model: str = "gemini-2.5-flash"
    payslip_max_bytes: int = 8 * 1024 * 1024

    # --- Supported years of assessment (spec §1.2) ---
    supported_yas: tuple[str, ...] = ("2025/2026", "2026/2027")

    # --- Auth ---
    # Shared with NextAuth in the web app, which signs the session JWT.
    auth_secret: str = ""
    # Emails granted the admin role on first sign-in, so there is a way in
    # before any account exists. Comma separated.
    bootstrap_admins: str = ""

    # --- Corpus agent ---
    # How often the background agent crawls, extracts and indexes. 0 disables
    # the scheduler (cycles can still be triggered from the admin panel).
    watch_interval_minutes: int = 30

    # --- Behaviour ---
    max_free_text_to_llm: int = 600  # truncation cap, spec §9.1 compensating controls
    cors_origins: str = "http://localhost:3000"

    @property
    def bootstrap_admin_list(self) -> list[str]:
        return [e.strip().lower() for e in self.bootstrap_admins.split(",") if e.strip()]

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def llm_enabled(self) -> bool:
        return bool(self.groq_api_key)


@lru_cache
def get_settings() -> Settings:
    return Settings()
