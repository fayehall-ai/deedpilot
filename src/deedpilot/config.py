"""
Runtime configuration.

Twelve-factor: everything comes from the environment, nothing is hard-coded to
a developer's machine, and the defaults are the ones that make a fresh clone
run locally rather than the ones that make production work by accident.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = REPO_ROOT / "data"


class Settings(BaseSettings):
    """Process-wide settings, read once and cached."""

    model_config = SettingsConfigDict(
        env_file=(REPO_ROOT / ".env.local", REPO_ROOT / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    env: Literal["local", "dev", "prod"] = "local"

    # --- AWS ---------------------------------------------------------------
    aws_region: str = Field(default="us-east-1", alias="AWS_REGION")

    #: Bedrock model for the coach. Inference profile ID — cross-region
    #: profiles ("us.") are required for the newer Anthropic models and give
    #: the throughput headroom a live auction needs.
    bedrock_model_id: str = Field(
        default="us.anthropic.claude-sonnet-4-6",
        alias="DEEDPILOT_BEDROCK_MODEL_ID",
    )
    #: A cheaper model for classification and extraction, where the task is
    #: structured and the judge downstream is code.
    bedrock_fast_model_id: str = Field(
        default="us.anthropic.claude-haiku-4-5-20251001-v1:0",
        alias="DEEDPILOT_BEDROCK_FAST_MODEL_ID",
    )

    #: Bedrock Guardrail. Optional: the numeric-provenance guardrail in
    #: `deedpilot.guardrails` is enforced in-process and does not depend on it.
    bedrock_guardrail_id: str | None = Field(default=None, alias="DEEDPILOT_GUARDRAIL_ID")
    bedrock_guardrail_version: str = Field(default="DRAFT", alias="DEEDPILOT_GUARDRAIL_VERSION")

    #: Direct Anthropic API key. Local-development fallback only, for when the
    #: Bedrock use-case agreement has not been submitted -- see
    #: `deedpilot.agents.models`. Not used when the provider is `bedrock`.
    anthropic_api_key: SecretStr | None = Field(default=None, alias="ANTHROPIC_API_KEY")

    #: Which provider the agents run on: `bedrock` (default), `anthropic`, or
    #: `auto` (local only -- probes Bedrock, falls back with a warning).
    model_provider: str = Field(default="bedrock", alias="DEEDPILOT_MODEL_PROVIDER")

    #: S3 bucket for conversation sessions and produced artifacts.
    session_bucket: str | None = Field(default=None, alias="DEEDPILOT_SESSION_BUCKET")

    # --- Data --------------------------------------------------------------
    database_url: SecretStr | None = Field(default=None, alias="DATABASE_URL")
    data_dir: Path = DATA_DIR

    # --- Voice -------------------------------------------------------------
    polly_voice_id: str = Field(default="Matthew", alias="DEEDPILOT_POLLY_VOICE")
    polly_engine: str = Field(default="neural", alias="DEEDPILOT_POLLY_ENGINE")
    transcribe_language: str = Field(default="en-US", alias="DEEDPILOT_TRANSCRIBE_LANGUAGE")

    # --- Observability -----------------------------------------------------
    otlp_endpoint: str | None = Field(default=None, alias="OTEL_EXPORTER_OTLP_ENDPOINT")
    service_name: str = Field(default="deedpilot", alias="OTEL_SERVICE_NAME")
    log_level: str = Field(default="INFO", alias="DEEDPILOT_LOG_LEVEL")
    #: Emit traces to stdout as well. Invaluable locally, noise in production.
    trace_console: bool = Field(default=False, alias="DEEDPILOT_TRACE_CONSOLE")

    # --- Agent behaviour ---------------------------------------------------
    #: Hard ceiling on agent loop iterations. A coach that cannot answer in
    #: this many tool calls should say so rather than spend a user's money.
    max_agent_iterations: int = Field(default=12, alias="DEEDPILOT_MAX_AGENT_ITERATIONS")
    agent_temperature: float = Field(default=0.3, alias="DEEDPILOT_AGENT_TEMPERATURE")

    @property
    def is_local(self) -> bool:
        return self.env == "local"


@lru_cache(maxsize=1)
def settings() -> Settings:
    """The process's settings. Cached: config is read at boot, not per request."""
    return Settings()
