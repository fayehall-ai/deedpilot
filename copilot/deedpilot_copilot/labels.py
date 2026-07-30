"""
Label semantics for recorded historical outcomes.

The JSONL records what a county published. It does not record what those fields
*mean*, and the meaning differs enough between sources that fitting one model
across all of them is wrong in a way that silently inverts the economics.

Two concrete failures this module exists to prevent:

1. ``redeemed=False`` is a **pydantic default**, not an observation. Cook County
   publishes which PINs sold; it does not publish which liens later redeemed.
   Fitting ``p_redeem`` over those rows counts 70k non-observations as 70k
   observed non-redemptions, which drove IL Tax Lien to p_redeem=0.02 against an
   expert prior of 0.72 — i.e. the simulator believed an Illinois lien almost
   never redeems, when redemption is the entire thesis of a lien purchase.

2. ``winning_bid`` is not the same quantity across sources. Illinois annual tax
   sales are bid **down on the penalty rate** with the price fixed at the taxes
   owed; Maryland uses a high-bid premium; Michigan Title Check publishes a real
   competitive clearing price. Pooling them produces a "market price" model
   fitted mostly on tax amounts.

Classification is derived, not stored — a pure function of (id, source, notes)
so it stays reproducible and reviewable in version control, the same way the
county atlas is authored in code rather than the database.
"""

from __future__ import annotations

from collections import Counter
from enum import Enum
from typing import Iterable

from pydantic import BaseModel

from .schemas import HistoricalOutcome


class Disposition(str, Enum):
    """What happened to the position after the sale."""

    #: Owner redeemed the lien/deed after an investor bought it.
    REDEEMED_POST_SALE = "redeemed_post_sale"
    #: Sold at auction to an investor. Says nothing about later redemption.
    SOLD_TO_INVESTOR = "sold_to_investor"
    #: Owner paid before the sale — the parcel never sold. Not an investor event.
    CURED_PRE_SALE = "cured_pre_sale"
    #: Offered, no bidder.
    NO_SALE = "no_sale"
    #: Source does not say.
    UNKNOWN = "unknown"


class PriceKind(str, Enum):
    """What the recorded ``winning_bid`` number actually is."""

    #: Competitive dollar price a rival bidder had to beat. Comparable.
    CLEARING_PRICE = "clearing_price"
    #: Price fixed at taxes owed; competition happens on the penalty rate.
    TAX_AMOUNT_BID_DOWN = "tax_amount_bid_down"
    #: High-bid-premium structure; not comparable to a clearing price.
    PREMIUM_BID = "premium_bid"
    #: Unparseable, or extracted by a regex we do not trust.
    UNKNOWN = "unknown"


class RowLabel(BaseModel):
    """Derived semantics for one historical row."""

    rule_id: str
    disposition: Disposition
    price_kind: PriceKind
    #: True only when ``redeemed`` reflects a real observation (including a
    #: statutory guarantee that post-sale redemption cannot occur).
    redemption_observed: bool
    #: True when ``winning_bid`` may be pooled into a clearing-price model.
    price_usable: bool
    #: True when the row must be excluded from fitting entirely.
    quarantined: bool
    reason: str


def _has(text: str | None, *needles: str) -> bool:
    t = (text or "").lower()
    return any(n.lower() in t for n in needles)


def classify(o: HistoricalOutcome) -> RowLabel:
    """
    Map one row to its observation semantics. Ordered rules, first match wins.

    Every branch states *why*, because these judgements are the difference
    between a calibrated simulator and a confidently wrong one.
    """
    src = o.source or ""
    notes = o.notes or ""
    rid = o.id or ""

    # 1) Map-crawl rows are regex extractions over arbitrary county pages. One
    #    of them scraped "42" out of the Arizona statute numbering (42-18102)
    #    and recorded it as a winning bid. Not fittable.
    if rid.startswith("map-") or _has(notes, "Extracted sold price from county-map source page"):
        return RowLabel(
            rule_id="map_crawl",
            disposition=Disposition.UNKNOWN,
            price_kind=PriceKind.UNKNOWN,
            redemption_observed=False,
            price_usable=False,
            quarantined=True,
            reason=(
                "Map-crawl regex extraction over an arbitrary county page; known "
                "false positives (statute section numbers parsed as prices)."
            ),
        )

    # 2) San Diego lists parcels the owner cured before the auction. This is a
    #    pre-sale cancellation, not a post-sale investor redemption — the parcel
    #    never sold, so it belongs in neither numerator nor denominator.
    if _has(src, "sdttc.com") and _has(notes, "status REDEEMED", "owner cured"):
        return RowLabel(
            rule_id="ca_sandiego_cured_pre_sale",
            disposition=Disposition.CURED_PRE_SALE,
            price_kind=PriceKind.UNKNOWN,
            redemption_observed=False,
            price_usable=False,
            quarantined=True,
            reason=(
                "Owner cured before the sale — parcel never sold to an investor. "
                "Counting these as redemptions conflates pre-sale cures with "
                "post-sale redemption, which is a different event with different "
                "economics."
            ),
        )

    # 3) California deed sales that actually sold. Competitive dollar auction.
    if _has(src, "sdttc.com", "placer.ca.gov", "sonomacounty.gov", "lanecountyor.gov") or (
        rid.startswith("ca-") and _has(notes, "Status=SOLD")
    ):
        usable = bool(o.winning_bid and o.winning_bid > 0)
        return RowLabel(
            rule_id="ca_county_sold",
            disposition=Disposition.SOLD_TO_INVESTOR,
            price_kind=PriceKind.CLEARING_PRICE if usable else PriceKind.UNKNOWN,
            # California deeds convey without a post-sale right of redemption,
            # but these lists do not track the position afterwards either way.
            redemption_observed=False,
            price_usable=usable,
            quarantined=False,
            reason="County final report of sale — competitive dollar clearing price.",
        )

    # 4) Illinois annual tax sale. Bidders compete by bidding the penalty rate
    #    DOWN (many rows show winning_bid_percent=0); the cash price is the
    #    delinquent tax owed. There is real price-relevant signal in the *rate*,
    #    none in the dollar amount, and no redemption follow-up is published.
    if _has(src, "cookcountyil") or _has(notes, "Cook County Annual Tax Sale", "Lien not deed"):
        return RowLabel(
            rule_id="il_cook_bid_down",
            disposition=Disposition.SOLD_TO_INVESTOR,
            price_kind=PriceKind.TAX_AMOUNT_BID_DOWN,
            redemption_observed=False,
            price_usable=False,
            quarantined=False,
            reason=(
                "Illinois annual tax sale is bid down on the penalty rate, not "
                "price; winning_bid is the delinquent tax amount. Sale is "
                "observed; subsequent redemption is not published."
            ),
        )

    # 5) Maryland high-bid premium. Recorded bid_amount runs ~42x the opening
    #    bid at the median, which is not an auction premium — it is a different
    #    quantity (full lien/valuation component) sharing a column name.
    if _has(src, "howardcountymd") or _has(notes, "Howard County MD open-data"):
        return RowLabel(
            rule_id="md_howard_premium_bid",
            disposition=Disposition.SOLD_TO_INVESTOR,
            price_kind=PriceKind.PREMIUM_BID,
            redemption_observed=False,
            price_usable=False,
            quarantined=True,
            reason=(
                "Maryland high-bid-premium structure; recorded bid_amount is ~42x "
                "the opening bid at the median, so it is not a comparable clearing "
                "price. Quarantined pending a field-mapping review."
            ),
        )

    # 6) Michigan Title Check foreclosure auctions. Real competitive prices, and
    #    the one place redeemed=False is a genuine observation: the General
    #    Property Tax Act extinguishes the right of redemption at the foreclosure
    #    judgment, so a post-sale redemption cannot occur by statute.
    if _has(src, "tax-sale.info") or _has(notes, "MI tax deed sold at Title Check auction"):
        usable = bool(o.winning_bid and o.winning_bid > 0)
        return RowLabel(
            rule_id="mi_titlecheck_sold",
            disposition=Disposition.SOLD_TO_INVESTOR,
            price_kind=PriceKind.CLEARING_PRICE if usable else PriceKind.UNKNOWN,
            redemption_observed=True,
            price_usable=usable,
            quarantined=False,
            reason=(
                "Michigan foreclosure auction clearing price. Redemption is "
                "extinguished at the foreclosure judgment, so redeemed=False is a "
                "statutory observation rather than a missing value."
            ),
        )

    return RowLabel(
        rule_id="unclassified",
        disposition=Disposition.UNKNOWN,
        price_kind=PriceKind.UNKNOWN,
        redemption_observed=False,
        price_usable=False,
        quarantined=True,
        reason="No label rule matched this source; excluded until one is written.",
    )


def classify_all(rows: Iterable[HistoricalOutcome]) -> list[tuple[HistoricalOutcome, RowLabel]]:
    return [(o, classify(o)) for o in rows]


def redemption_observed_rows(rows: Iterable[HistoricalOutcome]) -> list[HistoricalOutcome]:
    """Rows where ``redeemed`` may be counted — the only valid p_redeem sample."""
    return [o for o in rows if classify(o).redemption_observed]


def clearing_price_rows(rows: Iterable[HistoricalOutcome]) -> list[HistoricalOutcome]:
    """Rows whose ``winning_bid`` is a comparable competitive clearing price."""
    return [o for o in rows if classify(o).price_usable]


def label_summary(rows: Iterable[HistoricalOutcome]) -> dict:
    """Auditable breakdown of what the corpus actually observes."""
    rows = list(rows)
    by_rule: Counter[str] = Counter()
    by_disp: Counter[str] = Counter()
    by_price: Counter[str] = Counter()
    reasons: dict[str, str] = {}
    n_redemption_obs = 0
    n_price_usable = 0
    n_quarantined = 0

    for o in rows:
        lab = classify(o)
        by_rule[lab.rule_id] += 1
        by_disp[lab.disposition.value] += 1
        by_price[lab.price_kind.value] += 1
        reasons.setdefault(lab.rule_id, lab.reason)
        n_redemption_obs += int(lab.redemption_observed)
        n_price_usable += int(lab.price_usable)
        n_quarantined += int(lab.quarantined)

    return {
        "n_rows": len(rows),
        "n_redemption_observed": n_redemption_obs,
        "n_price_usable": n_price_usable,
        "n_quarantined": n_quarantined,
        "by_rule": dict(by_rule.most_common()),
        "by_disposition": dict(by_disp.most_common()),
        "by_price_kind": dict(by_price.most_common()),
        "rule_reasons": reasons,
    }
