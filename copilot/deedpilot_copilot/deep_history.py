"""
Deep multi-state historical tax-sale importers.

Goes beyond generic HTML scraping: uses government open-data APIs,
expanded auction-host archives, and published final-sale PDFs.

Sources (policy-friendly / public records)
-----------------------------------------
- Michigan Title Check past auctions (tax-sale.info) — years 2018–2026
- Cook County IL Treasurer Annual + Scavenger Tax Sale (Socrata)
- Howard County MD Tax Sales open data (Socrata)
- San Diego County CA Final Report of Sale PDFs
- Orange County CA published auction results PDF (when parseable)
- Existing map-crawl / generic sold-price rows (merged, not replaced)

Never invents sold prices. Every row is provenance=recorded with a source URL.
"""

from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Iterable

from .history import calibrate_priors, load_outcomes, write_outcomes
from .ingest_real_history import import_michigan_past_years, merge_outcomes
from .schemas import HistoricalOutcome, SaleType

USER_AGENT = (
    "Mozilla/5.0 (compatible; DeedPilotDeepHistory/0.1; research; "
    "+https://github.com/fayedaihall/deedpilot)"
)
DATA_DIR = Path(__file__).resolve().parent.parent / "data"
DEEP_REPORT = DATA_DIR / "deep_import_report.json"


def _get_json(url: str, *, pause: float = 0.35) -> Any:
    time.sleep(pause)
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _get_bytes(url: str, *, pause: float = 0.5) -> bytes:
    time.sleep(pause)
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=120) as resp:
        return resp.read()


def socrata_paginate(
    domain: str,
    dataset_id: str,
    *,
    where: str | None = None,
    select: str | None = None,
    page_size: int = 50000,
    max_rows: int | None = None,
    progress: bool = True,
) -> list[dict[str, Any]]:
    """Pull all rows from a Socrata (open data) dataset."""
    rows: list[dict[str, Any]] = []
    offset = 0
    while True:
        if max_rows is not None and len(rows) >= max_rows:
            break
        params: dict[str, str] = {
            "$limit": str(page_size),
            "$offset": str(offset),
            "$order": ":id",
        }
        if where:
            params["$where"] = where
        if select:
            params["$select"] = select
        url = f"https://{domain}/resource/{dataset_id}.json?" + urllib.parse.urlencode(params)
        try:
            batch = _get_json(url)
        except urllib.error.HTTPError as e:
            # some datasets reject $order=:id
            if "$order" in params:
                params.pop("$order", None)
                url = f"https://{domain}/resource/{dataset_id}.json?" + urllib.parse.urlencode(params)
                batch = _get_json(url)
            else:
                raise RuntimeError(f"Socrata {domain}/{dataset_id}: HTTP {e.code}") from e
        if not batch:
            break
        rows.extend(batch)
        if progress:
            print(f"  [socrata {domain}/{dataset_id}] +{len(batch)} total={len(rows)}")
        if len(batch) < page_size:
            break
        offset += page_size
        if max_rows is not None and len(rows) >= max_rows:
            rows = rows[:max_rows]
            break
    return rows


# ---------------------------------------------------------------------------
# Cook County IL — Annual Tax Sale (liens) + Scavenger
# ---------------------------------------------------------------------------

def import_cook_county(*, max_rows: int | None = None, progress: bool = True) -> list[HistoricalOutcome]:
    """
    Cook County Treasurer Annual Tax Sale (Socrata 55ju-2fs9) + Scavenger (ydgz-vkrp).
    ~64k sold annual liens historically; lien certificates not deeds.
    """
    out: list[HistoricalOutcome] = []
    if progress:
        print("[deep] Cook County annual tax sale (sold only)…")
    annual = socrata_paginate(
        "datacatalog.cookcountyil.gov",
        "55ju-2fs9",
        where="sold_at_sale=true",
        max_rows=max_rows,
        progress=progress,
    )
    for r in annual:
        year = str(r.get("tax_sale_year") or "")
        pin = str(r.get("pin") or "unknown")
        paid = r.get("total_amount_paid") or r.get("total_tax_and_penalty_amount_offered")
        try:
            bid = float(paid) if paid is not None else None
        except (TypeError, ValueError):
            bid = None
        try:
            taxes = float(r.get("tax_amount_offered")) if r.get("tax_amount_offered") else None
        except (TypeError, ValueError):
            taxes = None
        oid = f"il-cook-annual-{year}-{pin}".replace(" ", "")
        out.append(
            HistoricalOutcome(
                id=oid,
                state="IL",
                fips="17031",
                county_name="Cook County",
                sale_type=SaleType.TAX_LIEN,
                sale_date=f"{year}-06-15" if year.isdigit() else None,  # June sale typical
                opening_bid=taxes,
                winning_bid=bid,
                assessed_value=None,
                redeemed=False,
                ownership_taken=False,  # lien certificate, not deed
                surviving_liens=None,
                provenance="recorded",
                source="https://datacatalog.cookcountyil.gov/resource/55ju-2fs9.json",
                notes=(
                    f"Cook County Annual Tax Sale sold PIN. Buyer={r.get('buyer_name')}. "
                    f"winning_bid_percent={r.get('winning_bid_percent')}. Lien not deed."
                ),
            )
        )

    if progress:
        print("[deep] Cook County scavenger tax sale…")
    scav = socrata_paginate(
        "datacatalog.cookcountyil.gov",
        "ydgz-vkrp",
        where="sold_at_sale=true",
        max_rows=max_rows,
        progress=progress,
    )
    for r in scav:
        year = str(r.get("tax_sale_year") or "")
        pin = str(r.get("pin") or "unknown")
        try:
            bid = float(r["total_amount_paid"]) if r.get("total_amount_paid") not in (None, "") else None
        except (TypeError, ValueError):
            bid = None
        oid = f"il-cook-scavenger-{year}-{pin}".replace(" ", "")
        out.append(
            HistoricalOutcome(
                id=oid,
                state="IL",
                fips="17031",
                county_name="Cook County",
                sale_type=SaleType.TAX_LIEN,
                sale_date=f"{year}-01-15" if year.isdigit() else None,
                winning_bid=bid if bid and bid > 0 else None,
                redeemed=False,
                ownership_taken=False,
                provenance="recorded",
                source="https://datacatalog.cookcountyil.gov/resource/ydgz-vkrp.json",
                notes=f"Cook scavenger sale. Buyer={r.get('buyer_name')}. Township={r.get('township')}.",
            )
        )
    if progress:
        print(f"[deep] Cook total rows={len(out)}")
    return out


# ---------------------------------------------------------------------------
# Howard County MD open data
# ---------------------------------------------------------------------------

def import_howard_md(*, progress: bool = True) -> list[HistoricalOutcome]:
    if progress:
        print("[deep] Howard County MD tax sales…")
    rows = socrata_paginate(
        "opendata.howardcountymd.gov",
        "etp2-fnbu",
        progress=progress,
    )
    out: list[HistoricalOutcome] = []
    for r in rows:
        parcel = str(r.get("parcel") or "unknown")
        year = str(r.get("year") or "")
        try:
            bid = float(r["bid_amount"]) if r.get("bid_amount") else None
        except (TypeError, ValueError):
            bid = None
        try:
            assessed = float(r["assessed_value"]) if r.get("assessed_value") else None
        except (TypeError, ValueError):
            assessed = None
        try:
            taxes = float(r["taxes_due"]) if r.get("taxes_due") else None
        except (TypeError, ValueError):
            taxes = None
        if bid is None:
            continue
        out.append(
            HistoricalOutcome(
                id=f"md-howard-{year}-{parcel}",
                state="MD",
                fips="24027",
                county_name="Howard County",
                sale_type=SaleType.TAX_LIEN,  # MD typically tax sale / certificate style
                sale_date=f"{year}-05-15" if year.isdigit() else None,
                opening_bid=taxes,
                winning_bid=bid,
                assessed_value=assessed,
                redeemed=False,
                ownership_taken=False,
                bid_to_arv=(bid / assessed) if bid and assessed and assessed > 0 else None,
                provenance="recorded",
                source="https://opendata.howardcountymd.gov/resource/etp2-fnbu.json",
                notes="Howard County MD open-data tax sale row (bid_amount).",
            )
        )
    if progress:
        print(f"[deep] Howard MD rows={len(out)}")
    return out


# ---------------------------------------------------------------------------
# San Diego CA Final Report of Sale PDFs
# ---------------------------------------------------------------------------

_SD_INDEX = (
    "https://www.sdttc.com/content/ttc/en/tax-collection/property-tax-sales/prior-sales-results.html"
)


def _sd_pdf_links(html: str) -> list[str]:
    links = re.findall(r'href=["\']([^"\']*Final[^"\']*\.pdf[^"\']*)', html, re.I)
    out = []
    for l in links:
        if l.startswith("http"):
            out.append(l)
        else:
            out.append(urllib.parse.urljoin("https://www.sdttc.com", l))
    # de-dupe preserve order
    seen: set[str] = set()
    uniq = []
    for u in out:
        if u not in seen:
            seen.add(u)
            uniq.append(u)
    return uniq


def _parse_sd_pdf_text(
    text: str,
    *,
    source_url: str,
    sale_date: str | None,
    pdf_tag: str,
) -> list[HistoricalOutcome]:
    """
    Extract SOLD / REDEEMED / WITHDRAWN parcels from SD Final Report text.

    Layout is multi-column and noisy; we look for APN-like tokens and nearby
    SALE STATUS keywords and dollar amounts.
    """
    rows: list[HistoricalOutcome] = []
    # Normalize whitespace
    t = re.sub(r"[ \t]+", " ", text)
    # Split on item numbers like 0002 / 0062 at line starts
    chunks = re.split(r"\n(?=\d{3,4}\n)", t)
    for idx, ch in enumerate(chunks):
        status_m = re.search(
            r"(SOLD[^\n]{0,40}|REDEEMED|WITHDRAWN|REMOVED|CANCELLED)",
            ch,
            re.I,
        )
        if not status_m:
            continue
        status = status_m.group(1).upper()
        apn_m = re.search(r"(\d{5}/\d{3}-\d{3}-\d{2}-\d{2})", ch)
        apn = apn_m.group(1) if apn_m else None
        # dollars: first is often minimum bid; sale price often near SOLD
        dollars = [float(x.replace(",", "")) for x in re.findall(r"\$([\d,]+(?:\.\d{2})?)", ch)]
        min_bid = dollars[0] if dollars else None
        sale_price = None
        if "SOLD" in status:
            # Prefer amount immediately before SOLD marker
            pre = ch[: status_m.start()]
            pre_dollars = [float(x.replace(",", "")) for x in re.findall(r"\$([\d,]+(?:\.\d{2})?)", pre)]
            if pre_dollars:
                sale_price = pre_dollars[-1]
            elif len(dollars) >= 2:
                sale_price = dollars[1]
            elif dollars:
                sale_price = dollars[0]

        item_m = re.match(r"(\d{3,4})", ch.strip())
        item = item_m.group(1) if item_m else "x"
        apn_key = (apn or item).replace("/", "-")
        # pdf_tag + chunk index guarantee uniqueness across/within PDFs
        oid = f"ca-sandiego-{pdf_tag}-{idx}-{item}-{apn_key}"

        if "SOLD" in status and sale_price:
            rows.append(
                HistoricalOutcome(
                    id=oid,
                    state="CA",
                    fips="06073",
                    county_name="San Diego County",
                    sale_type=SaleType.TAX_DEED,
                    sale_date=sale_date,
                    opening_bid=min_bid,
                    winning_bid=sale_price,
                    redeemed=False,
                    ownership_taken=True,
                    surviving_liens=0.0,
                    provenance="recorded",
                    source=source_url,
                    notes=f"San Diego Final Report of Sale. Status={status[:40]}. APN={apn}.",
                )
            )
        elif "REDEEMED" in status:
            rows.append(
                HistoricalOutcome(
                    id=oid + "-redeemed",
                    state="CA",
                    fips="06073",
                    county_name="San Diego County",
                    sale_type=SaleType.TAX_DEED,
                    sale_date=sale_date,
                    opening_bid=min_bid,
                    winning_bid=None,
                    redeemed=True,  # pre-sale / list redeem
                    ownership_taken=False,
                    provenance="recorded",
                    source=source_url,
                    notes=f"San Diego list status REDEEMED (owner cured). APN={apn}.",
                )
            )
    return rows


def import_san_diego_pdfs(
    *,
    max_pdfs: int | None = 12,
    progress: bool = True,
) -> list[HistoricalOutcome]:
    if progress:
        print("[deep] San Diego Final Report of Sale PDFs…")
    try:
        from pypdf import PdfReader
    except ImportError as e:
        raise RuntimeError("pypdf required: pip install pypdf") from e

    html = _get_bytes(_SD_INDEX, pause=0.5).decode("utf-8", "replace")
    links = _sd_pdf_links(html)
    if max_pdfs is not None:
        links = links[:max_pdfs]
    if progress:
        print(f"  found {len(links)} PDF links (using {len(links)})")

    out: list[HistoricalOutcome] = []
    cache = DATA_DIR / "pdf_cache"
    cache.mkdir(parents=True, exist_ok=True)

    for url in links:
        name = urllib.parse.quote(url.split("/")[-1], safe="")
        path = cache / name
        try:
            if not path.exists():
                path.write_bytes(_get_bytes(url, pause=0.8))
            reader = PdfReader(str(path))
            text = "\n".join((p.extract_text() or "") for p in reader.pages)
        except Exception as e:  # noqa: BLE001
            if progress:
                print(f"  skip {url}: {e}")
            continue
        # Sale date from header e.g. March 14 - March 19, 2025
        dm = re.search(
            r"(January|February|March|April|May|June|July|August|September|"
            r"October|November|December)\s+\d{1,2}\s*[-–]\s*"
            r"(?:January|February|March|April|May|June|July|August|September|"
            r"October|November|December)?\s*\d{0,2},?\s*(\d{4})",
            text,
        )
        sale_date = None
        if dm:
            months = {
                "january": 1, "february": 2, "march": 3, "april": 4, "may": 5, "june": 6,
                "july": 7, "august": 8, "september": 9, "october": 10, "november": 11, "december": 12,
            }
            mo = months[dm.group(1).lower()]
            sale_date = f"{dm.group(2)}-{mo:02d}-15"
        pdf_tag = re.sub(r"[^A-Za-z0-9]+", "", path.stem)[:40] or "pdf"
        rows = _parse_sd_pdf_text(
            text, source_url=url, sale_date=sale_date, pdf_tag=pdf_tag
        )
        if progress:
            print(f"  {path.name}: {len(rows)} rows")
        out.extend(rows)
    if progress:
        print(f"[deep] San Diego total={len(out)}")
    return out


# ---------------------------------------------------------------------------
# Orange County CA results PDF (single known recent results)
# ---------------------------------------------------------------------------

_OC_RESULTS_PDFS = [
    "https://www.octreasurer.gov/sites/ttc/files/2025-07/Tax%20Auction%20June%202025%20Results.pdf",
]


def import_orange_ca_pdfs(*, progress: bool = True) -> list[HistoricalOutcome]:
    if progress:
        print("[deep] Orange County CA results PDFs…")
    try:
        from pypdf import PdfReader
    except ImportError as e:
        raise RuntimeError("pypdf required") from e

    out: list[HistoricalOutcome] = []
    cache = DATA_DIR / "pdf_cache"
    cache.mkdir(parents=True, exist_ok=True)
    for url in _OC_RESULTS_PDFS:
        name = "oc-" + urllib.parse.quote(url.split("/")[-1], safe="")
        path = cache / name
        try:
            if not path.exists():
                path.write_bytes(_get_bytes(url, pause=0.5))
            text = "\n".join((p.extract_text() or "") for p in PdfReader(str(path)).pages)
        except Exception as e:  # noqa: BLE001
            if progress:
                print(f"  skip OC pdf: {e}")
            continue
        # Look for APN + sold amount patterns
        # Common: parcel numbers and $ amounts with SOLD
        for m in re.finditer(
            r"(\d{3}-\d{3}-\d{2}(?:-\d{2})?|\d{8,})"  # parcel-ish
            r"[\s\S]{0,120}?"
            r"(?:Sold|SOLD|Winning)[^\d$]{0,20}\$?\s*([\d,]+(?:\.\d{2})?)",
            text,
            re.I,
        ):
            parcel, amt_s = m.group(1), m.group(2)
            amt = float(amt_s.replace(",", ""))
            if amt < 50:
                continue
            out.append(
                HistoricalOutcome(
                    id=f"ca-orange-2025-06-{parcel}",
                    state="CA",
                    fips="06059",
                    county_name="Orange County",
                    sale_type=SaleType.TAX_DEED,
                    sale_date="2025-06-25",
                    winning_bid=amt,
                    redeemed=False,
                    ownership_taken=True,
                    surviving_liens=0.0,
                    provenance="recorded",
                    source=url,
                    notes=f"Orange County June 2025 tax auction results PDF. Parcel={parcel}.",
                )
            )
        # Fallback: any "Sold for $X" style
        if not out:
            for m in re.finditer(r"Sold(?:\s+for)?\s*\$?\s*([\d,]+(?:\.\d{2})?)", text, re.I):
                amt = float(m.group(1).replace(",", ""))
                if amt < 50:
                    continue
                out.append(
                    HistoricalOutcome(
                        id=f"ca-orange-2025-06-amt-{int(amt)}-{m.start()}",
                        state="CA",
                        fips="06059",
                        county_name="Orange County",
                        sale_type=SaleType.TAX_DEED,
                        sale_date="2025-06-25",
                        winning_bid=amt,
                        redeemed=False,
                        ownership_taken=True,
                        provenance="recorded",
                        source=url,
                        notes="Orange County results PDF sold-price hit.",
                    )
                )
        if progress:
            print(f"  OC rows so far {len(out)}")
    return out


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------

def deep_import_all(
    *,
    mi_years: list[int] | None = None,
    include_cook: bool = True,
    include_howard: bool = True,
    include_san_diego: bool = True,
    include_orange: bool = True,
    include_existing: bool = True,
    cook_max_rows: int | None = None,
    sd_max_pdfs: int | None = 15,
    progress: bool = True,
) -> dict[str, Any]:
    """
    Run all deep importers, merge with existing recorded rows, write JSONL,
    recalibrate priors.
    """
    batches: list[list[HistoricalOutcome]] = []
    counts: dict[str, int] = {}

    years = mi_years or list(range(2018, 2027))
    if progress:
        print(f"[deep] Michigan Title Check years={years}")
    try:
        mi = import_michigan_past_years(years, include_unsold=False, progress=progress)
        batches.append(mi)
        counts["mi_taxsaleinfo"] = len(mi)
    except Exception as e:  # noqa: BLE001
        counts["mi_taxsaleinfo_error"] = str(e)  # type: ignore[assignment]
        if progress:
            print(f"[deep] MI failed: {e}")

    if include_cook:
        try:
            cook = import_cook_county(max_rows=cook_max_rows, progress=progress)
            batches.append(cook)
            counts["cook_il"] = len(cook)
        except Exception as e:  # noqa: BLE001
            counts["cook_il_error"] = str(e)  # type: ignore[assignment]
            if progress:
                print(f"[deep] Cook failed: {e}")

    if include_howard:
        try:
            howard = import_howard_md(progress=progress)
            batches.append(howard)
            counts["howard_md"] = len(howard)
        except Exception as e:  # noqa: BLE001
            counts["howard_md_error"] = str(e)  # type: ignore[assignment]
            if progress:
                print(f"[deep] Howard failed: {e}")

    if include_san_diego:
        try:
            sd = import_san_diego_pdfs(max_pdfs=sd_max_pdfs, progress=progress)
            batches.append(sd)
            counts["san_diego_ca"] = len(sd)
        except Exception as e:  # noqa: BLE001
            counts["san_diego_ca_error"] = str(e)  # type: ignore[assignment]
            if progress:
                print(f"[deep] San Diego failed: {e}")

    if include_orange:
        try:
            oc = import_orange_ca_pdfs(progress=progress)
            batches.append(oc)
            counts["orange_ca"] = len(oc)
        except Exception as e:  # noqa: BLE001
            counts["orange_ca_error"] = str(e)  # type: ignore[assignment]
            if progress:
                print(f"[deep] Orange CA failed: {e}")

    existing = load_outcomes() if include_existing else []
    existing = [o for o in existing if o.provenance != "synthetic_seed"]
    merged = merge_outcomes(*batches, existing=existing, drop_synthetic=True)
    n = write_outcomes(merged)
    cal = [o for o in merged if o.winning_bid is not None or o.ownership_taken or o.redeemed]
    priors = calibrate_priors(cal, cache=True)

    from collections import Counter

    by_state = Counter(o.state for o in merged)
    report = {
        "counts": counts,
        "merged_n": n,
        "by_state": dict(by_state.most_common()),
        "priors": {
            "n_outcomes": priors.n_outcomes,
            "n_buckets": len(priors.buckets),
            "provenance_counts": priors.provenance_counts,
            "bucket_keys": sorted(priors.buckets.keys()),
        },
    }
    DEEP_REPORT.write_text(json.dumps(report, indent=2), encoding="utf-8")
    if progress:
        print(json.dumps(report, indent=2))
    return report
