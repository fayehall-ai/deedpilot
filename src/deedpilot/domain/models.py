"""
Domain types.

Every money figure a user acts on is defined here and produced by
`deedpilot.domain.deal`. The agent layer may read these objects and describe
them; it may not construct one with numbers of its own invention. The
`provenance` field on `CostLine` and the `assumed` flags exist so a reader —
human or guardrail — can tell measurement from assumption without trusting
prose.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class SaleType(StrEnum):
    """The four systems states use to sell tax-defaulted property."""

    TAX_LIEN = "Tax Lien"
    TAX_DEED = "Tax Deed"
    REDEEMABLE_DEED = "Redeemable Deed"
    HYBRID = "Hybrid"

    @classmethod
    def coerce(cls, label: str | None) -> SaleType:
        """
        Map a county's own wording onto the canonical bucket.

        Counties run finer-grained systems than the four national buckets --
        "Tax Lien Assignment" and "Hybrid (Lien Assignment / Judicial
        Foreclosure)" are both real labels. Prefix matching is deliberate:
        an unrecognised label falls to TAX_DEED, which is the most common and
        the least generous assumption about what the buyer receives.
        """
        if not label:
            return cls.TAX_DEED
        text = label.strip()
        for member, prefix in (
            (cls.HYBRID, "Hybrid"),
            (cls.REDEEMABLE_DEED, "Redeemable"),
            (cls.TAX_LIEN, "Tax Lien"),
            (cls.TAX_DEED, "Tax Deed"),
        ):
            if text.startswith(prefix):
                return member
        return cls.TAX_DEED


Recommendation = Literal["bid", "no-bid", "insufficient-data"]
Confidence = Literal["high", "medium", "low"]


class DealInputs(BaseModel):
    """
    What the caller knows about a parcel.

    Accepts both snake_case and the camelCase the ingestion side and the HTTP
    API speak, so one shape crosses every boundary.
    """

    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    state: str
    sale_type: SaleType = Field(alias="saleType")

    #: 5-digit county FIPS. Optional, but it matters wherever a county departs
    #: from its state's assessment ratio -- Cook County assesses residential at
    #: 10% against Illinois' statutory 33-1/3%, so omitting it there overstates
    #: the property threefold.
    fips: str | None = None

    opening_bid: float | None = Field(default=None, alias="openingBid")
    assessed_value: float | None = Field(default=None, alias="assessedValue")

    #: A real comparable-sales figure, when the user has one. Beats everything.
    arv_override: float | None = Field(default=None, alias="arvOverride")
    #: A provider's market estimate (ATTOM market total, RentCast AVM). Ranks
    #: above the assessed derivation because it is already a market figure and
    #: needs no ratio -- which is what makes it usable in states with no
    #: statutory ratio on file.
    market_value: float | None = Field(default=None, alias="marketValue")

    rehab_cost: float | None = Field(default=None, alias="rehabCost")
    target_margin: float | None = Field(default=None, alias="targetMargin")
    holding_months: int | None = Field(default=None, alias="holdingMonths")
    surviving_liens: float | None = Field(default=None, alias="survivingLiens")
    selling_cost_rate: float | None = Field(default=None, alias="sellingCostRate")

    @field_validator("state")
    @classmethod
    def _upper(cls, v: str) -> str:
        return v.strip().upper()

    @field_validator("sale_type", mode="before")
    @classmethod
    def _coerce_sale_type(cls, v: Any) -> Any:
        return SaleType.coerce(v) if isinstance(v, str) else v

    @field_validator("target_margin")
    @classmethod
    def _sane_margin(cls, v: float | None) -> float | None:
        if v is not None and not (0.0 <= v < 1.0):
            raise ValueError("target_margin is a fraction of ARV, e.g. 0.30 for 30%")
        return v


class CostLine(BaseModel):
    """One line of the cost stack, with where the number came from."""

    label: str
    amount: float
    #: Shown in the UI, never hidden. The coach quotes this verbatim.
    note: str
    #: True when this is an assumed default rather than a user or source value.
    assumed: bool


class BidDownObservation(BaseModel):
    """What the market actually paid, where the penalty is set by bidding."""

    observed_median: float
    observed_mean: float
    n: int
    penalty_at_max_bid_observed: float
    source: str
    note: str


class RedemptionOutlook(BaseModel):
    """What happens if the prior owner reclaims the property."""

    window_days: int
    #: Flat statutory penalty for the first tier, e.g. 0.25 for 25%.
    flat_penalty: float
    #: Dollar penalty earned if the owner redeems at the recommended max bid.
    penalty_at_max_bid: float
    #: The flat penalty expressed as an annual rate over the *shortest* window.
    #: Reported separately and labelled, because it is the figure that gets
    #: quoted misleadingly: Texas's 25% over 180 days annualises to ~56%, which
    #: is true only if the owner redeems on the last possible day and you
    #: immediately redeploy the capital.
    annualised_best_case: float
    extended_for: str | None = None
    note: str
    #: Present only where bidders compete by lowering the rate. `flat_penalty`
    #: is then the legal ceiling, and this is the base case.
    market_penalty: BidDownObservation | None = None


class ArvBasis(BaseModel):
    """The after-repair value, and an honest account of where it came from."""

    value: float | None
    basis: str
    derived: bool
    #: A county-specific assessment ratio replaced the state default.
    county_override: bool = False
    #: The ARV came from a provider market estimate, not an assessment ratio.
    from_market: bool = False
    #: A statistical floor from the opening bid rather than a valuation of this
    #: parcel. Load-bearing: a figure nobody measured must not be rendered like
    #: one somebody did, and everything downstream inherits the uncertainty.
    assumed: bool = False


class DealResult(BaseModel):
    """
    The walk-away price and everything needed to defend it.

    `max_bid` is None whenever the engine cannot responsibly produce one. That
    is a first-class answer, not a failure -- see `recommendation`.
    """

    max_bid: float | None
    recommendation: Recommendation
    confidence: Confidence
    arv: ArvBasis
    costs: list[CostLine]
    total_costs: float
    #: Profit at exactly `max_bid` -- by construction, margin x ARV.
    projected_profit: float | None
    #: Headroom between the opening bid and the ceiling: the room to compete.
    bid_room: float | None
    redemption: RedemptionOutlook | None
    statute: dict[str, Any] | None
    warnings: list[str]

    def money_fields(self) -> dict[str, float]:
        """
        Every dollar figure this result asserts, flattened.

        The numeric-provenance guardrail uses this to build the set of amounts
        an assistant turn is permitted to state. If a figure is not in here and
        not in the user's own message, the model made it up.
        """
        out: dict[str, float] = {}
        if self.max_bid is not None:
            out["max_bid"] = self.max_bid
        if self.projected_profit is not None:
            out["projected_profit"] = self.projected_profit
        if self.bid_room is not None:
            out["bid_room"] = self.bid_room
        if self.arv.value is not None:
            out["arv"] = self.arv.value
        out["total_costs"] = self.total_costs
        for i, c in enumerate(self.costs):
            out[f"cost.{i}.{c.label}"] = c.amount
        if self.redemption:
            out["redemption.penalty_at_max_bid"] = self.redemption.penalty_at_max_bid
            if self.redemption.market_penalty:
                out["redemption.observed"] = (
                    self.redemption.market_penalty.penalty_at_max_bid_observed
                )
        return out
