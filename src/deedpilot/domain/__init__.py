"""
The deterministic domain.

Nothing in this package calls a language model, touches the network, or reads
the database. Given the same inputs it returns the same answer forever, which
is the property that lets the agent layer cite it as fact.

If you are tempted to add an LLM call here, add it in `deedpilot.agents`
instead and pass the result *in* as an input.
"""

from .deal.maxbid import compute_maxbid
from .deal.statute import covered_states, statute_for
from .models import (
    ArvBasis,
    Confidence,
    CostLine,
    DealInputs,
    DealResult,
    Recommendation,
    RedemptionOutlook,
    SaleType,
)

__all__ = [
    "ArvBasis",
    "Confidence",
    "CostLine",
    "DealInputs",
    "DealResult",
    "Recommendation",
    "RedemptionOutlook",
    "SaleType",
    "compute_maxbid",
    "covered_states",
    "statute_for",
]
