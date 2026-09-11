"""
Inventory reads.

This is the only path from the agent layer to the database. Every query here
filters to real, biddable inventory unless the caller explicitly asks
otherwise, so a coach cannot accidentally walk a novice through a parcel that
was never for sale.

The `include_non_inventory` escape hatch exists because "why is this parcel not
in your inventory?" is a fair question with a real answer, and the honest reply
names the listing kind rather than pretending the parcel does not exist.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import Any
from uuid import UUID

from sqlalchemy import Select, and_, func, or_, select
from sqlalchemy.orm import selectinload

from deedpilot.data.db import session
from deedpilot.data.models import Auction, ListingKind, Lot, LotSignal, LotValuation


def _biddable(stmt: Select[Any]) -> Select[Any]:
    """Narrow a query to sales a subscriber can actually bid on."""
    return stmt.where(
        and_(
            Auction.delisted_at.is_(None),
            Auction.listing_kind == ListingKind.SALE_LIST,
            Auction.sale_date_confirmed.is_(True),
        )
    )


@dataclass(slots=True)
class InventoryStats:
    """Headline counts, for "what do you actually have?"."""

    biddable_auctions: int
    biddable_lots: int
    states: int
    counties: int
    next_sale_date: date | None
    #: Parcels held but excluded from inventory, by why they were excluded.
    excluded_by_kind: dict[str, int]


async def inventory_stats() -> InventoryStats:
    """
    What the system holds right now, counted honestly.

    The excluded breakdown is returned alongside rather than hidden, because a
    coach asked "how many properties do you track" should be able to give both
    numbers and say which one is bidable.
    """
    async with session() as s:
        biddable = (
            await s.execute(
                _biddable(
                    select(
                        func.count(func.distinct(Auction.id)),
                        func.count(Lot.id),
                        func.count(func.distinct(func.left(Lot.county_fips, 2))),
                        func.count(func.distinct(Lot.county_fips)),
                        func.min(Auction.sale_date).filter(Auction.sale_date >= func.current_date()),
                    ).select_from(Auction).join(Lot, Lot.auction_id == Auction.id)
                )
            )
        ).one()

        excluded_rows = (
            await s.execute(
                select(Auction.listing_kind, Auction.sale_date_confirmed, func.count(Lot.id))
                .select_from(Auction)
                .join(Lot, Lot.auction_id == Auction.id)
                .where(
                    Auction.delisted_at.is_(None),
                    or_(
                        Auction.listing_kind != ListingKind.SALE_LIST,
                        Auction.sale_date_confirmed.is_not(True),
                    ),
                )
                .group_by(Auction.listing_kind, Auction.sale_date_confirmed)
            )
        ).all()

    excluded: dict[str, int] = {}
    for kind, confirmed, n in excluded_rows:
        if not n:
            continue
        label = str(kind.value if hasattr(kind, "value") else kind or "unknown")
        if label == ListingKind.SALE_LIST.value and not confirmed:
            label = "sale_list (date not confirmed by the county)"
        excluded[label] = excluded.get(label, 0) + int(n)

    return InventoryStats(
        biddable_auctions=int(biddable[0] or 0),
        biddable_lots=int(biddable[1] or 0),
        states=int(biddable[2] or 0),
        counties=int(biddable[3] or 0),
        next_sale_date=biddable[4],
        excluded_by_kind=excluded,
    )


async def upcoming_auctions(
    *,
    state: str | None = None,
    county_fips: str | None = None,
    within_days: int | None = None,
    limit: int = 25,
) -> list[dict[str, Any]]:
    """Sales that have not happened yet, soonest first."""
    stmt = _biddable(
        select(
            Auction.id,
            Auction.county_fips,
            Auction.sale_date,
            Auction.title,
            Auction.sale_type,
            Auction.platform,
            Auction.source_url,
            Auction.registration_deadline,
            Auction.deposit_deadline,
            func.count(Lot.id).label("lots"),
        )
        .select_from(Auction)
        .outerjoin(Lot, Lot.auction_id == Auction.id)
        .where(Auction.sale_date >= func.current_date())
    )
    if state:
        stmt = stmt.where(Auction.county_fips.like(f"{_state_fips(state)}%"))
    if county_fips:
        stmt = stmt.where(Auction.county_fips == county_fips)
    if within_days is not None:
        stmt = stmt.where(
            Auction.sale_date <= func.current_date() + func.cast(within_days, __import__("sqlalchemy").Integer)
        )

    stmt = (
        stmt.group_by(
            Auction.id,
            Auction.county_fips,
            Auction.sale_date,
            Auction.title,
            Auction.sale_type,
            Auction.platform,
            Auction.source_url,
            Auction.registration_deadline,
            Auction.deposit_deadline,
        )
        .order_by(Auction.sale_date.asc())
        .limit(limit)
    )

    async with session() as s:
        rows = (await s.execute(stmt)).all()

    return [
        {
            "auction_id": str(r.id),
            "county_fips": r.county_fips,
            "sale_date": r.sale_date.isoformat() if r.sale_date else None,
            "title": r.title,
            "sale_type": str(r.sale_type.value) if r.sale_type else None,
            "platform": r.platform,
            "source_url": r.source_url,
            "registration_deadline": (
                r.registration_deadline.isoformat() if r.registration_deadline else None
            ),
            "deposit_deadline": r.deposit_deadline.isoformat() if r.deposit_deadline else None,
            "lot_count": int(r.lots or 0),
        }
        for r in rows
    ]


async def search_lots(
    *,
    state: str | None = None,
    county_fips: str | None = None,
    max_opening_bid: float | None = None,
    min_assessed_value: float | None = None,
    has_coordinates: bool | None = None,
    limit: int = 25,
    include_non_inventory: bool = False,
) -> list[dict[str, Any]]:
    """
    Find parcels matching a filter.

    Ordered by assessed value descending so the first page is the parcels worth
    looking at rather than whichever the database happened to return.
    """
    stmt = (
        select(Lot, Auction)
        .join(Auction, Auction.id == Lot.auction_id)
        .where(Auction.sale_date >= func.current_date())
    )
    if not include_non_inventory:
        stmt = _biddable(stmt)
    if state:
        stmt = stmt.where(Lot.county_fips.like(f"{_state_fips(state)}%"))
    if county_fips:
        stmt = stmt.where(Lot.county_fips == county_fips)
    if max_opening_bid is not None:
        stmt = stmt.where(Lot.opening_bid.is_not(None), Lot.opening_bid <= max_opening_bid)
    if min_assessed_value is not None:
        stmt = stmt.where(Lot.assessed_value.is_not(None), Lot.assessed_value >= min_assessed_value)
    if has_coordinates:
        stmt = stmt.where(Lot.latitude.is_not(None), Lot.longitude.is_not(None))

    stmt = stmt.order_by(Lot.assessed_value.desc().nulls_last()).limit(limit)

    async with session() as s:
        rows = (await s.execute(stmt)).all()

    return [_lot_summary(lot, auction) for lot, auction in rows]


async def get_lot(lot_id: str | UUID) -> dict[str, Any] | None:
    """
    One parcel, with everything observed about it.

    Valuations and signals come back attached, because the caller is about to
    price it and every one of those is an input the arithmetic wants.
    """
    stmt = (
        select(Lot)
        .options(selectinload(Lot.valuations), selectinload(Lot.signals), selectinload(Lot.auction))
        .where(Lot.id == (UUID(str(lot_id)) if not isinstance(lot_id, UUID) else lot_id))
    )
    async with session() as s:
        lot = (await s.execute(stmt)).scalar_one_or_none()
        if lot is None:
            return None

        summary = _lot_summary(lot, lot.auction)
        summary["valuations"] = [_valuation(v) for v in lot.valuations]
        summary["signals"] = [_signal(sig) for sig in _rank_signals(lot.signals)]
        summary["is_biddable_inventory"] = lot.auction.is_biddable_inventory
        if not lot.auction.is_biddable_inventory:
            summary["not_inventory_because"] = _why_not_inventory(lot.auction)
        return summary


async def best_valuation(lot_id: str | UUID) -> dict[str, Any] | None:
    """
    The valuation the pricing engine should use, and why that one.

    A market estimate outranks an assessment because it is already a market
    figure rather than an assessed one waiting to be divided by a statutory
    ratio. Among equals, the most recently fetched wins.
    """
    async with session() as s:
        rows = (
            await s.execute(
                select(LotValuation)
                .where(LotValuation.lot_id == UUID(str(lot_id)))
                .order_by(LotValuation.fetched_at.desc().nulls_last())
            )
        ).scalars().all()

    if not rows:
        return None
    with_market = next((v for v in rows if v.market_value), None)
    chosen = with_market or next((v for v in rows if v.assessed_total), rows[0])
    out = _valuation(chosen)
    out["chosen_because"] = (
        "provider market estimate — already a market figure, needs no assessment ratio"
        if with_market
        else "assessed total — no provider market estimate on file for this parcel"
    )
    return out


# --------------------------------------------------------------------------
# Shaping
# --------------------------------------------------------------------------

_STATE_FIPS = {
    "AL": "01", "AK": "02", "AZ": "04", "AR": "05", "CA": "06", "CO": "08", "CT": "09",
    "DE": "10", "DC": "11", "FL": "12", "GA": "13", "HI": "15", "ID": "16", "IL": "17",
    "IN": "18", "IA": "19", "KS": "20", "KY": "21", "LA": "22", "ME": "23", "MD": "24",
    "MA": "25", "MI": "26", "MN": "27", "MS": "28", "MO": "29", "MT": "30", "NE": "31",
    "NV": "32", "NH": "33", "NJ": "34", "NM": "35", "NY": "36", "NC": "37", "ND": "38",
    "OH": "39", "OK": "40", "OR": "41", "PA": "42", "RI": "44", "SC": "45", "SD": "46",
    "TN": "47", "TX": "48", "UT": "49", "VT": "50", "VA": "51", "WA": "53", "WV": "54",
    "WI": "55", "WY": "56",
}


def _state_fips(state: str) -> str:
    code = _STATE_FIPS.get(state.strip().upper())
    if code is None:
        raise ValueError(f"unknown state {state!r}")
    return code


def _num(v: Decimal | None) -> float | None:
    return float(v) if v is not None else None


def _lot_summary(lot: Lot, auction: Auction | None) -> dict[str, Any]:
    return {
        "lot_id": str(lot.id),
        "county_fips": lot.county_fips,
        "parcel_number": lot.parcel_number,
        "lot_number": lot.lot_number,
        "address": lot.address_line,
        "city": lot.city,
        "zip": lot.zip,
        "latitude": _num(lot.latitude),
        "longitude": _num(lot.longitude),
        "opening_bid": _num(lot.opening_bid),
        "assessed_value": _num(lot.assessed_value),
        "taxes_owed": _num(lot.taxes_owed),
        "land_use": lot.land_use,
        "acreage": _num(lot.acreage),
        "building_sqft": lot.building_sqft,
        "year_built": lot.year_built,
        "status": str(lot.status.value) if lot.status else None,
        "source_url": lot.source_url,
        "sale_date": (
            auction.sale_date.isoformat() if auction and auction.sale_date else None
        ),
        "sale_type": (
            str(auction.sale_type.value) if auction and auction.sale_type else None
        ),
        "auction_id": str(lot.auction_id),
    }


def _valuation(v: LotValuation) -> dict[str, Any]:
    return {
        "source": v.source,
        "tax_year": v.tax_year,
        "assessed_total": _num(v.assessed_total),
        "market_value": _num(v.market_value),
        "last_sale_amount": _num(v.last_sale_amount),
        "last_sale_date": v.last_sale_date.isoformat() if v.last_sale_date else None,
        "zoning": v.zoning,
        "flood_zone": v.flood_zone,
        "beds": v.beds,
        "baths": _num(v.baths),
        "building_sqft": v.building_sqft,
        "lot_sqft": v.lot_sqft,
        "year_built": v.year_built,
        "property_type": v.property_type,
        "fetched_at": v.fetched_at.isoformat() if v.fetched_at else None,
    }


def _signal(sig: LotSignal) -> dict[str, Any]:
    return {
        "kind": sig.kind,
        "label": sig.label,
        "note": sig.note,
        "direction": str(sig.direction.value) if sig.direction else None,
        "severity": str(sig.severity.value) if sig.severity else None,
        "distance_m": sig.distance_m,
        "distance_basis": sig.distance_basis,
        "value_text": sig.value_text,
        "source": sig.source,
        "observed_at": sig.observed_at.isoformat() if sig.observed_at else None,
    }


_SEVERITY_ORDER = {"high": 0, "medium": 1, "low": 2}


def _rank_signals(signals: list[LotSignal]) -> list[LotSignal]:
    """
    Worst news first.

    A novice reading a signal list top-down should hit "no road frontage"
    before "park within 800m". Negative-and-high leads; within a severity,
    nearer features outrank distant ones.
    """
    return sorted(
        signals,
        key=lambda s: (
            0 if s.direction and s.direction.value == "negative" else 1,
            _SEVERITY_ORDER.get(s.severity.value if s.severity else "low", 3),
            s.distance_m if s.distance_m is not None else 10**9,
        ),
    )


def _why_not_inventory(auction: Auction) -> str:
    """Plain-language reason a parcel is held but not counted as biddable."""
    if auction.delisted_at is not None:
        return (
            f"The county stopped publishing this sale (last seen "
            f"{auction.delisted_at.date().isoformat()}). It may have been cancelled or already held."
        )
    kind = auction.listing_kind.value if auction.listing_kind else "unknown"
    if kind == "delinquent_list":
        return (
            "This came off a delinquent tax roll, not a sale list. Most owners on a delinquent "
            "roll pay before any sale happens, so these parcels are not for sale today."
        )
    if kind == "lands_available":
        return (
            "This is lands-available inventory — property that went unsold at a previous auction "
            "and can usually be bought over the counter rather than bid on."
        )
    if kind == "unknown":
        return (
            "We could not tell what kind of list this came off, so it is held out of inventory "
            "until someone confirms it."
        )
    if not auction.sale_date_confirmed:
        return (
            "The sale date was projected from this state's typical schedule, not published by the "
            "county. Until the county confirms a date, this is not something to plan around."
        )
    return "Held out of inventory."
