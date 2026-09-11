"""
Model providers.

Bedrock is the target and the default: it keeps inference inside the AWS
account boundary, bills through the same account as everything else, and is
what the deployed system uses.

The direct Anthropic API is here as a development fallback, for one specific
reason. Bedrock gates Anthropic models behind a per-account use-case agreement,
and until it is submitted every call fails with `ResourceNotFoundException` --
which is indistinguishable, from the code's point of view, from a bad model ID.
Without a fallback, an unsubmitted form blocks all local development on a
system that is otherwise complete.

Selection is explicit rather than magical. `DEEDPILOT_MODEL_PROVIDER` chooses,
and `auto` probes Bedrock once and falls back with a loud warning. Silent
provider switching in production is how a system ends up billing a different
vendor than its architecture diagram claims, so `auto` is refused outside local.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Any, Literal

import structlog
from strands.models import BedrockModel, Model

from deedpilot.config import settings

log = structlog.get_logger(__name__)

Provider = Literal["bedrock", "anthropic", "auto"]

#: Bedrock model IDs mapped to their direct-API equivalents, so a fallback
#: exercises comparable behaviour rather than quietly downgrading the model.
_BEDROCK_TO_ANTHROPIC = {
    "us.anthropic.claude-sonnet-4-6": "claude-sonnet-4-6",
    "us.anthropic.claude-sonnet-4-5-20250929-v1:0": "claude-sonnet-4-5-20250929",
    "us.anthropic.claude-opus-4-5-20251101-v1:0": "claude-opus-4-5-20251101",
    "us.anthropic.claude-haiku-4-5-20251001-v1:0": "claude-haiku-4-5-20251001",
    "us.anthropic.claude-opus-5": "claude-opus-5",
    "us.anthropic.claude-sonnet-5": "claude-sonnet-5",
}


class BedrockUnavailable(RuntimeError):
    """
    Bedrock rejected the model, with the reason and the fix.

    Raised rather than swallowed so the message reaches whoever can act on it.
    """


def bedrock_status(model_id: str | None = None, region: str | None = None) -> dict[str, Any]:
    """
    Can this account actually invoke the configured model?

    Checked through the control plane rather than by burning an inference call,
    and reported in enough detail to act on: `agreementAvailability` is the
    field that distinguishes "you have not signed the use-case agreement" from
    "this model does not exist here", and the two have completely different
    fixes.
    """
    import boto3
    from botocore.exceptions import BotoCoreError, ClientError

    cfg = settings()
    model_id = model_id or cfg.bedrock_model_id
    region = region or cfg.aws_region

    #: Availability is keyed by the base model ID, not the cross-region
    #: inference profile the runtime is called with.
    base = model_id.split(".", 1)[1] if model_id.startswith(("us.", "eu.", "apac.", "global.")) else model_id
    base = base.removesuffix(":0")

    try:
        client = boto3.client("bedrock", region_name=region)
        resp = client.get_foundation_model_availability(modelId=base)
    except (ClientError, BotoCoreError) as exc:
        return {"available": False, "model_id": model_id, "region": region, "error": str(exc)}

    agreement = (resp.get("agreementAvailability") or {}).get("status")
    available = agreement == "AVAILABLE"
    out = {
        "available": available,
        "model_id": model_id,
        "region": region,
        "agreement": agreement,
        "authorization": resp.get("authorizationStatus"),
        "entitlement": resp.get("entitlementAvailability"),
    }
    if not available:
        out["fix"] = (
            "Bedrock console → Model access → submit the Anthropic use-case details form, "
            f"then re-check. Region {region}. Takes effect within about 15 minutes."
        )
    return out


def _bedrock(model_id: str | None = None) -> BedrockModel:
    cfg = settings()
    kwargs: dict[str, Any] = {
        "model_id": model_id or cfg.bedrock_model_id,
        "region_name": cfg.aws_region,
        "temperature": cfg.agent_temperature,
        "streaming": True,
    }
    if cfg.bedrock_guardrail_id:
        # A second, independent layer. It catches the generic classes -- prompt
        # injection, PII, harmful content -- that a domain check has no view
        # of, while the provenance guard catches the domain failure Bedrock has
        # no view of. Neither makes the other optional.
        kwargs["guardrail_id"] = cfg.bedrock_guardrail_id
        kwargs["guardrail_version"] = cfg.bedrock_guardrail_version
        kwargs["guardrail_trace"] = "enabled"
    return BedrockModel(**kwargs)


def _anthropic(model_id: str | None = None) -> Model:
    from strands.models.anthropic import AnthropicModel

    cfg = settings()
    secret = cfg.anthropic_api_key
    api_key = secret.get_secret_value() if secret else None
    if not api_key:
        raise BedrockUnavailable(
            "Falling back to the Anthropic API, but ANTHROPIC_API_KEY is not set. Either set it "
            "for local development, or submit the Bedrock use-case form so Bedrock can be used."
        )
    bedrock_id = model_id or cfg.bedrock_model_id
    return AnthropicModel(
        client_args={"api_key": api_key},
        model_id=_BEDROCK_TO_ANTHROPIC.get(bedrock_id, "claude-sonnet-4-6"),
        max_tokens=4096,
        params={"temperature": cfg.agent_temperature},
    )


@lru_cache(maxsize=4)
def _resolve_provider(configured: str, env: str) -> str:
    """Resolve `auto` once per process, not once per conversation."""
    if configured != "auto":
        return configured
    if env != "local":
        raise RuntimeError(
            "DEEDPILOT_MODEL_PROVIDER=auto is refused outside local. A deployed system must "
            "state which provider it uses rather than discovering it at runtime — set it to "
            "'bedrock' explicitly."
        )
    status = bedrock_status()
    if status["available"]:
        return "bedrock"
    log.warning(
        "model.bedrock_unavailable_falling_back",
        agreement=status.get("agreement"),
        fix=status.get("fix"),
    )
    return "anthropic"


def build_model(model_id: str | None = None) -> Model:
    """
    The model the agents run on.

    Honours `DEEDPILOT_MODEL_PROVIDER`: `bedrock` (default), `anthropic`, or
    `auto` for local development.
    """
    cfg = settings()
    configured = cfg.model_provider.strip().lower()
    provider = _resolve_provider(configured, cfg.env)

    if provider == "bedrock":
        return _bedrock(model_id)
    if provider == "anthropic":
        return _anthropic(model_id)
    raise ValueError(f"unknown model provider {provider!r}")


def active_provider() -> str:
    """Which provider this process resolved to. Reported by `/health`."""
    cfg = settings()
    configured = cfg.model_provider.strip().lower()
    try:
        return _resolve_provider(configured, cfg.env)
    except RuntimeError:
        return configured
