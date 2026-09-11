"""
The national tax-sale rules atlas.

Resolution model: a county's rules are its own researched entry layered over
its state's defaults. Anything the county research does not cover falls through
to the state -- and exactly which fields fell through is recorded, so a reader
is told "state default, not verified for this county" instead of being left to
assume research that has not happened.

That distinction is the whole point of the file. A county page that silently
shows state defaults reads identically to one backed by a phone call to the
clerk, and a bidder cannot tell which they are looking at.
"""

from .registry import (
    Atlas,
    CountyRule,
    atlas,
    lookup_county,
    resolve_fips,
    search_counties,
    state_rule,
)

__all__ = [
    "Atlas",
    "CountyRule",
    "atlas",
    "lookup_county",
    "resolve_fips",
    "search_counties",
    "state_rule",
]
