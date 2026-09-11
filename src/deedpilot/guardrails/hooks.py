"""
Guardrails, wired into the Strands agent loop as hooks.

Hooks rather than a wrapper around the agent, for one reason: they see every
tool result as it happens, including tool calls the model makes in the middle
of a multi-step turn. A wrapper only sees the final text, by which point the
evidence of what was actually looked up has been summarised away.

Two providers:

    ProvenanceGuard   collects grounded figures from tool results, then checks
                      the assistant's text against them before it is returned.
    DisclosureGuard   ensures the "not legal or financial advice" boundary is
                      stated when the conversation crosses into it.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

import structlog
from strands.hooks import (
    AfterInvocationEvent,
    AfterToolCallEvent,
    BeforeInvocationEvent,
    HookProvider,
    HookRegistry,
    MessageAddedEvent,
)

from .provenance import BLOCKED_REPLACEMENT, GroundedFigures, ProvenanceVerdict, check_numeric_provenance

log = structlog.get_logger(__name__)


def _text_of(message: Any) -> str:
    """Pull the plain text out of a Bedrock-shaped message."""
    content = message.get("content") if isinstance(message, dict) else None
    if not content:
        return ""
    return "\n".join(
        block["text"] for block in content if isinstance(block, dict) and "text" in block
    )


def _result_payload(result: Any) -> Any:
    """
    Normalise a tool result into something numbers can be walked out of.

    Strands returns MCP-shaped results: a dict with a `content` list of typed
    blocks. Tool authors return dicts, lists and JSON strings interchangeably,
    so each block is parsed if it looks like JSON and kept as text if not --
    money quoted inside a warning string still counts as grounded.
    """
    if isinstance(result, dict) and "content" in result:
        blocks = result.get("content") or []
        out: list[Any] = []
        for block in blocks:
            if not isinstance(block, dict):
                continue
            if "json" in block:
                out.append(block["json"])
            elif "text" in block:
                text = block["text"]
                try:
                    out.append(json.loads(text))
                except (ValueError, TypeError):
                    out.append(text)
        return out
    return result


@dataclass
class ProvenanceGuard(HookProvider):
    """
    Enforces: every dollar figure the assistant states traces to a tool result
    or to the user.

    State is per-invocation. `BeforeInvocationEvent` resets it, so figures
    grounded three turns ago by a tool call about a different parcel do not
    silently authorise a number today. The user's own stated figures persist
    across the conversation, because "my budget is $40,000" stays true.
    """

    #: Figures the user has stated, kept for the life of the conversation.
    user_figures: list[float] = field(default_factory=list)
    #: This invocation's grounded set.
    figures: GroundedFigures = field(default_factory=GroundedFigures)
    #: The last verdict, for the caller and the trace.
    last_verdict: ProvenanceVerdict | None = None
    #: Set when a turn was blocked; the channel substitutes this text.
    blocked_text: str | None = None
    #: Count of blocks in this process, exported as a metric.
    block_count: int = 0

    def register_hooks(self, registry: HookRegistry, **_: Any) -> None:
        registry.add_callback(BeforeInvocationEvent, self._on_start)
        registry.add_callback(MessageAddedEvent, self._on_message)
        registry.add_callback(AfterToolCallEvent, self._on_tool_result)
        registry.add_callback(AfterInvocationEvent, self._on_end)

    # -- lifecycle ----------------------------------------------------------

    def _on_start(self, event: BeforeInvocationEvent) -> None:
        self.figures = GroundedFigures(from_user=list(self.user_figures))
        self.last_verdict = None
        self.blocked_text = None

    def _on_message(self, event: MessageAddedEvent) -> None:
        """Track what the user asserts; their own numbers ground themselves."""
        message = event.message
        if not isinstance(message, dict) or message.get("role") != "user":
            return
        text = _text_of(message)
        if text:
            self.figures.add_user_text(text)
            # Persist beyond this invocation.
            before = len(self.figures.from_user)
            self.user_figures = list(self.figures.from_user)
            if before:
                log.debug("provenance.user_figures", count=len(self.user_figures))

    def _on_tool_result(self, event: AfterToolCallEvent) -> None:
        """Every tool result widens what the assistant may legitimately say."""
        if event.exception is not None:
            return
        name = "unknown"
        try:
            name = event.tool_use.get("name", "unknown")
        except AttributeError:
            pass
        self.figures.add_tool_result(name, _result_payload(event.result))

    def _on_end(self, event: AfterInvocationEvent) -> None:
        """Check the assistant's final text before anybody sees it."""
        text = ""
        try:
            messages = event.agent.messages
            for message in reversed(messages):
                if message.get("role") == "assistant":
                    text = _text_of(message)
                    break
        except (AttributeError, TypeError):
            return

        if not text:
            return

        verdict = check_numeric_provenance(text, self.figures)
        self.last_verdict = verdict

        if not verdict.ok:
            self.block_count += 1
            self.blocked_text = BLOCKED_REPLACEMENT
            log.warning(
                "guardrail.provenance.blocked",
                reason=verdict.reason,
                ungrounded=[f"{v:.2f}" for v in verdict.ungrounded],
                tools_called=list(self.figures.by_tool),
            )
        else:
            log.debug(
                "guardrail.provenance.passed",
                checked=len(verdict.checked),
                tools_called=list(self.figures.by_tool),
            )

    # -- for the caller -----------------------------------------------------

    def safe_text(self, text: str) -> str:
        """
        The text that may actually be shown.

        The channel calls this rather than reading the agent's output directly,
        so there is exactly one place a blocked turn can leak from.
        """
        return self.blocked_text if self.blocked_text is not None else text


#: Topics where the boundary between explaining a process and advising on it
#: is thin enough to be worth stating out loud.
_ADVICE_TRIGGERS = (
    "quiet title",
    "lien priority",
    "llc",
    "entity",
    "tax treatment",
    "capital gains",
    "1031",
    "attorney",
    "lawyer",
    "sue",
    "lawsuit",
    "evict",
    "eviction",
    "title insurance",
)

DISCLOSURE = (
    "\n\n---\n*I can explain how these sales work and what the published rules say, but this "
    "is not legal, tax or investment advice — for anything turning on your specific situation, "
    "talk to an attorney or CPA licensed in that state.*"
)


@dataclass
class DisclosureGuard(HookProvider):
    """
    Appends the advice boundary when a turn crosses into it.

    Appended in code rather than requested in the prompt, because a model that
    is asked to add a disclaimer adds it inconsistently -- and the turns where
    it forgets are exactly the ones that needed it.

    Fires at most once per conversation. Repeating it on every turn trains the
    reader to skip it, which defeats the purpose.
    """

    already_disclosed: bool = False
    last_turn_triggered: bool = False

    def register_hooks(self, registry: HookRegistry, **_: Any) -> None:
        registry.add_callback(BeforeInvocationEvent, self._reset)
        registry.add_callback(MessageAddedEvent, self._watch)

    def _reset(self, event: BeforeInvocationEvent) -> None:
        self.last_turn_triggered = False

    def _watch(self, event: MessageAddedEvent) -> None:
        message = event.message
        if not isinstance(message, dict):
            return
        text = _text_of(message).lower()
        if text and any(trigger in text for trigger in _ADVICE_TRIGGERS):
            self.last_turn_triggered = True

    def decorate(self, text: str) -> str:
        """Append the boundary, if this turn earned it and it is not stale."""
        if self.last_turn_triggered and not self.already_disclosed:
            self.already_disclosed = True
            return text + DISCLOSURE
        return text
