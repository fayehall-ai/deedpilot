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
from .maxbid import compute_maxbid
from .schemas import AtlasResult, DealInputs, DealResult, Lot, SaleType
from .tools import TOOL_CATALOG, tool_envelope_atlas, tool_envelope_maxbid

__version__ = "0.1.0"

__all__ = [
    "__version__",
    "TOOL_CATALOG",
    "AtlasResult",
    "DealInputs",
    "DealResult",
    "Lot",
    "SaleType",
    "atlas_meta",
    "compute_maxbid",
    "list_researched_fips",
    "lookup_atlas",
    "lookup_atlas_by_name",
    "reload_atlas",
    "resolve_atlas",
    "tool_envelope_atlas",
    "tool_envelope_maxbid",
]
