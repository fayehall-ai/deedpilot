"""
LLM provider chain for structured reflection (and future planner calls).

Mirrors lib/ai/providers.ts:
  - Grok (xAI) primary — OpenAI-compatible JSON-schema structured outputs
  - Claude (Anthropic) fallback — forced tool_use for schema adherence

Uses httpx only (already a package dep). No-op when neither API key is set.
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any, TypeVar

import httpx
from pydantic import BaseModel, ValidationError

logger = logging.getLogger(__name__)

T = TypeVar("T", bound=BaseModel)

# Pinned defaults — swap via env is deliberate, not silent drift.
DEFAULT_GROK_MODEL = "grok-4.5"
DEFAULT_CLAUDE_MODEL = "claude-opus-4-20250514"
XAI_BASE = "https://api.x.ai/v1"
ANTHROPIC_BASE = "https://api.anthropic.com/v1"
ANTHROPIC_VERSION = "2023-06-01"


class NoProviderAvailableError(RuntimeError):
    pass


class ProviderRefusedError(RuntimeError):
    pass


class ProviderResult(BaseModel):
    data: dict[str, Any]
    model: str
    used_fallback: bool = False
    provider: str = "unknown"


def _find_env_files() -> list[Path]:
    """Walk upward from this package and common deedpilot roots for .env* files."""
    here = Path(__file__).resolve()
    candidates: list[Path] = []
    # copilot/, deedpilot/, parents
    for parent in [here.parent.parent, here.parent.parent.parent, Path.cwd()]:
        for name in (".env.local", ".env"):
            p = parent / name
            if p.is_file() and p not in candidates:
                candidates.append(p)
    return candidates


def load_env(*, override: bool = False) -> None:
    """
    Lightweight .env loader (no python-dotenv dependency).
    Loads deedpilot/.env.local and nearby files so CLI/flywheel see XAI/Anthropic keys.
    """
    for path in _find_env_files():
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            continue
        for raw in text.splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            key = key.strip()
            val = val.strip().strip('"').strip("'")
            if not key:
                continue
            if override or key not in os.environ or not os.environ.get(key):
                os.environ[key] = val


def configured_providers() -> list[str]:
    load_env()
    out: list[str] = []
    if os.environ.get("XAI_API_KEY"):
        out.append("grok")
    if os.environ.get("ANTHROPIC_API_KEY"):
        out.append("claude")
    return out


def _json_schema_for(model: type[BaseModel]) -> dict[str, Any]:
    """JSON Schema suitable for OpenAI/xAI strict structured outputs."""
    schema = model.model_json_schema()
    # xAI / OpenAI strict mode wants additionalProperties: false on objects
    # and $defs inlined or left as-is; pydantic v2 emits $defs which is fine.
    return schema


def _run_grok(
    *,
    system: str,
    prompt: str,
    schema: type[BaseModel],
    schema_name: str,
    max_tokens: int,
) -> tuple[dict[str, Any], str]:
    api_key = os.environ.get("XAI_API_KEY")
    if not api_key:
        raise NoProviderAvailableError("XAI_API_KEY not set")

    model = os.environ.get("XAI_MODEL", DEFAULT_GROK_MODEL).strip('"') or DEFAULT_GROK_MODEL
    base = os.environ.get("XAI_BASE_URL", XAI_BASE).rstrip("/")
    json_schema = _json_schema_for(schema)

    payload = {
        "model": model,
        "max_tokens": max_tokens,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": prompt},
        ],
        "response_format": {
            "type": "json_schema",
            "json_schema": {
                "name": schema_name,
                "schema": json_schema,
                "strict": True,
            },
        },
    }

    with httpx.Client(timeout=120.0) as client:
        resp = client.post(
            f"{base}/chat/completions",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json=payload,
        )
        if resp.status_code >= 400:
            raise RuntimeError(f"grok HTTP {resp.status_code}: {resp.text[:500]}")
        body = resp.json()

    choice = (body.get("choices") or [{}])[0]
    message = choice.get("message") or {}
    if message.get("refusal"):
        raise ProviderRefusedError(f"grok declined: {message['refusal']}")

    content = message.get("content")
    if not content:
        # Some OpenAI-compat paths put parsed JSON under message.parsed
        parsed = message.get("parsed")
        if parsed is not None:
            if isinstance(parsed, str):
                content = parsed
            else:
                data = schema.model_validate(parsed).model_dump()
                return data, model
        raise RuntimeError("grok returned empty content")

    if isinstance(content, list):
        # content blocks
        content = "".join(
            block.get("text", "") if isinstance(block, dict) else str(block)
            for block in content
        )

    try:
        raw = json.loads(content)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"grok non-JSON content: {content[:300]}") from e

    data = schema.model_validate(raw).model_dump()
    return data, model


def _run_claude(
    *,
    system: str,
    prompt: str,
    schema: type[BaseModel],
    schema_name: str,
    max_tokens: int,
) -> tuple[dict[str, Any], str]:
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise NoProviderAvailableError("ANTHROPIC_API_KEY not set")

    model = (
        os.environ.get("ANTHROPIC_MODEL", DEFAULT_CLAUDE_MODEL).strip('"')
        or DEFAULT_CLAUDE_MODEL
    )
    json_schema = _json_schema_for(schema)

    # Forced tool_use → reliable structured JSON across Claude versions.
    tool_name = schema_name
    payload = {
        "model": model,
        "max_tokens": max_tokens,
        "system": system,
        "tools": [
            {
                "name": tool_name,
                "description": f"Return a {schema_name} structured result.",
                "input_schema": json_schema,
            }
        ],
        "tool_choice": {"type": "tool", "name": tool_name},
        "messages": [{"role": "user", "content": prompt}],
    }

    with httpx.Client(timeout=120.0) as client:
        resp = client.post(
            f"{ANTHROPIC_BASE}/messages",
            headers={
                "x-api-key": api_key,
                "anthropic-version": ANTHROPIC_VERSION,
                "Content-Type": "application/json",
            },
            json=payload,
        )
        if resp.status_code >= 400:
            raise RuntimeError(f"claude HTTP {resp.status_code}: {resp.text[:500]}")
        body = resp.json()

    if body.get("stop_reason") == "refusal":
        raise ProviderRefusedError("claude declined (refusal)")

    for block in body.get("content") or []:
        if block.get("type") == "tool_use" and block.get("name") == tool_name:
            data = schema.model_validate(block.get("input") or {}).model_dump()
            return data, model

    # Fallback: plain text JSON
    text_parts = [
        b.get("text", "")
        for b in (body.get("content") or [])
        if b.get("type") == "text"
    ]
    text = "".join(text_parts).strip()
    if text:
        try:
            data = schema.model_validate_json(text).model_dump()
            return data, model
        except (ValidationError, json.JSONDecodeError):
            pass

    raise RuntimeError("claude returned no tool_use matching schema")


def run_structured(
    *,
    system: str,
    prompt: str,
    schema: type[BaseModel],
    schema_name: str = "StructuredResult",
    max_tokens: int = 4096,
) -> ProviderResult:
    """
    Run a schema-constrained request against Grok → Claude.

    Skips unconfigured providers. Raises NoProviderAvailableError only when
    every usable provider fails or none is configured.
    """
    load_env()
    failures: list[str] = []
    chain: list[tuple[str, Any]] = []

    if os.environ.get("XAI_API_KEY"):
        chain.append(("grok", _run_grok))
    if os.environ.get("ANTHROPIC_API_KEY"):
        chain.append(("claude", _run_claude))

    if not chain:
        raise NoProviderAvailableError(
            "No LLM provider configured. Set XAI_API_KEY (primary) or "
            "ANTHROPIC_API_KEY (fallback)."
        )

    for i, (name, runner) in enumerate(chain):
        try:
            data, model = runner(
                system=system,
                prompt=prompt,
                schema=schema,
                schema_name=schema_name,
                max_tokens=max_tokens,
            )
            return ProviderResult(
                data=data,
                model=model,
                used_fallback=i > 0,
                provider=name,
            )
        except Exception as e:  # noqa: BLE001 — chain continues
            msg = str(e)
            failures.append(f"{name}: {msg}")
            logger.warning("[ai] %s failed, trying next — %s", name, msg)

    raise NoProviderAvailableError(
        f"All configured providers failed. {' | '.join(failures)}"
    )
