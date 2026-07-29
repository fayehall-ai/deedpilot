"""Structured schemas for trajectories, reflections, and tool I/O."""

from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, Field


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class SaleType(str, Enum):
    TAX_LIEN = "Tax Lien"
    TAX_DEED = "Tax Deed"
    REDEEMABLE_DEED = "Redeemable Deed"
    HYBRID = "Hybrid"


class Lot(BaseModel):
    """A single auction parcel the agent is considering."""

    lot_id: str
    fips: str
    state: str
    county_name: str | None = None
    parcel_id: str | None = None
    address: str | None = None
    opening_bid: float | None = None
    assessed_value: float | None = None
    arv_override: float | None = None
    rehab_cost: float | None = None
    surviving_liens: float | None = None
    sale_type: SaleType | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class DealInputs(BaseModel):
    state: str
    sale_type: SaleType
    opening_bid: float | None = None
    assessed_value: float | None = None
    arv_override: float | None = None
    rehab_cost: float | None = None
    target_margin: float | None = 0.3
    holding_months: float | None = None
    surviving_liens: float | None = None
    selling_cost_rate: float | None = None


class CostLine(BaseModel):
    label: str
    amount: float
    note: str
    assumed: bool = False


class DealResult(BaseModel):
    max_bid: float | None
    recommendation: Literal["bid", "no-bid", "insufficient-data"]
    confidence: Literal["high", "medium", "low"]
    arv_value: float | None
    arv_basis: str
    costs: list[CostLine]
    total_costs: float
    projected_profit: float | None
    bid_room: float | None
    redemption: dict[str, Any] | None = None
    statute: dict[str, Any] | None = None
    warnings: list[str] = Field(default_factory=list)


class AtlasResult(BaseModel):
    fips: str
    state: str
    county: str
    sale_type: str
    type_label: str
    redemption: str
    returns: str
    statute: str
    notes: str
    surviving_liens: str | None = None
    quiet_title: str | None = None
    deposit_rules: str | None = None
    auction_format: str | None = None
    growth_neighborhoods: list[dict[str, str]] = Field(default_factory=list)
    is_state_default: bool
    inherited: list[str]
    as_of: str | None = None
    sources: list[str] = Field(default_factory=list)
    must_cite: list[str] = Field(
        default_factory=lambda: ["as_of", "sources", "inherited", "is_state_default"]
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
