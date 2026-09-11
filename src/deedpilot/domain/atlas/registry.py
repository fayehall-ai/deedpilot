"""
Atlas storage and lookup.

The atlas is a frozen data file, loaded once and served from memory. It is the
free tier, the SEO surface, and the thing the coach cites when a novice asks
"what happens after I win in Fulton County" -- so it must answer instantly and
must never make a rule up.
"""

from __future__ import annotations

import json
import re
import unicodedata
from dataclasses import dataclass
from functools import lru_cache
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict

from deedpilot.config import settings
from deedpilot.domain.models import SaleType


class LinkRef(BaseModel):
    """
    A contact or resource: county office, auction platform, GIS portal.

    `url` is optional because some references genuinely have no web presence --
    "Sheriff's sale, on the courthouse steps" is a real auction venue, not a
    missing link.
    """

    model_config = ConfigDict(extra="ignore")

    label: str
    url: str | None = None
    phone: str | None = None


class GrowthArea(BaseModel):
    """A neighborhood trend note -- directional, dated, sourced. Never a guarantee."""

    model_config = ConfigDict(extra="ignore")

    name: str
    why: str


class CountyRule(BaseModel):
    """
    One county's rules, after state-default inheritance has been applied.

    `inherited` lists the fields that came from the state rather than county
    research. Any surface that renders this -- page, chat turn, or spoken
    answer -- is required to pass that distinction on.
    """

    model_config = ConfigDict(extra="ignore")

    fips: str
    name: str
    state: str
    state_name: str
    population: int | None = None

    #: The county's own wording, which is often finer-grained than the four
    #: national buckets ("Tax Lien Assignment", "Hybrid (Lien Assignment /
    #: Judicial Foreclosure)").
    type_label: str
    #: The canonical bucket, for filtering and for the deal maths.
    sale_type: SaleType
    redemption: str
    returns: str
    statute: str
    notes: str | None = None

    #: True when no county-specific research exists at all.
    is_state_default: bool
    #: Field names whose values came from the state, not county research.
    inherited: list[str] = []

    auction_format: str | None = None
    auction_platform: LinkRef | None = None
    auction_frequency: str | None = None
    deposit_rules: str | None = None
    tax_collector: LinkRef | None = None
    clerk_of_court: LinkRef | None = None
    property_appraiser: LinkRef | None = None
    surviving_liens: str | None = None
    quiet_title: str | None = None
    gis_map: LinkRef | None = None
    growth_neighborhoods: list[GrowthArea] | None = None

    #: YYYY-MM the auction logistics and contacts were last verified.
    as_of: str | None = None
    sources: list[str] | None = None

    @property
    def display_name(self) -> str:
        return f"{self.name}, {self.state}"

    def provenance_note(self) -> str:
        """
        One sentence a coach can say out loud about how solid this entry is.

        Written here rather than in a prompt so that every channel says the
        same thing, and so that it cannot be paraphrased into confidence the
        underlying data does not support.
        """
        if self.is_state_default:
            return (
                f"No county-specific research exists for {self.display_name}; everything below "
                f"is the {self.state_name} state default. Confirm with the county before you bid."
            )
        checked = f" Auction logistics last verified {self.as_of}." if self.as_of else ""
        if self.inherited:
            return (
                f"{self.display_name} is researched, but {len(self.inherited)} field(s) fall back "
                f"to the {self.state_name} default ({', '.join(sorted(self.inherited))})."
                f"{checked}"
            )
        return f"{self.display_name} is researched at county level.{checked}"


# --------------------------------------------------------------------------
# Name resolution
# --------------------------------------------------------------------------

#: States with independent cities that carry their own FIPS entry.
#:
#: Restricted to these four on purpose. Within them an independent city's
#: 3-digit code is >= 500 -- but that rule is only safe *here*: Texas has 254
#: counties running to 48507 (Zavala), so applying it nationally would
#: reclassify real counties as cities.
INDEPENDENT_CITY_STATES = frozenset({"VA", "MD", "MO", "NV"})

#: States where tax sales are run by municipalities, not counties.
#:
#: Connecticut is the live case: its sales are municipal under CGS 12-157, so
#: sources name towns -- New Britain, Bridgeport -- which are not counties and
#: never will resolve. Reporting that as "not found" would file a correct row
#: as a data-quality problem, so it gets its own outcome.
MUNICIPAL_STATES = frozenset({"CT", "RI", "VT", "NH", "ME", "MA"})

_ENTITY_NOUNS = re.compile(
    r"\b(county|parish|census area|city and borough|borough|municipality|city)\b"
)


def fold_county_name(name: str) -> str:
    """
    Fold a county name to a comparison key.

    Strips diacritics, without which New Mexico's Doña Ana never matches a
    source writing "Dona Ana". `city` is stripped like any other entity noun so
    that "Baltimore City" and "Baltimore County" both fold to "baltimore" and
    reach disambiguation -- leaving it in made "Baltimore City" match neither
    candidate, so the city marker never got a chance to choose.

    `city and borough` must precede bare `city` in the alternation, or Alaska's
    "Juneau City and Borough" strands an " and borough". Counties genuinely
    containing the word -- Carson City NV, James City and Charles City VA --
    are safe because both sides fold identically.
    """
    text = unicodedata.normalize("NFD", name)
    text = "".join(ch for ch in text if unicodedata.category(ch) != "Mn").lower()
    # "City of Richmond" -> "richmond". Before the noun strip, which would
    # otherwise leave a stranded "of".
    text = re.sub(r"\bcity of\b", "", text)
    text = _ENTITY_NOUNS.sub("", text)
    text = re.sub(r"\bsainte\b", "ste", text)
    text = re.sub(r"\bsaint\b", "st", text)
    return re.sub(r"[^a-z0-9]", "", text)


def read_entity_marker(name: str) -> Literal["city", "county"] | None:
    """Did the source explicitly say city, or explicitly say county?"""
    n = name.lower()
    if re.search(r"\bcity\b", n) and not re.search(r"\bcity and borough\b", n):
        return "city"
    if re.search(r"\b(county|parish)\b", n):
        return "county"
    return None


@dataclass(frozen=True, slots=True)
class Resolved:
    """Exactly one county matched."""

    fips: str
    county: CountyRule
    matched_on: Literal["unique", "city-marker", "county-marker"]
    ok: Literal[True] = True


@dataclass(frozen=True, slots=True)
class Unresolved:
    """
    Nothing was resolved, and the reason is reportable.

    `ambiguous` is not a failure of this function -- it is the correct answer
    when a state has two entities of one name and the source did not say which.
    Baltimore County and Baltimore city are different governments holding
    different sales, and picking one silently is not a decision anyone made.
    """

    reason: Literal["not_found", "ambiguous", "municipal_state", "unknown_state"]
    detail: str
    candidates: tuple[CountyRule, ...] = ()
    ok: Literal[False] = False


FipsResolution = Resolved | Unresolved


# --------------------------------------------------------------------------
# The atlas itself
# --------------------------------------------------------------------------


class Atlas:
    """
    Every county in the country, resolved and indexed.

    Built once at import and shared. Roughly 3,142 rows and 5 MB of JSON --
    small enough to hold, large enough that rebuilding it per request would
    show up in a voice call's latency budget.
    """

    def __init__(self, payload: dict[str, Any]) -> None:
        self.exported_at: str = payload.get("exported_at", "")
        self.states: dict[str, dict[str, Any]] = payload["states"]
        self._sale_schedule: dict[str, Any] = payload.get("sale_schedule", {})

        self.counties: dict[str, CountyRule] = {}
        self._by_state: dict[str, list[CountyRule]] = {}
        self._by_folded: dict[tuple[str, str], list[CountyRule]] = {}

        for row in payload["counties"]:
            rule = CountyRule.model_validate(row)
            self.counties[rule.fips] = rule
            self._by_state.setdefault(rule.state, []).append(rule)
            self._by_folded.setdefault((rule.state, fold_county_name(rule.name)), []).append(rule)

    # -- basic lookups ------------------------------------------------------

    def get(self, fips: str) -> CountyRule | None:
        return self.counties.get(fips.strip())

    def in_state(self, state: str) -> list[CountyRule]:
        return self._by_state.get(state.strip().upper(), [])

    def state_rule(self, state: str) -> dict[str, Any] | None:
        return self.states.get(state.strip().upper())

    @property
    def county_count(self) -> int:
        return len(self.counties)

    @property
    def researched_count(self) -> int:
        return sum(1 for c in self.counties.values() if not c.is_state_default)

    # -- resolution ---------------------------------------------------------

    def resolve(self, name: str, state: str) -> FipsResolution:
        """
        Resolve one (name, state) pair to a FIPS code.

        This refuses more than it guesses. A wrong answer here is worse than no
        answer: it attaches a verified source URL to the wrong county, and the
        crawler then fetches the wrong county's sale list forever.
        """
        state_abbr = state.strip().upper()
        raw = name.strip()

        if not self._by_state.get(state_abbr):
            return Unresolved("unknown_state", f'no counties on file for "{state}"')

        key = fold_county_name(raw)
        if not key:
            return Unresolved("not_found", f'"{raw}" folds to an empty name')

        matches = self._by_folded.get((state_abbr, key), [])

        if len(matches) == 1:
            return Resolved(matches[0].fips, matches[0], "unique")

        if not matches:
            if state_abbr in MUNICIPAL_STATES:
                return Unresolved(
                    "municipal_state",
                    f'{state_abbr} sells by municipality, and "{raw}" is not one of its counties',
                )
            return Unresolved("not_found", f'no county in {state_abbr} named "{raw}"')

        # More than one entity shares this name. The only honest way through is
        # an explicit marker in what the source wrote.
        marker = read_entity_marker(raw)
        if marker == "city":
            city = next((c for c in matches if is_independent_city(c.fips, c.state)), None)
            if city:
                return Resolved(city.fips, city, "city-marker")
        if marker == "county":
            county = next((c for c in matches if not is_independent_city(c.fips, c.state)), None)
            if county:
                return Resolved(county.fips, county, "county-marker")

        return Unresolved(
            "ambiguous",
            f'{state_abbr} has {len(matches)} entities named "{raw}" '
            f'({", ".join(c.fips for c in matches)}) and the source did not say which',
            tuple(matches),
        )

    def search(self, query: str, *, state: str | None = None, limit: int = 10) -> list[CountyRule]:
        """
        Free-text county search, for the coach's benefit.

        Deliberately generous where `resolve` is strict: this feeds a
        conversation where the next turn can ask "did you mean Baltimore
        County or Baltimore city?", so returning several candidates is useful
        rather than dangerous. Nothing joins on the output.
        """
        key = fold_county_name(query)
        if not key:
            return []
        pool = self.in_state(state) if state else self.counties.values()

        exact: list[CountyRule] = []
        partial: list[CountyRule] = []
        for c in pool:
            folded = fold_county_name(c.name)
            if folded == key:
                exact.append(c)
            elif key in folded or folded.startswith(key):
                partial.append(c)

        # Bigger counties first among partials: someone typing "jeff" wants
        # Jefferson County KY before Jeff Davis County TX.
        partial.sort(key=lambda c: c.population or 0, reverse=True)
        return (exact + partial)[:limit]


def is_independent_city(fips: str, state: str) -> bool:
    """Is this FIPS an independent city rather than a county?"""
    if state.strip().upper() not in INDEPENDENT_CITY_STATES:
        return False
    return int(fips[2:]) >= 500


@lru_cache(maxsize=1)
def atlas() -> Atlas:
    """The process's atlas. Loaded once."""
    path = settings().data_dir / "atlas.json"
    if not path.exists():
        raise FileNotFoundError(
            f"Missing {path}. The atlas is checked in and is required for every county lookup."
        )
    return Atlas(json.loads(path.read_text(encoding="utf-8")))


def lookup_county(fips: str) -> CountyRule | None:
    return atlas().get(fips)


def resolve_fips(name: str, state: str) -> FipsResolution:
    return atlas().resolve(name, state)


def search_counties(query: str, *, state: str | None = None, limit: int = 10) -> list[CountyRule]:
    return atlas().search(query, state=state, limit=limit)


def state_rule(state: str) -> dict[str, Any] | None:
    return atlas().state_rule(state)
