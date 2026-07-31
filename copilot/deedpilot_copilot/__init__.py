"""
DeedPilot copilot — trusted tools + self-improvement flywheel.

Public trusted surface
----------------------
>>> from deedpilot_copilot import lookup_atlas, compute_maxbid, DealInputs
>>> lookup_atlas("48201").sale_type
>>> compute_maxbid(DealInputs(state="TX", sale_type="Redeemable Deed", assessed_value=2e5))
"""

from .atlas import (
    atlas_meta,
    list_researched_fips,
    lookup_atlas,
    lookup_atlas_by_name,
    reload_atlas,
    resolve_atlas,
)
from .evaluate import evaluate_policies, promotion_gate
from .labels import Disposition, PriceKind, classify, label_summary
from .maxbid import compute_maxbid
from .schemas import AtlasResult, DealInputs, DealResult, Lot, SaleType
from .search import BidPlan, optimize_bid
from .splits import assert_no_leakage, get_split_rows, load_splits
from .tools import TOOL_CATALOG, tool_envelope_atlas, tool_envelope_maxbid
from .world_model import p_win, predict_quantiles

__version__ = "0.1.0"

__all__ = [
    "__version__",
    "TOOL_CATALOG",
    "AtlasResult",
    "BidPlan",
    "DealInputs",
    "DealResult",
    "Disposition",
    "Lot",
    "PriceKind",
    "SaleType",
    "assert_no_leakage",
    "atlas_meta",
    "classify",
    "compute_maxbid",
    "evaluate_policies",
    "get_split_rows",
    "label_summary",
    "list_researched_fips",
    "load_splits",
    "lookup_atlas",
    "lookup_atlas_by_name",
    "optimize_bid",
    "p_win",
    "predict_quantiles",
    "promotion_gate",
    "reload_atlas",
    "resolve_atlas",
    "tool_envelope_atlas",
    "tool_envelope_maxbid",
]
