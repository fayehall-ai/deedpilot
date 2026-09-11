"""
Persistence models.

Only *observed* data lives here. Rules live in the atlas, arithmetic lives in
`deedpilot.domain`, and neither is stored in a row that could drift from the
version-controlled source.

The two flags on `Auction` carry more weight than anything else in this file.
Counties publish delinquent rolls, lands-available inventory and actual sale
lists from the same page, in the same format, and the difference is not visible
to a parser: a delinquent roll has parcels, owners, addresses and dollar
amounts, exactly like a sale list, and is routinely 10-50x larger because most
owners pay before any levy. So every auction asserts what kind of list it came
from and whether its date came from the county or from a projection, and only
`sale_list` + confirmed is ever counted as something to bid on.
"""

from __future__ import annotations

import enum
from datetime import date, datetime
from decimal import Decimal
from typing import Any
from uuid import UUID

from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    Enum,
    ForeignKey,
    Integer,
    Numeric,
    String,
    Text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    """Declarative base for every mapped table."""


class SaleTypeEnum(enum.StrEnum):
    TAX_LIEN = "Tax Lien"
    TAX_DEED = "Tax Deed"
    REDEEMABLE_DEED = "Redeemable Deed"
    HYBRID = "Hybrid"


class ListingKind(enum.StrEnum):
    """
    What kind of list this auction's parcels came off.

    Asserted by the adapter that read the page, never inferred downstream.
    """

    SALE_LIST = "sale_list"
    DELINQUENT_LIST = "delinquent_list"
    LANDS_AVAILABLE = "lands_available"
    UNKNOWN = "unknown"


class AuctionStatus(enum.StrEnum):
    SCHEDULED = "scheduled"
    LIVE = "live"
    CLOSED = "closed"
    CANCELLED = "cancelled"
    POSTPONED = "postponed"


class LotStatus(enum.StrEnum):
    PENDING = "pending"
    SOLD = "sold"
    REDEEMED = "redeemed"
    CANCELLED = "cancelled"
    STRUCK = "struck"
    WITHDRAWN = "withdrawn"


class SignalDirection(enum.StrEnum):
    NEGATIVE = "negative"
    POSITIVE = "positive"
    NEUTRAL = "neutral"


class SignalSeverity(enum.StrEnum):
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"


def _pg_enum(py_enum: type[enum.StrEnum], name: str) -> Enum:
    """
    Bind to an existing Postgres enum without trying to recreate it.

    `values_callable` makes SQLAlchemy send the enum's *values* rather than its
    Python member names -- without it "Tax Deed" goes to the database as
    "TAX_DEED" and every insert fails on a type it can see right there.
    """
    return Enum(
        py_enum,
        name=name,
        create_type=False,
        native_enum=True,
        values_callable=lambda e: [m.value for m in e],
    )


class Auction(Base):
    """A published sale. May or may not be something you can bid on -- see the flags."""

    __tablename__ = "auctions"

    id: Mapped[UUID] = mapped_column(primary_key=True)
    county_fips: Mapped[str] = mapped_column(Text, index=True)
    platform: Mapped[str | None] = mapped_column(Text)
    sale_type: Mapped[SaleTypeEnum | None] = mapped_column(_pg_enum(SaleTypeEnum, "sale_type"))
    external_id: Mapped[str | None] = mapped_column(Text)
    title: Mapped[str | None] = mapped_column(Text)
    sale_date: Mapped[date | None] = mapped_column(Date, index=True)
    start_time: Mapped[str | None] = mapped_column(Text)
    status: Mapped[AuctionStatus | None] = mapped_column(_pg_enum(AuctionStatus, "auction_status"))
    registration_deadline: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    deposit_deadline: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    source_url: Mapped[str | None] = mapped_column(Text)
    lot_count: Mapped[int | None] = mapped_column(Integer)
    raw: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    first_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    #: False when the date came from projecting the state's typical schedule
    #: rather than from the county saying so.
    sale_date_confirmed: Mapped[bool | None] = mapped_column(Boolean)
    listing_kind: Mapped[ListingKind | None] = mapped_column(
        _pg_enum(ListingKind, "listing_kind")
    )
    #: Set when a later crawl showed this sale is no longer published.
    delisted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    announced_parcel_count: Mapped[int | None] = mapped_column(Integer)

    lots: Mapped[list[Lot]] = relationship(back_populates="auction", lazy="selectin")

    @property
    def is_biddable_inventory(self) -> bool:
        """
        Is this something a subscriber can actually bid on?

        Both halves matter and neither is inferable from the parcels. Before
        this distinction existed, one county's delinquent roll (2,825 parcels)
        and another's procedures page (3,461) made up 65% of the headline lot
        count, under sale dates that were projected and in one case did not
        exist.
        """
        return (
            self.listing_kind == ListingKind.SALE_LIST
            and bool(self.sale_date_confirmed)
            and self.delisted_at is None
        )


class Lot(Base):
    """One parcel in a sale."""

    __tablename__ = "lots"

    id: Mapped[UUID] = mapped_column(primary_key=True)
    auction_id: Mapped[UUID] = mapped_column(ForeignKey("auctions.id"), index=True)
    county_fips: Mapped[str] = mapped_column(Text, index=True)
    external_id: Mapped[str | None] = mapped_column(Text)
    dedupe_key: Mapped[str | None] = mapped_column(Text)
    lot_number: Mapped[str | None] = mapped_column(Text)
    parcel_number: Mapped[str | None] = mapped_column(Text)
    case_number: Mapped[str | None] = mapped_column(Text)

    address_line: Mapped[str | None] = mapped_column(Text)
    city: Mapped[str | None] = mapped_column(Text)
    zip: Mapped[str | None] = mapped_column(Text)
    legal_description: Mapped[str | None] = mapped_column(Text)
    latitude: Mapped[Decimal | None] = mapped_column(Numeric)
    longitude: Mapped[Decimal | None] = mapped_column(Numeric)

    opening_bid: Mapped[Decimal | None] = mapped_column(Numeric)
    assessed_value: Mapped[Decimal | None] = mapped_column(Numeric)
    taxes_owed: Mapped[Decimal | None] = mapped_column(Numeric)

    land_use: Mapped[str | None] = mapped_column(Text)
    acreage: Mapped[Decimal | None] = mapped_column(Numeric)
    building_sqft: Mapped[int | None] = mapped_column(Integer)
    year_built: Mapped[int | None] = mapped_column(Integer)
    owner_name: Mapped[str | None] = mapped_column(Text)

    status: Mapped[LotStatus | None] = mapped_column(_pg_enum(LotStatus, "lot_status"))
    sold_amount: Mapped[Decimal | None] = mapped_column(Numeric)
    sold_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    surplus: Mapped[Decimal | None] = mapped_column(Numeric)

    source_url: Mapped[str | None] = mapped_column(Text)
    raw: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    first_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    auction: Mapped[Auction] = relationship(back_populates="lots")
    valuations: Mapped[list[LotValuation]] = relationship(back_populates="lot", lazy="selectin")
    signals: Mapped[list[LotSignal]] = relationship(back_populates="lot", lazy="selectin")


class LotValuation(Base):
    """A provider's or assessor's view of what a parcel is worth."""

    __tablename__ = "lot_valuations"

    id: Mapped[UUID] = mapped_column(primary_key=True)
    lot_id: Mapped[UUID] = mapped_column(ForeignKey("lots.id"), index=True)
    source: Mapped[str] = mapped_column(Text)
    tax_year: Mapped[int | None] = mapped_column(Integer)
    assessed_land: Mapped[Decimal | None] = mapped_column(Numeric)
    assessed_improvement: Mapped[Decimal | None] = mapped_column(Numeric)
    assessed_total: Mapped[Decimal | None] = mapped_column(Numeric)
    market_value: Mapped[Decimal | None] = mapped_column(Numeric)
    last_sale_amount: Mapped[Decimal | None] = mapped_column(Numeric)
    last_sale_date: Mapped[date | None] = mapped_column(Date)
    homestead: Mapped[bool | None] = mapped_column(Boolean)
    zoning: Mapped[str | None] = mapped_column(Text)
    flood_zone: Mapped[str | None] = mapped_column(Text)
    beds: Mapped[int | None] = mapped_column(Integer)
    baths: Mapped[Decimal | None] = mapped_column(Numeric)
    lot_sqft: Mapped[int | None] = mapped_column(Integer)
    building_sqft: Mapped[int | None] = mapped_column(Integer)
    year_built: Mapped[int | None] = mapped_column(Integer)
    property_type: Mapped[str | None] = mapped_column(Text)
    raw: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    fetched_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    lot: Mapped[Lot] = relationship(back_populates="valuations")


class LotSignal(Base):
    """
    What physically surrounds a parcel.

    A tax notice lists what is owed and an assessment lists what the county
    thinks it is worth. Neither says the parcel backs onto a mainline railway,
    sits inside a special flood hazard area, or has no road touching it at all
    -- and the third of those is how people buy something they cannot resell.

    Every distance is measured to the feature's real geometry and carries its
    source, so a reader can check it on a map in thirty seconds. No signal ever
    produces a dollar figure: proximity is reported, and the max-bid engine
    remains the only thing that prices anything.
    """

    __tablename__ = "lot_signals"

    id: Mapped[UUID] = mapped_column(primary_key=True)
    lot_id: Mapped[UUID] = mapped_column(ForeignKey("lots.id"), index=True)
    kind: Mapped[str] = mapped_column(Text, index=True)
    source: Mapped[str] = mapped_column(Text)
    feature_key: Mapped[str | None] = mapped_column(Text)
    direction: Mapped[SignalDirection | None] = mapped_column(
        _pg_enum(SignalDirection, "signal_direction")
    )
    severity: Mapped[SignalSeverity | None] = mapped_column(
        _pg_enum(SignalSeverity, "signal_severity")
    )
    label: Mapped[str | None] = mapped_column(Text)
    note: Mapped[str | None] = mapped_column(Text)
    distance_m: Mapped[int | None] = mapped_column(Integer)
    distance_basis: Mapped[str | None] = mapped_column(Text)
    value: Mapped[Decimal | None] = mapped_column(Numeric)
    value_text: Mapped[str | None] = mapped_column(Text)
    raw: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    observed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    lot: Mapped[Lot] = relationship(back_populates="signals")


class County(Base):
    """
    Counties, as the ingestion side tracks them.

    The *rules* for a county live in the atlas, not here. This row is
    operational: which counties we crawl, and how that is going.
    """

    __tablename__ = "counties"

    fips: Mapped[str] = mapped_column(Text, primary_key=True)
    name: Mapped[str | None] = mapped_column(Text)
    state: Mapped[str | None] = mapped_column(Text, index=True)


class DealAnalysis(Base):
    """
    A stored run of the max-bid engine.

    Kept so a bid can be reconstructed after the fact -- what the engine said,
    from which inputs, on which day. `result` is the serialised `DealResult`,
    not a summary of it: an audit that paraphrases is not an audit.
    """

    __tablename__ = "deal_analyses"

    id: Mapped[UUID] = mapped_column(primary_key=True)
    lot_id: Mapped[UUID | None] = mapped_column(ForeignKey("lots.id"), index=True)
    inputs: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    result: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    created_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


__all__ = [
    "Auction",
    "AuctionStatus",
    "Base",
    "County",
    "DealAnalysis",
    "ListingKind",
    "Lot",
    "LotSignal",
    "LotStatus",
    "LotValuation",
    "SaleTypeEnum",
    "SignalDirection",
    "SignalSeverity",
]
