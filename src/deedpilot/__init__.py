"""
DeedPilot — tax-deed auction intelligence and coaching.

Architecture in one line: a deterministic domain that owns every number, an
agentic layer that owns every sentence, and a guardrail between them that will
not let the second invent the first.

    deedpilot.domain      pure arithmetic + statute. No I/O, no model calls.
    deedpilot.data        persistence. Only *observed* facts.
    deedpilot.mcp         the domain, exposed to any agent as MCP tools.
    deedpilot.agents      Strands agents. Reason, teach, cite. Never price.
    deedpilot.guardrails  the boundary. Numeric provenance, PII, disclosure.
    deedpilot.channels    chat, voice, REST, web.
    deedpilot.obs         OpenTelemetry — every turn, tool call and verdict.
"""

__version__ = "2.0.0"
