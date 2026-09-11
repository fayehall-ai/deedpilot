"""
Observability.

Strands emits OpenTelemetry spans for the agent loop natively -- one per
invocation, per model call and per tool call, with token counts and latency.
This module points them somewhere and adds the two things the framework cannot
know about: structured logs correlated to the same trace, and the guardrail
verdict attached to the turn it judged.

The guardrail attachment is the part worth having. Without it a trace shows a
turn that took 2.3 seconds and called three tools; with it, the trace shows
that the turn was blocked, which figure was untraceable, and which tools had
been called at the moment the model produced it. That is the difference between
knowing the system is up and knowing it is honest.
"""

from __future__ import annotations

import logging
import sys
from typing import Any

import structlog
from opentelemetry import trace

from deedpilot.config import settings

_configured = False


def setup_observability(*, service_name: str | None = None) -> None:
    """
    Configure tracing and structured logging. Idempotent.

    Call once at process start -- from the FastAPI lifespan, the CLI entry
    point, or a Lambda handler's module scope.
    """
    global _configured
    if _configured:
        return

    cfg = settings()
    name = service_name or cfg.service_name

    _setup_logging(cfg.log_level)
    _setup_tracing(name, cfg)

    _configured = True
    structlog.get_logger(__name__).info(
        "observability.ready",
        service=name,
        env=cfg.env,
        otlp=bool(cfg.otlp_endpoint),
        console_traces=cfg.trace_console,
    )


def _setup_logging(level: str) -> None:
    """
    JSON logs in deployment, human-readable locally.

    Trace and span IDs are injected into every record, so a log line found in
    CloudWatch leads straight back to the trace that produced it -- which is
    the whole reason to run both.
    """
    cfg = settings()

    def _add_trace_context(_: Any, __: str, event: dict[str, Any]) -> dict[str, Any]:
        span = trace.get_current_span()
        ctx = span.get_span_context() if span else None
        if ctx and ctx.is_valid:
            event["trace_id"] = format(ctx.trace_id, "032x")
            event["span_id"] = format(ctx.span_id, "016x")
        return event

    processors: list[Any] = [
        structlog.contextvars.merge_contextvars,
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso", utc=True),
        _add_trace_context,
        structlog.processors.StackInfoRenderer(),
        structlog.processors.format_exc_info,
    ]
    processors.append(
        structlog.dev.ConsoleRenderer() if cfg.is_local else structlog.processors.JSONRenderer()
    )

    structlog.configure(
        processors=processors,
        wrapper_class=structlog.make_filtering_bound_logger(
            getattr(logging, level.upper(), logging.INFO)
        ),
        logger_factory=structlog.PrintLoggerFactory(file=sys.stderr),
        cache_logger_on_first_use=True,
    )


def _setup_tracing(service_name: str, cfg: Any) -> None:
    """
    Wire the OTel SDK.

    Strands ships a `StrandsTelemetry` helper that registers its own tracer
    provider and exporters. Using it rather than hand-rolling means the agent's
    spans, our spans and the Bedrock call spans all land in one trace instead
    of three disconnected ones.
    """
    from opentelemetry.sdk.resources import Resource
    from strands.telemetry import StrandsTelemetry

    resource = Resource.create(
        {
            "service.name": service_name,
            "service.version": _version(),
            "deployment.environment": cfg.env,
        }
    )

    telemetry = StrandsTelemetry()
    try:
        telemetry.setup_meter(enable_console_exporter=False)
    except Exception:  # pragma: no cover - metrics are optional
        pass

    if cfg.otlp_endpoint:
        telemetry.setup_otlp_exporter()
    if cfg.trace_console or not cfg.otlp_endpoint:
        # Without an OTLP collector configured, console is the only way a
        # developer sees a trace at all. Better noisy than invisible.
        telemetry.setup_console_exporter()

    _ = resource


def _version() -> str:
    from deedpilot import __version__

    return __version__


def tracer() -> trace.Tracer:
    """A tracer for spans this codebase creates itself."""
    return trace.get_tracer("deedpilot")


def record_guardrail_verdict(verdict: Any) -> None:
    """
    Attach a guardrail verdict to the current span.

    Called after a turn is judged so the trace carries the decision, not just
    the latency.
    """
    span = trace.get_current_span()
    if not span or not span.get_span_context().is_valid:
        return
    for key, value in verdict.to_attributes().items():
        span.set_attribute(key, value)


__all__ = ["record_guardrail_verdict", "setup_observability", "tracer"]
