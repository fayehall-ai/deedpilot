"""Structured schemas for trajectories, reflections, and tool I/O."""

from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class SaleType(str, Enum):
    TAX_LIEN = "Tax Lien"
    TAX_DEED = "Tax Deed"
    REDEEMABLE_DEED = "Redeemable Deed"
    HYBRID = "Hybrid"


class Lot(BaseModel):
    """A single auction parcel the agent is considering."""

    model_config = ConfigDict(populate_by_name=True)

    lot_id: str = Field(alias="lotId")
    fips: str
    state: str
    county_name: str | None = Field(None, alias="countyName")
    parcel_id: str | None = Field(None, alias="parcelId")
    address: str | None = None
    opening_bid: float | None = Field(None, alias="openingBid")
    assessed_value: float | None = Field(None, alias="assessedValue")
    arv_override: float | None = Field(None, alias="arvOverride")
    rehab_cost: float | None = Field(None, alias="rehabCost")
    surviving_liens: float | None = Field(None, alias="survivingLiens")
    sale_type: SaleType | None = Field(None, alias="saleType")
    metadata: dict[str, Any] = Field(default_factory=dict)


class DealInputs(BaseModel):
    """Inputs to the maxbid oracle. Accepts snake_case or camelCase keys."""

    model_config = ConfigDict(populate_by_name=True)

    state: str
    sale_type: SaleType = Field(alias="saleType")
    opening_bid: float | None = Field(None, alias="openingBid")
    assessed_value: float | None = Field(None, alias="assessedValue")
    arv_override: float | None = Field(None, alias="arvOverride")
    rehab_cost: float | None = Field(None, alias="rehabCost")
    target_margin: float | None = Field(0.3, alias="targetMargin")
    holding_months: float | None = Field(None, alias="holdingMonths")
    surviving_liens: float | None = Field(None, alias="survivingLiens")
    selling_cost_rate: float | None = Field(None, alias="sellingCostRate")


class CostLine(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    label: str
    amount: float
    note: str
    assumed: bool = False


class DealResult(BaseModel):
    """Deterministic maxbid oracle output. Never invent these numbers in an LLM."""

    model_config = ConfigDict(populate_by_name=True)

    max_bid: float | None = Field(alias="maxBid")
    recommendation: Literal["bid", "no-bid", "insufficient-data"]
    confidence: Literal["high", "medium", "low"]
    arv_value: float | None = Field(alias="arvValue")
    arv_basis: str = Field(alias="arvBasis")
    costs: list[CostLine]
    total_costs: float = Field(alias="totalCosts")
    projected_profit: float | None = Field(alias="projectedProfit")
    bid_room: float | None = Field(alias="bidRoom")
    redemption: dict[str, Any] | None = None
    statute: dict[str, Any] | None = None
    warnings: list[str] = Field(default_factory=list)


class AtlasResult(BaseModel):
    """Resolved county rule + provenance. Agent must cite as_of / sources / is_state_default."""

    model_config = ConfigDict(populate_by_name=True)

    fips: str
    state: str
    county: str
    sale_type: str = Field(alias="saleType")
    type_label: str = Field(alias="typeLabel")
    redemption: str
    returns: str
    statute: str
    notes: str
    surviving_liens: str | None = Field(None, alias="survivingLiens")
    quiet_title: str | None = Field(None, alias="quietTitle")
    deposit_rules: str | None = Field(None, alias="depositRules")
    auction_format: str | None = Field(None, alias="auctionFormat")
    growth_neighborhoods: list[dict[str, str]] = Field(
        default_factory=list, alias="growthNeighborhoods"
    )
    is_state_default: bool = Field(alias="isStateDefault")
    inherited: list[str]
    as_of: str | None = Field(None, alias="asOf")
    sources: list[str] = Field(default_factory=list)
    must_cite: list[str] = Field(
        default_factory=lambda: ["as_of", "sources", "inherited", "is_state_default"],
        alias="mustCite",
    )


class AgentAction(BaseModel):
    bid_amount: float | None
    pass_: bool = Field(False, alias="pass")
    rationale: str
    risk_buffers: dict[str, float] = Field(default_factory=dict)

    model_config = {"populate_by_name": True}


class PredictedOutcome(BaseModel):
    p_redeem: float
    expected_profit: float
    expected_loss_if_own: float
    notes: str = ""


class SimulatedOutcome(BaseModel):
    redeemed: bool
    ownership_taken: bool
    cash_in: float
    cash_out: float
    profit_loss: float
    holding_months: float
    quiet_title_cost: float
    penalty_received: float
    details: dict[str, Any] = Field(default_factory=dict)


class HistoricalOutcome(BaseModel):
    """
    One observed (or seed) auction path used to calibrate simulator noise.

    Drop real investor/county outcomes into data/historical_outcomes.jsonl with
    provenance='recorded' or 'investor_log'. Synthetic seed rows are labeled
    provenance='synthetic_seed' and only bootstrap the model until real data
    dominates via sample-size shrinkage.
    """

    id: str
    state: str
    fips: str | None = None
    county_name: str | None = None
    sale_type: SaleType
    sale_date: str | None = None  # YYYY-MM-DD
    opening_bid: float | None = None
    winning_bid: float | None = None
    assessed_value: float | None = None
    arv_estimate: float | None = None
    redeemed: bool
    ownership_taken: bool
    days_to_redeem: float | None = None
    holding_months: float | None = None
    quiet_title_cost: float | None = None
    exit_price: float | None = None  # gross disposition when owned
    profit_loss: float | None = None
    surviving_liens: float | None = None
    rehab_cost: float | None = None
    penalty_rate: float | None = None
    bid_to_arv: float | None = None  # winning_bid / arv when both known
    provenance: Literal[
        "recorded", "synthetic_seed", "investor_log", "inferred"
    ] = "recorded"
    source: str | None = None
    notes: str = ""


class NoiseBucket(BaseModel):
    """Empirical + shrunk noise parameters for one (state, sale_type) bucket."""

    key: str
    state: str | None = None
    sale_type: str | None = None
    n: int = 0
    n_redeemed: int = 0
    p_redeem_raw: float | None = None
    p_redeem: float  # shrunk toward expert prior
    expert_p_redeem: float
    #: Rows whose ``redeemed`` flag is a real observation (see labels.py). This —
    #: not ``n`` — is the denominator behind p_redeem, and the weight used when
    #: shrinking toward the expert prior. When 0, p_redeem *is* the expert prior.
    n_redemption_observed: int = 0
    p_redeem_source: Literal["observed", "expert"] = "expert"
    # Ownership-path exit as fraction of ARV (p10/p50/p90)
    exit_mult_p10: float = 0.72
    exit_mult_p50: float = 0.85
    exit_mult_p90: float = 0.95
    holding_months_mean: float | None = None
    holding_months_std: float | None = None
    qt_cost_mean: float | None = None
    qt_cost_std: float | None = None
    lien_rate: float = 0.2  # P(surviving liens > 0) on ownership path
    mean_lien_if_any: float = 4000.0
    mean_rehab: float | None = None


class SimulatorPriors(BaseModel):
    """Fitted noise model consumed by predict_outcome / simulate_outcome."""

    calibrated_at: str = Field(default_factory=utc_now)
    n_outcomes: int = 0
    provenance_counts: dict[str, int] = Field(default_factory=dict)
    prior_strength: float = 20.0  # pseudo-counts for expert shrinkage
    buckets: dict[str, NoiseBucket] = Field(default_factory=dict)
    by_sale_type: dict[str, NoiseBucket] = Field(default_factory=dict)
    global_bucket: NoiseBucket | None = None
    source_path: str | None = None
    #: Rows dropped before fitting, and why (labels.label_summary output).
    label_summary: dict[str, Any] = Field(default_factory=dict)
    n_quarantined: int = 0
    #: Fields the corpus does not observe at all, so they come from statute /
    #: expert ranges rather than data. Reported so nothing looks fitted when it
    #: is not.
    unobserved_fields: list[str] = Field(default_factory=list)


class ToolCallRecord(BaseModel):
    tool: str
    args: dict[str, Any]
    result_summary: str
    trusted: bool = False


class Trajectory(BaseModel):
    """Full agent trajectory for one lot — the unit of self-improvement."""

    id: str
    created_at: str = Field(default_factory=utc_now)
    lot: Lot
    reasoning_trace: list[str] = Field(default_factory=list)
    tool_calls: list[ToolCallRecord] = Field(default_factory=list)
    action: AgentAction | None = None
    predicted_outcome: PredictedOutcome | None = None
    simulated_or_real_outcome: SimulatedOutcome | None = None
    profit_loss: float | None = None
    sources_used: list[str] = Field(default_factory=list)
    maxbid_result: DealResult | None = None
    atlas_result: AtlasResult | None = None
    critique: dict[str, Any] = Field(default_factory=dict)
    tags: list[str] = Field(default_factory=list)


class ReflectionLesson(BaseModel):
    """Structured lesson from the reflection model / critique stage."""

    id: str
    created_at: str = Field(default_factory=utc_now)
    scope: Literal["global", "state", "county", "sale_type"] = "global"
    scope_key: str | None = None  # e.g. "CA", "06037", "Tax Deed"
    lesson: str
    evidence_trajectory_ids: list[str] = Field(default_factory=list)
    suggested_buffer_usd: float | None = None
    suggested_p_redeem_delta: float | None = None
    confidence: float = 0.5
    active: bool = True


class BacktestMetrics(BaseModel):
    n_lots: int
    n_bids: int
    n_passes: int
    total_profit: float
    mean_profit_per_lot: float
    win_rate: float
    calibration_error: float
    vs_baseline_profit: float
    promoted: bool
    notes: list[str] = Field(default_factory=list)
