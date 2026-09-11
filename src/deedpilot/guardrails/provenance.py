"""
Numeric provenance: the guardrail this whole product turns on.

**Every dollar figure in an assistant turn must trace to a tool result or to
something the user said.** If the model produces a number that appeared in
neither, the turn is blocked.

Why this and not a generic content filter. DeedPilot's failure mode is not
toxicity or prompt injection -- it is a plausible, well-formatted, confidently
delivered walk-away price that no engine computed. A novice at an auction has
seconds to decide, has been told the assistant is a coach, and cannot
distinguish `$97,550` (computed by `compute_maxbid` from a statute and an
assessment) from `$97,550` (produced by a language model completing a pattern).
Both render identically. Only one is defensible afterward.

Generic guardrails do not catch this, because there is nothing offensive about
the sentence. The check has to be domain-specific and mechanical: collect what
the tools returned, collect what the user asserted, extract what the model
stated, and require containment.

Design notes that matter:

- **Tolerance, not equality.** A coach that says "about $97,500" or "roughly
  ninety-eight thousand" is being helpful, not inventing. Rounding to two
  significant figures is explicitly allowed and checked as a band.
- **Arithmetic the user can follow is allowed.** "$97,550 minus your $10,000
  opening bid leaves $87,550" is a derivation, not a fabrication, so sums and
  differences of grounded figures are admitted.
- **Fail closed on money, open on everything else.** Years, distances,
  percentages and counts are checked more loosely: getting "1,200 feet from the
  rail line" slightly wrong is a quality bug, while getting a bid ceiling wrong
  is a financial one.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from decimal import Decimal
from itertools import combinations
from typing import Any

__all__ = [
    "GroundedFigures",
    "ProvenanceVerdict",
    "check_numeric_provenance",
    "extract_money",
]

#: Money as it appears in generated prose. Handles `$1,234.56`, `$1.2M`,
#: `$97,550`, and bare-dollar phrasings like "97,550 dollars".
_MONEY = re.compile(
    r"""
    (?:
        \$\s?(?P<sym>[\d,]+(?:\.\d+)?)\s?(?P<sym_scale>[kKmM])?\b
      | (?P<bare>[\d,]+(?:\.\d+)?)\s?(?P<bare_scale>[kKmM])?\s+dollars?\b
    )
    """,
    re.VERBOSE,
)

#: Spelled-out amounts a coach says out loud, which the voice channel makes
#: common: "ninety-eight thousand", "two point five million".
_WORD_SCALES = {"thousand": 1_000, "million": 1_000_000, "billion": 1_000_000_000}
_WORD_NUMBERS = {
    "zero": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6,
    "seven": 7, "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12,
    "thirteen": 13, "fourteen": 14, "fifteen": 15, "sixteen": 16,
    "seventeen": 17, "eighteen": 18, "nineteen": 19, "twenty": 20,
    "thirty": 30, "forty": 40, "fifty": 50, "sixty": 60, "seventy": 70,
    "eighty": 80, "ninety": 90, "hundred": 100,
}
_SPOKEN = re.compile(
    r"\b((?:(?:" + "|".join(_WORD_NUMBERS) + r")[\s-]*)+)"
    r"(" + "|".join(_WORD_SCALES) + r")\b(?:\s+dollars)?",
    re.IGNORECASE,
)

#: Relative tolerance for "about $97,500" against a true 97,550.
#: 2% admits two-significant-figure rounding on any magnitude a bid occupies.
ROUNDING_TOLERANCE = 0.02

#: Figures at or below this are ignored entirely. "$0", "$1" and small change
#: appear in idiom ("not worth a dollar") and carry no bid risk.
IGNORE_AT_OR_BELOW = 1.0

#: Phrases that mark a figure as illustrative rather than asserted.
#:
#: This distinction was not in the first version of the guardrail, and the
#: first live conversation showed why it has to be. The coach explained that
#: improvements are not reimbursed on redemption -- "if you spend $30,000
#: fixing a house and the owner redeems on day 179, you lose that money" --
#: and the turn was blocked. That is good teaching, and $30,000 is a made-up
#: number *on purpose*: it is a worked example, not a claim about a property.
#:
#: Blocking it taught the coach to teach worse. So a figure introduced by a
#: hypothetical marker is admitted, and recorded separately so the rate can be
#: watched. The marker has to appear close in front of the figure, which is
#: what keeps "if you win, your ceiling is $97,550" from laundering an
#: invented ceiling through a conditional.
_HYPOTHETICAL_MARKERS = (
    "if you", "if they", "if it", "if the", "say you", "suppose", "let's say",
    "lets say", "for example", "for instance", "e.g.", "imagine", "hypothetical",
    "pretend", "a property worth", "on a ", "every ", "per ",
)

#: How far back to look for a hypothetical marker. One clause, not one
#: paragraph -- a marker three sentences earlier does not govern this figure.
_HYPOTHETICAL_WINDOW = 60


def _parse_scale(text: str, scale: str | None) -> float:
    value = float(text.replace(",", ""))
    if scale and scale.lower() == "k":
        value *= 1_000
    elif scale and scale.lower() == "m":
        value *= 1_000_000
    return value


def _parse_spoken(words: str, scale: str) -> float | None:
    """Turn "ninety-eight" + "thousand" into 98000."""
    total = 0
    current = 0
    for token in re.split(r"[\s-]+", words.strip().lower()):
        if not token:
            continue
        if token not in _WORD_NUMBERS:
            return None
        n = _WORD_NUMBERS[token]
        if n == 100:
            current = (current or 1) * 100
        else:
            current += n
    total += current
    return float(total * _WORD_SCALES[scale.lower()]) if total else None


def _is_hypothetical(text: str, position: int) -> bool:
    """Does a hypothetical marker govern the figure at this position?"""
    window = text[max(0, position - _HYPOTHETICAL_WINDOW) : position].lower()
    return any(marker in window for marker in _HYPOTHETICAL_MARKERS)


def extract_money_spans(text: str) -> list[tuple[float, bool]]:
    """
    Every dollar figure in a block of prose, each tagged hypothetical or not.

    Deliberately over-inclusive on the model's output: a figure this misses is
    a figure that escapes the check, so ambiguity resolves toward extracting.
    """
    found: list[tuple[float, bool]] = []
    for m in _MONEY.finditer(text):
        if m.group("sym") is not None:
            value = _parse_scale(m.group("sym"), m.group("sym_scale"))
        elif m.group("bare") is not None:
            value = _parse_scale(m.group("bare"), m.group("bare_scale"))
        else:
            continue
        found.append((value, _is_hypothetical(text, m.start())))
    for m in _SPOKEN.finditer(text):
        value = _parse_spoken(m.group(1), m.group(2))
        if value is not None:
            found.append((value, _is_hypothetical(text, m.start())))
    return [(v, h) for v, h in found if v > IGNORE_AT_OR_BELOW]


def extract_money(text: str) -> list[float]:
    """Every dollar figure stated, ignoring how it was framed."""
    return [v for v, _ in extract_money_spans(text)]


def _walk_numbers(obj: Any) -> list[float]:
    """Every number anywhere inside a tool result, at any nesting depth."""
    out: list[float] = []
    stack: list[Any] = [obj]
    while stack:
        node = stack.pop()
        if isinstance(node, bool):
            continue
        if isinstance(node, (int, float, Decimal)):
            out.append(float(node))
        elif isinstance(node, str):
            # Tool results carry money inside prose too -- a cost line's note,
            # a warning, an atlas rule quoting a filing fee.
            out.extend(extract_money(node))
        elif isinstance(node, dict):
            stack.extend(node.values())
        elif isinstance(node, (list, tuple, set)):
            stack.extend(node)
    return out


@dataclass(slots=True)
class GroundedFigures:
    """
    Everything the assistant is permitted to say a number about, this turn.

    Accumulated as tools return, then frozen when the model's text is checked.
    """

    #: Figures returned by tools, keyed by the tool that produced them, so a
    #: violation can name where a legitimate figure *would* have come from.
    by_tool: dict[str, list[float]] = field(default_factory=dict)
    #: Figures the user themselves stated. A user who says "my budget is
    #: $40,000" has grounded $40,000 for the rest of the conversation.
    from_user: list[float] = field(default_factory=list)

    def add_tool_result(self, tool_name: str, result: Any) -> None:
        self.by_tool.setdefault(tool_name, []).extend(_walk_numbers(result))

    def add_user_text(self, text: str) -> None:
        self.from_user.extend(extract_money(text))

    def all_figures(self) -> list[float]:
        out = list(self.from_user)
        for values in self.by_tool.values():
            out.extend(values)
        return out

    def derivable(self, *, max_terms: int = 2) -> set[float]:
        """
        Sums and differences of grounded figures.

        A coach explaining "your ceiling is $97,550 and the opening bid is
        $10,000, so you have $87,550 of room" is doing arithmetic the user can
        check, not inventing a number. Restricted to pairs: beyond two terms
        the space of reachable values grows until it grounds almost anything,
        which would quietly disable the guardrail.
        """
        base = [f for f in self.all_figures() if f > IGNORE_AT_OR_BELOW]
        # Cap the input set. The pair space is O(n^2), and a long conversation
        # with many tool calls could otherwise spend real time here on a path
        # that runs before every single assistant turn.
        base = sorted(set(base), reverse=True)[:120]
        out: set[float] = set()
        for a, b in combinations(base, max_terms):
            out.add(a + b)
            out.add(abs(a - b))
        return {v for v in out if v > IGNORE_AT_OR_BELOW}


@dataclass(slots=True)
class ProvenanceVerdict:
    """The outcome of checking one assistant turn."""

    ok: bool
    #: Figures asserted with no traceable source. Empty when `ok`.
    ungrounded: list[float] = field(default_factory=list)
    #: Every figure checked, for the trace.
    checked: list[float] = field(default_factory=list)
    #: Figures admitted as worked examples rather than claims. Tracked because
    #: a rising rate here would mean the coach has learned to launder invented
    #: numbers through the word "if", and that should be visible in a dashboard
    #: rather than discovered in a complaint.
    illustrative: list[float] = field(default_factory=list)
    reason: str = ""

    def to_attributes(self) -> dict[str, Any]:
        """Flattened for an OpenTelemetry span."""
        return {
            "guardrail.provenance.ok": self.ok,
            "guardrail.provenance.checked_count": len(self.checked),
            "guardrail.provenance.ungrounded_count": len(self.ungrounded),
            "guardrail.provenance.illustrative_count": len(self.illustrative),
            "guardrail.provenance.ungrounded": [f"{v:.2f}" for v in self.ungrounded[:10]],
        }


def _is_grounded(value: float, grounded: list[float], derivable: set[float]) -> bool:
    """Is this figure within rounding distance of something we can trace?"""
    for source in grounded:
        if abs(value - source) <= max(abs(source) * ROUNDING_TOLERANCE, 0.5):
            return True
    for source in derivable:
        if abs(value - source) <= max(abs(source) * ROUNDING_TOLERANCE, 0.5):
            return True
    return False


def check_numeric_provenance(text: str, figures: GroundedFigures) -> ProvenanceVerdict:
    """
    Check one assistant turn.

    Returns a verdict rather than raising, because the caller decides what to
    do with it: the chat channel replaces the turn, the eval harness records
    it, and the trace exporter attaches it either way.
    """
    spans = extract_money_spans(text)
    if not spans:
        return ProvenanceVerdict(ok=True, reason="no dollar figures stated")

    asserted = [v for v, hypothetical in spans if not hypothetical]
    illustrative = [v for v, hypothetical in spans if hypothetical]

    if not asserted:
        return ProvenanceVerdict(
            ok=True,
            checked=[v for v, _ in spans],
            illustrative=illustrative,
            reason=(
                f"{len(illustrative)} figure(s) used as worked examples, none asserted as fact"
            ),
        )

    grounded = figures.all_figures()
    if not grounded:
        # Say which of the two situations this is. "No tool was called" and
        # "tools were called but returned no money" have different causes and
        # different fixes, and reporting the first when the second happened
        # sends whoever reads the log looking in the wrong place.
        tools = list(figures.by_tool)
        detail = (
            "no tool was called"
            if not tools
            else f"the tools called ({', '.join(tools)}) returned no dollar figures"
        )
        return ProvenanceVerdict(
            ok=False,
            ungrounded=asserted,
            checked=[v for v, _ in spans],
            illustrative=illustrative,
            reason=(
                f"The turn asserts dollar figures, but {detail} and the user supplied no "
                f"amounts. Every asserted figure is therefore model-generated."
            ),
        )

    derivable = figures.derivable()
    ungrounded = [v for v in asserted if not _is_grounded(v, grounded, derivable)]

    if ungrounded:
        return ProvenanceVerdict(
            ok=False,
            ungrounded=ungrounded,
            checked=[v for v, _ in spans],
            illustrative=illustrative,
            reason=(
                f"{len(ungrounded)} of {len(asserted)} asserted dollar figures trace to no tool "
                f"result and to nothing the user said: "
                f"{', '.join(f'${v:,.0f}' for v in ungrounded[:5])}."
            ),
        )

    return ProvenanceVerdict(
        ok=True,
        checked=[v for v, _ in spans],
        illustrative=illustrative,
        reason="all asserted figures traced",
    )


#: What the user sees when a turn is blocked.
#:
#: Says what happened rather than hiding it. A coach that silently swallows an
#: answer teaches a novice nothing; one that says "I nearly quoted you a number
#: I could not stand behind" teaches them exactly the habit that keeps them
#: solvent at an auction.
BLOCKED_REPLACEMENT = (
    "I stopped myself there. I was about to quote you a dollar figure that did not come from "
    "the pricing engine or from anything you told me — which means I would have been making it "
    "up, and you would have had no way to tell.\n\n"
    "Give me the parcel (a lot ID, or the county and parcel number) and I will run the actual "
    "numbers. If you just want to talk through the mechanics of the sale, I can do that without "
    "quoting prices at all."
)
