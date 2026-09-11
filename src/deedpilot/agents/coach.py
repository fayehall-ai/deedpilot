"""
The auction coach.

A Strands agent over Bedrock, holding DeedPilot's tools, guarded by the
numeric-provenance check, and traced end to end.

On tool wiring: the coach loads the domain tools **in-process** rather than by
spawning four MCP subprocesses. The tool functions are the same objects the MCP
servers expose -- `deedpilot.mcp.servers` defines them once and both surfaces
adapt them -- so the contract is identical while the transport is not. That
matters for latency: a voice turn has roughly a second of budget before the
silence is noticeable, and four stdio handshakes spend a meaningful slice of it
for no benefit when the tools live in the same address space.

`build_coach(remote_mcp=...)` takes the other path, connecting over MCP to
servers running elsewhere. That is the deployed shape when the tools are behind
an AgentCore Gateway or scaled separately from the conversation, and it is the
same agent either way.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any

import structlog
from strands import Agent

from deedpilot.config import settings
from deedpilot.guardrails.hooks import DisclosureGuard, ProvenanceGuard

from .models import build_model
from .prompts import coach_system_prompt
from .tools import COACH_TOOLS

log = structlog.get_logger(__name__)


@dataclass
class Coach:
    """
    One coaching conversation.

    Holds the agent, its guards, and the session identity. Not thread-safe and
    not shared between users: the provenance guard's grounded-figure set is
    conversation state, and sharing it across users would let one person's tool
    results authorise another person's numbers.
    """

    agent: Agent
    provenance: ProvenanceGuard
    disclosure: DisclosureGuard
    session_id: str
    channel: str = "chat"
    #: Tool names called during the most recent turn, for the UI and the trace.
    last_tools: list[str] = field(default_factory=list)

    async def say(self, message: str) -> str:
        """
        One complete turn. Returns text that has passed every guard.

        Never returns the model's raw output: `safe_text` is the only exit, so
        a blocked turn cannot leak through a code path that forgot to check.
        """
        result = await self.agent.invoke_async(message)
        raw = str(result)
        self.last_tools = list(self.provenance.figures.by_tool)
        return self.disclosure.decorate(self.provenance.safe_text(raw))

    async def stream(self, message: str) -> AsyncIterator[dict[str, Any]]:
        """
        The same turn, streamed, for chat and voice.

        The guardrail cannot verify a figure until the sentence containing it
        exists, so text is streamed optimistically and the verdict arrives at
        the end. Consumers must honour a terminal `blocked` event by replacing
        what they rendered -- `channels/chat.py` does exactly that, and the
        contract is spelled out here because getting it wrong is how an
        unverified number stays on screen.

        Events:
            {"type": "text",    "text": str}          incremental output
            {"type": "tool",    "name": str}          a tool is being called
            {"type": "done",    "text": str}          final, guard-approved text
            {"type": "blocked", "text": str, ...}     replace everything shown
        """
        buffer: list[str] = []
        seen_tools: set[str] = set()

        async for event in self.agent.stream_async(message):
            if "data" in event:
                chunk = event["data"]
                buffer.append(chunk)
                yield {"type": "text", "text": chunk}

            tool_use = event.get("current_tool_use") or {}
            name = tool_use.get("name")
            if name and name not in seen_tools:
                seen_tools.add(name)
                yield {"type": "tool", "name": name}

        self.last_tools = list(self.provenance.figures.by_tool)
        raw = "".join(buffer)
        verdict = self.provenance.last_verdict

        if self.provenance.blocked_text is not None:
            yield {
                "type": "blocked",
                "text": self.provenance.blocked_text,
                "reason": verdict.reason if verdict else "",
                "ungrounded": [f"{v:,.2f}" for v in (verdict.ungrounded if verdict else [])],
            }
            return

        yield {"type": "done", "text": self.disclosure.decorate(raw)}


def build_coach(
    *,
    session_id: str,
    channel: str = "chat",
    user_context: str | None = None,
    session_manager: Any | None = None,
) -> Coach:
    """
    Build a coach for one conversation.

    `session_manager` persists the conversation. Pass an `S3SessionManager` in
    production so a dropped voice call can be resumed on a different instance;
    omit it for a stateless one-shot.
    """
    provenance = ProvenanceGuard()
    disclosure = DisclosureGuard()

    agent = Agent(
        model=build_model(),
        system_prompt=coach_system_prompt(channel=channel, user_context=user_context),
        tools=list(COACH_TOOLS),
        hooks=[provenance, disclosure],
        session_manager=session_manager,
        agent_id="deedpilot-coach",
        name="DeedPilot auction coach",
        description="Guides a tax-deed buyer through a sale without inventing numbers.",
        #: Surfaced on every span, so a trace can be filtered by channel or
        #: followed back to one conversation.
        trace_attributes={
            "deedpilot.session_id": session_id,
            "deedpilot.channel": channel,
        },
        callback_handler=None,
    )

    log.info("coach.built", session_id=session_id, channel=channel, tools=len(COACH_TOOLS))
    return Coach(
        agent=agent,
        provenance=provenance,
        disclosure=disclosure,
        session_id=session_id,
        channel=channel,
    )
