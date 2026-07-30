"""
Import *real* historical auction outcomes for the simulator.

Primary source (policy-allowed): Michigan Title Check past results
  https://www.tax-sale.info/pastAuctions/{year}
  https://www.tax-sale.info/listings/auction/{id}

Michigan tax deeds have no post-sale owner redemption (foreclosure judgment
clears title before auction). A "Sold for $X" row is therefore an ownership
take at price X. Unsold lots (only "Minimum Bid") are struck / no buyer and
are stored with ownership_taken=False and redeemed=False for inventory stats,
but are excluded from default calibration of ownership-path noise.

Also supports:
  - Exporting sold/redeemed rows from the DeedPilot Postgres lots table
    (when ingest has filled sold_amount / status).

Synthetic seed generation is intentionally NOT used here.
"""

from __future__ import annotations

import re
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Iterable

from .history import (
    calibrate_priors,
    load_outcomes,
    outcomes_path,
    write_outcomes,
)
from .schemas import HistoricalOutcome, SaleType

BASE = "https://www.tax-sale.info"
USER_AGENT = (
    "Mozilla/5.0 (compatible; DeedPilotHistory/0.1; research; +https://github.com/fayedaihall/deedpilot)"
)
MIN_DELAY_S = 2.1  # match lib/ingest/policy tax-sale.info minDelayMs

# Common MI county name → FIPS (atlas-aligned). Unknown counties keep fips=None.
MI_COUNTY_FIPS: dict[str, str] = {
    "alcona": "26001",
    "alger": "26003",
    "allegan": "26005",
    "alpena": "26007",
    "antrim": "26009",
    "arenac": "26011",
    "baraga": "26013",
    "barry": "26015",
    "bay": "26017",
    "benzie": "26019",
    "berrien": "26021",
    "branch": "26023",
    "calhoun": "26025",
    "cass": "26027",
    "charlevoix": "26029",
    "cheboygan": "26031",
    "chippewa": "26033",
    "clare": "26035",
    "clinton": "26037",
    "crawford": "26039",
    "delta": "26041",
    "dickinson": "26043",
    "eaton": "26045",
    "emmet": "26047",
    "genesee": "26049",
    "gladwin": "26051",
    "gogebic": "26053",
    "grand traverse": "26055",
    "gratiot": "26057",
    "hillsdale": "26059",
    "houghton": "26061",
    "huron": "26063",
    "ingham": "26065",
    "ionia": "26067",
    "iosco": "26069",
    "iron": "26071",
    "isabella": "26073",
    "jackson": "26075",
    "kalamazoo": "26077",
    "kalkaska": "26079",
    "kent": "26081",
    "keweenaw": "26083",
    "lake": "26085",
    "lapeer": "26087",
    "leelanau": "26089",
    "lenawee": "26091",
    "livingston": "26093",
    "luce": "26095",
    "mackinac": "26097",
    "macomb": "26099",
    "manistee": "26101",
    "marquette": "26103",
    "mason": "26105",
    "mecosta": "26107",
    "menominee": "26109",
    "midland": "26111",
    "missaukee": "26113",
    "monroe": "26115",
    "montcalm": "26117",
    "montmorency": "26119",
    "muskegon": "26121",
    "newaygo": "26123",
    "oakland": "26125",
    "oceana": "26127",
    "ogemaw": "26129",
    "ontonagon": "26131",
    "osceola": "26133",
    "oscoda": "26135",
    "otsego": "26137",
    "ottawa": "26139",
    "presque isle": "26141",
    "roscommon": "26143",
    "saginaw": "26145",
    "st clair": "26147",
    "st. clair": "26147",
    "st joseph": "26149",
    "st. joseph": "26149",
    "sanilac": "26151",
    "schoolcraft": "26153",
    "shiawassee": "26155",
    "tuscola": "26157",
    "van buren": "26159",
    "washtenaw": "26161",
    "wayne": "26163",
    "wexford": "26165",
}

_MONEY = re.compile(r"\$\s*([\d,]+(?:\.\d+)?)")
_LOT_H3 = re.compile(
    r"<h3>\s*([^:<]{2,40}?)\s*:\s*Lot\s+(\d+)\s*</h3>",
    re.I,
)
_PORTFOLIO = re.compile(
    r'<div class="portfolio-desc">\s*(.*?)\s*</div>',
    re.I | re.S,
)


def _fetch(url: str, *, pause: bool = True) -> str:
    if pause:
        time.sleep(MIN_DELAY_S)
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            return resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"HTTP {e.code} for {url}") from e


def _money(text: str) -> float | None:
    m = _MONEY.search(text)
    if not m:
        return None
    return float(m.group(1).replace(",", ""))


def _county_fips(name: str) -> str | None:
    key = re.sub(r"\s+", " ", name.strip().lower())
    key = key.replace(" county", "")
    return MI_COUNTY_FIPS.get(key)


def list_past_auction_ids(year: int) -> list[str]:
    html = _fetch(f"{BASE}/pastAuctions/{year}")
    ids = sorted(set(re.findall(r"/listings/auction/(\d+)", html)), key=int)
    return ids


def _sale_date_from_html(html: str) -> str | None:
    m = re.search(r'datetime="(\d{4}-\d{2}-\d{2})T', html)
    if m:
        return m.group(1)
    m = re.search(
        r"(January|February|March|April|May|June|July|August|September|"
        r"October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})",
        html,
        re.I,
    )
    if not m:
        return None
    months = {
        "january": 1,
        "february": 2,
        "march": 3,
        "april": 4,
        "may": 5,
        "june": 6,
        "july": 7,
        "august": 8,
        "september": 9,
        "october": 10,
        "november": 11,
        "december": 12,
    }
    mo = months[m.group(1).lower()]
    return f"{m.group(3)}-{mo:02d}-{int(m.group(2)):02d}"


def parse_auction_page(html: str, *, auction_id: str) -> list[HistoricalOutcome]:
    """Parse a tax-sale.info past auction listing page into outcome rows."""
    sale_date = _sale_date_from_html(html)
    rows: list[HistoricalOutcome] = []

    for block in _PORTFOLIO.findall(html):
        hm = _LOT_H3.search(block)
        if not hm:
            continue
        county = hm.group(1).strip()
        lot_no = hm.group(2).strip()
        # Skip DNR land sales (not county tax foreclosure) — same rule as ingest adapter.
        if re.search(r"\bDNR\b", county, re.I) or re.search(r"\bDNR\b", block, re.I):
            continue
        sold_m = re.search(r"Sold for\s*\$\s*([\d,]+(?:\.\d+)?)", block, re.I)
        min_m = re.search(r"Minimum Bid:\s*\$\s*([\d,]+(?:\.\d+)?)", block, re.I)
        # description span (first plain span-ish text)
        desc_m = re.search(r"<span>([^<]{3,200})", block)
        desc = re.sub(r"\s+", " ", desc_m.group(1)).strip() if desc_m else ""

        if sold_m:
            price = float(sold_m.group(1).replace(",", ""))
            sold = True
            opening = float(min_m.group(1).replace(",", "")) if min_m else None
        elif min_m:
            price = None
            sold = False
            opening = float(min_m.group(1).replace(",", ""))
        else:
            continue

        # Optional parcel-ish from image path in surrounding HTML — not always present in block
        fips = _county_fips(county)
        oid = f"mi-tsi-{auction_id}-{lot_no}"

        if sold:
            rows.append(
                HistoricalOutcome(
                    id=oid,
                    state="MI",
                    fips=fips,
                    county_name=f"{county} County" if not county.lower().endswith("county") else county,
                    sale_type=SaleType.TAX_DEED,
                    sale_date=sale_date,
                    opening_bid=opening,
                    winning_bid=price,
                    assessed_value=None,  # SEV not on past-result cards; enrich later
                    arv_estimate=None,
                    redeemed=False,  # MI: no post-sale redemption
                    ownership_taken=True,
                    days_to_redeem=None,
                    holding_months=None,
                    quiet_title_cost=None,
                    exit_price=None,  # disposition unknown from auction host
                    profit_loss=None,
                    surviving_liens=0.0,  # judgment typically clears prior liens
                    rehab_cost=None,
                    penalty_rate=None,
                    bid_to_arv=None,
                    provenance="recorded",
                    source=f"{BASE}/listings/auction/{auction_id}",
                    notes=(
                        f"MI tax deed sold at Title Check auction. Lot {lot_no}. "
                        f"{desc[:160]} "
                        "No post-sale redemption (foreclosure judgment). "
                        "Exit/rehab unknown until investor disposition."
                    ),
                )
            )
        else:
            # Struck / no buyer — useful for sale-rate stats, not ownership noise
            rows.append(
                HistoricalOutcome(
                    id=f"{oid}-unsold",
                    state="MI",
                    fips=fips,
                    county_name=f"{county} County" if not county.lower().endswith("county") else county,
                    sale_type=SaleType.TAX_DEED,
                    sale_date=sale_date,
                    opening_bid=opening,
                    winning_bid=None,
                    redeemed=False,
                    ownership_taken=False,
                    surviving_liens=None,
                    provenance="recorded",
                    source=f"{BASE}/listings/auction/{auction_id}",
                    notes=(
                        f"Unsold / minimum bid only at auction {auction_id} lot {lot_no}. "
                        f"{desc[:120]}"
                    ),
                )
            )
    return rows


def import_michigan_past_years(
    years: Iterable[int],
    *,
    max_auctions_per_year: int | None = None,
    include_unsold: bool = True,
    progress: bool = True,
) -> list[HistoricalOutcome]:
    """Fetch and parse Michigan past auction results for given calendar years."""
    all_rows: list[HistoricalOutcome] = []
    for year in years:
        try:
            auction_ids = list_past_auction_ids(year)
        except Exception as e:  # noqa: BLE001
            if progress:
                print(f"[mi] year {year}: failed to list auctions — {e}")
            continue
        if max_auctions_per_year is not None:
            auction_ids = auction_ids[:max_auctions_per_year]
        if progress:
            print(f"[mi] year {year}: {len(auction_ids)} auctions")
        for aid in auction_ids:
            try:
                html = _fetch(f"{BASE}/listings/auction/{aid}")
                rows = parse_auction_page(html, auction_id=aid)
                if not include_unsold:
                    rows = [r for r in rows if r.ownership_taken]
                all_rows.extend(rows)
                if progress:
                    sold_n = sum(1 for r in rows if r.ownership_taken)
                    print(f"  auction {aid}: {len(rows)} lots ({sold_n} sold)")
            except Exception as e:  # noqa: BLE001
                if progress:
                    print(f"  auction {aid}: ERROR {e}")
    return all_rows


def export_from_postgres(
    database_url: str,
    *,
    only_with_sold_amount: bool = False,
) -> list[HistoricalOutcome]:
    """
    Pull observed lots from DeedPilot Neon/Postgres into HistoricalOutcome.

    Requires the optional ``psycopg`` package (or use the Node export script).
    Maps:
      status=sold + sold_amount → ownership_taken (deed) or redeemable ownership path
      status=redeemed → pre-sale redeem (owner paid before auction) — not post-sale
    """
    try:
        import psycopg
    except ImportError as e:
        raise RuntimeError(
            "psycopg not installed. pip install psycopg[binary] or use the Node export."
        ) from e

    q = """
    SELECT l.id::text, l.county_fips, l.status, l.opening_bid, l.sold_amount,
           l.assessed_value, l.taxes_owed, l.parcel_number,
           a.sale_date::text, a.sale_type, a.platform, a.source_url,
           c.state, c.name
    FROM lots l
    JOIN auctions a ON a.id = l.auction_id
    JOIN counties c ON c.fips = l.county_fips
    WHERE l.status IN ('sold', 'redeemed', 'struck')
       OR l.sold_amount IS NOT NULL
    ORDER BY a.sale_date NULLS LAST
    """
    rows: list[HistoricalOutcome] = []
    with psycopg.connect(database_url) as conn:
        with conn.cursor() as cur:
            cur.execute(q)
            cols = [d.name for d in cur.description]
            for tup in cur.fetchall():
                r = dict(zip(cols, tup))
                if only_with_sold_amount and r["sold_amount"] is None:
                    continue
                status = r["status"]
                sale_type = SaleType(r["sale_type"]) if r["sale_type"] in {s.value for s in SaleType} else SaleType.TAX_DEED
                sold_amt = float(r["sold_amount"]) if r["sold_amount"] is not None else None
                opening = float(r["opening_bid"]) if r["opening_bid"] is not None else None
                assessed = float(r["assessed_value"]) if r["assessed_value"] is not None else None

                # Pre-sale redeem (owner cured) vs sold vs struck
                if status == "redeemed":
                    redeemed, owned = True, False
                    # Capital never deployed by a winning bidder
                    notes = "Pre-sale redemption (owner paid before auction)."
                elif status == "sold" or sold_amt is not None:
                    # Post-sale owner redeem not known from listing DB
                    if sale_type == SaleType.TAX_DEED:
                        redeemed, owned = False, True
                        notes = "Sold tax deed (DB). No post-sale redeem in MI/FL deed model."
                    else:
                        redeemed, owned = False, True
                        notes = (
                            "Sold redeemable deed (DB). Post-sale redemption unknown — "
                            "treat as ownership path until investor outcome logged."
                        )
                else:
                    redeemed, owned = False, False
                    notes = f"Lot status={status} without sold amount."

                rows.append(
                    HistoricalOutcome(
                        id=f"db-lot-{r['id']}",
                        state=r["state"],
                        fips=r["county_fips"],
                        county_name=r["name"],
                        sale_type=sale_type,
                        sale_date=r["sale_date"],
                        opening_bid=opening,
                        winning_bid=sold_amt,
                        assessed_value=assessed,
                        redeemed=redeemed,
                        ownership_taken=owned,
                        surviving_liens=0.0 if sale_type == SaleType.TAX_DEED else None,
                        provenance="recorded",
                        source=r["source_url"] or f"postgres:lots:{r['id']}",
                        notes=notes,
                    )
                )
    return rows


def merge_outcomes(
    *batches: list[HistoricalOutcome],
    drop_synthetic: bool = True,
    existing: list[HistoricalOutcome] | None = None,
) -> list[HistoricalOutcome]:
    """Merge by id; optionally drop synthetic_seed rows."""
    by_id: dict[str, HistoricalOutcome] = {}
    if existing is not None:
        for o in existing:
            by_id[o.id] = o
    for batch in batches:
        for o in batch:
            by_id[o.id] = o
    rows = list(by_id.values())
    if drop_synthetic:
        rows = [o for o in rows if o.provenance != "synthetic_seed"]
    rows.sort(key=lambda o: (o.sale_date or "", o.state, o.id))
    return rows


def rebuild_real_history(
    *,
    years: list[int] | None = None,
    max_auctions_per_year: int | None = None,
    include_unsold: bool = False,
    database_url: str | None = None,
    replace: bool = True,
    calibrate: bool = True,
) -> dict[str, Any]:
    """
    End-to-end: fetch real sources → write JSONL → calibrate priors.

    Default: Michigan past auctions for recent years, sold lots only.
    Synthetic seed is removed when replace=True.
    """
    years = years or [2023, 2024, 2025]
    mi = import_michigan_past_years(
        years,
        max_auctions_per_year=max_auctions_per_year,
        include_unsold=include_unsold,
        progress=True,
    )
    db_rows: list[HistoricalOutcome] = []
    if database_url:
        try:
            db_rows = export_from_postgres(database_url)
            print(f"[db] exported {len(db_rows)} outcome-ish lots")
        except Exception as e:  # noqa: BLE001
            print(f"[db] skip: {e}")

    existing = [] if replace else load_outcomes()
    merged = merge_outcomes(mi, db_rows, existing=existing, drop_synthetic=True)
    path = outcomes_path()
    n = write_outcomes(merged, path)
    print(f"[write] {n} real outcomes → {path}")

    priors_meta = None
    if calibrate:
        # Calibrate primarily on sold ownership / redeem rows with capital deployed
        cal_rows = [
            o
            for o in merged
            if o.ownership_taken or o.redeemed or (o.winning_bid is not None)
        ]
        priors = calibrate_priors(cal_rows, cache=True)
        priors_meta = {
            "n_outcomes": priors.n_outcomes,
            "buckets": len(priors.buckets),
            "provenance_counts": priors.provenance_counts,
        }
        print(f"[priors] calibrated n={priors.n_outcomes} buckets={len(priors.buckets)}")

    sold = sum(1 for o in merged if o.ownership_taken)
    return {
        "path": str(path),
        "n_total": n,
        "n_sold_ownership": sold,
        "n_mi_import": len(mi),
        "n_db": len(db_rows),
        "years": years,
        "priors": priors_meta,
    }
