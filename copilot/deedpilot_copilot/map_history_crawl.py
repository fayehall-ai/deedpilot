"""
Crawl past-auction data using links from tax-deed-map county research.

Flow
----
1. Load ``data/county_sources.json`` (export from tax-deed-map COUNTY_DATA).
2. Group auction-platform / tax-collector / source URLs by host.
3. Respect ingest policy (block RealAuction; polite delays; .gov preferred).
4. Specialized extractors where we know the site (e.g. tax-sale.info).
5. Generic discovery: follow "past / results / sold / archive" links and
   scrape sold-price patterns from HTML.
6. Merge into historical_outcomes.jsonl (provenance=recorded) and recalibrate.

This is intentionally honest: most county pages list *upcoming* sales only.
We extract sold prices when published; we never invent them.
"""

from __future__ import annotations

import hashlib
import json
import re
import time
import urllib.error
import urllib.request
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urljoin, urlparse

from .history import calibrate_priors, load_outcomes, outcomes_path, write_outcomes
from .ingest_real_history import import_michigan_past_years, merge_outcomes
from .policy import check_url_policy
from .schemas import HistoricalOutcome, SaleType

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
DEFAULT_SOURCES = DATA_DIR / "county_sources.json"
CRAWL_REPORT = DATA_DIR / "map_crawl_report.json"
CACHE_DIR = DATA_DIR / "crawl_cache"

USER_AGENT = (
    "Mozilla/5.0 (compatible; DeedPilotMapHistory/0.1; research; "
    "+https://github.com/fayedaihall/deedpilot)"
)

PAST_LINK_RE = re.compile(
    r"(past|result|results|sold|closed|archive|history|prior|completed|previous)",
    re.I,
)
SOLD_PATTERNS = [
    re.compile(
        r"(?P<label>[^<\n]{0,80}?)Sold(?:\s+for)?\s*\$?\s*(?P<amt>[\d,]+(?:\.\d{1,2})?)",
        re.I,
    ),
    re.compile(
        r"(?:winning\s+bid|high\s+bid|final\s+bid|sale\s+price|sold\s+amount)"
        r"[:\s]+\$?\s*(?P<amt>[\d,]+(?:\.\d{1,2})?)",
        re.I,
    ),
    re.compile(
        r"\$\s*(?P<amt>[\d,]+(?:\.\d{1,2})?)\s*(?:\([^)]{0,20}\))?\s*sold",
        re.I,
    ),
]
# Parcel-ish tokens near money
PARCEL_RE = re.compile(
    r"(?:parcel|apn|account|tax\s*id|folio|pin)[#:\s]*([A-Z0-9][A-Z0-9\-]{4,})",
    re.I,
)

STATE_SALE_TYPE: dict[str, SaleType] = {
    "MI": SaleType.TAX_DEED,
    "FL": SaleType.TAX_DEED,
    "CA": SaleType.TAX_DEED,
    "TX": SaleType.REDEEMABLE_DEED,
    "GA": SaleType.REDEEMABLE_DEED,
    "AZ": SaleType.TAX_LIEN,
    "NY": SaleType.TAX_LIEN,
    "NJ": SaleType.TAX_LIEN,
    "IL": SaleType.TAX_LIEN,
    "OH": SaleType.TAX_DEED,
    "PA": SaleType.TAX_DEED,
    "NC": SaleType.TAX_DEED,
    "VA": SaleType.TAX_DEED,
    "IN": SaleType.TAX_DEED,
}


def _sale_type_for(state: str | None, declared: str | None = None) -> SaleType:
    if declared:
        d = declared.lower()
        if "lien" in d:
            return SaleType.TAX_LIEN
        if "redeemable" in d:
            return SaleType.REDEEMABLE_DEED
        if "hybrid" in d:
            return SaleType.HYBRID
        if "deed" in d:
            return SaleType.TAX_DEED
        for st in SaleType:
            if st.value.lower() == d:
                return st
    if state and state in STATE_SALE_TYPE:
        return STATE_SALE_TYPE[state]
    return SaleType.TAX_DEED


def load_county_sources(path: Path | None = None) -> dict[str, Any]:
    path = path or DEFAULT_SOURCES
    if not path.exists():
        raise FileNotFoundError(
            f"Missing {path}. Run: node copilot/scripts/export_county_sources.mjs "
            "(from deedpilot with tax-deed-map sibling, or pass --map)."
        )
    return json.loads(path.read_text(encoding="utf-8"))


def _cache_key(url: str) -> Path:
    h = hashlib.sha256(url.encode()).hexdigest()[:24]
    return CACHE_DIR / f"{h}.html"


def fetch_url(
    url: str,
    *,
    use_cache: bool = True,
    min_delay_s: float | None = None,
) -> tuple[str | None, dict[str, Any]]:
    """Fetch URL with policy + optional disk cache. Returns (html|None, meta)."""
    pol = check_url_policy(url)
    meta: dict[str, Any] = {
        "url": url,
        "host": pol.host,
        "decision": pol.decision,
        "reason": pol.reason,
    }
    if pol.decision in ("deny", "requires_agreement"):
        meta["skipped"] = True
        return None, meta

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cpath = _cache_key(url)
    if use_cache and cpath.exists() and cpath.stat().st_size > 0:
        meta["cache"] = True
        return cpath.read_text(encoding="utf-8", errors="replace"), meta

    delay = (min_delay_s if min_delay_s is not None else pol.min_delay_ms / 1000.0)
    # Per-host last-fetch throttle in process
    host = pol.host
    last = _HOST_LAST.get(host, 0.0)
    wait = delay - (time.time() - last)
    if wait > 0:
        time.sleep(wait)

    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=45) as resp:
            raw = resp.read()
            ctype = resp.headers.get("Content-Type", "")
            meta["status"] = getattr(resp, "status", 200)
            meta["content_type"] = ctype
    except urllib.error.HTTPError as e:
        meta["error"] = f"HTTP {e.code}"
        _HOST_LAST[host] = time.time()
        return None, meta
    except Exception as e:  # noqa: BLE001
        meta["error"] = str(e)[:200]
        _HOST_LAST[host] = time.time()
        return None, meta

    _HOST_LAST[host] = time.time()
    # Skip binary / empty
    if not raw or len(raw) < 80:
        meta["error"] = "empty"
        return None, meta
    if "pdf" in (meta.get("content_type") or "").lower() or url.lower().endswith(".pdf"):
        meta["error"] = "pdf_not_parsed"
        # still cache raw? skip
        return None, meta

    try:
        html = raw.decode("utf-8")
    except UnicodeDecodeError:
        html = raw.decode("latin-1", errors="replace")

    if use_cache:
        cpath.write_text(html, encoding="utf-8")
    meta["bytes"] = len(html)
    return html, meta


_HOST_LAST: dict[str, float] = {}


def _strip_html(html: str) -> str:
    t = re.sub(r"(?is)<script[^>]*>.*?</script>", " ", html)
    t = re.sub(r"(?is)<style[^>]*>.*?</style>", " ", t)
    t = re.sub(r"(?is)<br\s*/?>", "\n", t)
    t = re.sub(r"(?is)</(p|div|tr|li|h\d)>", "\n", t)
    t = re.sub(r"(?is)<[^>]+>", " ", t)
    t = re.sub(r"&nbsp;", " ", t)
    t = re.sub(r"&amp;", "&", t)
    t = re.sub(r"[ \t]+", " ", t)
    return t


def extract_past_links(html: str, base_url: str, *, limit: int = 12) -> list[str]:
    hrefs = re.findall(r'href=["\']([^"\'#]+)', html, re.I)
    out: list[str] = []
    seen: set[str] = set()
    for h in hrefs:
        if h.startswith("javascript:") or h.startswith("mailto:"):
            continue
        full = urljoin(base_url, h)
        if full in seen:
            continue
        # same-ish host preferred
        if PAST_LINK_RE.search(h) or PAST_LINK_RE.search(full):
            seen.add(full)
            out.append(full)
        if len(out) >= limit:
            break
    return out


def extract_sold_amounts(html: str) -> list[dict[str, Any]]:
    """Pull sold-price hits from page text."""
    text = _strip_html(html)
    hits: list[dict[str, Any]] = []
    seen_amt_ctx: set[str] = set()
    for rx in SOLD_PATTERNS:
        for m in rx.finditer(text):
            amt_s = m.group("amt")
            try:
                amt = float(amt_s.replace(",", ""))
            except ValueError:
                continue
            if amt < 10 or amt > 50_000_000:
                continue
            start = max(0, m.start() - 100)
            ctx = text[start : m.end() + 40].strip()
            key = f"{amt}:{ctx[:60]}"
            if key in seen_amt_ctx:
                continue
            seen_amt_ctx.add(key)
            parcel = None
            pm = PARCEL_RE.search(ctx)
            if pm:
                parcel = pm.group(1)
            hits.append({"amount": amt, "context": ctx[:200], "parcel": parcel})
    return hits


@dataclass
class CrawlStats:
    hosts_seen: int = 0
    urls_fetched: int = 0
    urls_skipped_policy: int = 0
    urls_failed: int = 0
    pages_with_sold: int = 0
    outcomes: int = 0
    by_host: dict[str, int] = field(default_factory=dict)
    by_state: dict[str, int] = field(default_factory=dict)
    errors: list[str] = field(default_factory=list)
    discovered_past_urls: list[str] = field(default_factory=list)


def outcomes_from_sold_hits(
    hits: list[dict[str, Any]],
    *,
    fips: str | None,
    state: str | None,
    source_url: str,
    sale_type: SaleType,
    county_name: str | None = None,
) -> list[HistoricalOutcome]:
    rows: list[HistoricalOutcome] = []
    for i, hit in enumerate(hits):
        amt = hit["amount"]
        parcel = hit.get("parcel") or f"hit{i}"
        oid = (
            "map-"
            + hashlib.sha256(f"{source_url}|{amt}|{parcel}|{i}".encode()).hexdigest()[:16]
        )
        rows.append(
            HistoricalOutcome(
                id=oid,
                state=state or "XX",
                fips=fips,
                county_name=county_name,
                sale_type=sale_type,
                sale_date=None,
                opening_bid=None,
                winning_bid=amt,
                assessed_value=None,
                redeemed=False,
                ownership_taken=True,  # sold at auction → capital deployed
                surviving_liens=0.0 if sale_type == SaleType.TAX_DEED else None,
                provenance="recorded",
                source=source_url,
                notes=(
                    f"Extracted sold price from county-map source page. "
                    f"Context: {hit.get('context', '')[:160]}"
                ),
            )
        )
    return rows


def _county_seed_urls(county: dict[str, Any]) -> list[tuple[str, str]]:
    """Return (url, role) pairs prioritized for past-result discovery."""
    out: list[tuple[str, str]] = []
    if county.get("auctionPlatformUrl"):
        out.append((county["auctionPlatformUrl"], "auctionPlatform"))
    if county.get("taxCollectorUrl"):
        out.append((county["taxCollectorUrl"], "taxCollector"))
    if county.get("clerkOfCourtUrl"):
        out.append((county["clerkOfCourtUrl"], "clerkOfCourt"))
    for s in county.get("sources") or []:
        if isinstance(s, str) and s.startswith("http"):
            out.append((s, "source"))
    # de-dupe
    seen: set[str] = set()
    uniq: list[tuple[str, str]] = []
    for u, role in out:
        u2 = u.split("#")[0].rstrip("/")
        if u2 in seen:
            continue
        seen.add(u2)
        uniq.append((u2, role))
    return uniq


def crawl_county_sources(
    *,
    sources_path: Path | None = None,
    max_counties: int | None = None,
    max_pages_per_county: int = 6,
    follow_past_links: bool = True,
    use_cache: bool = True,
    include_specialized_mi: bool = True,
    mi_years: list[int] | None = None,
    progress: bool = True,
) -> dict[str, Any]:
    """
    Walk all researched counties from the tax-deed map and extract sold prices
    from linked public pages (policy-aware).
    """
    src = load_county_sources(sources_path)
    counties: list[dict[str, Any]] = src["counties"]
    if max_counties is not None:
        counties = counties[:max_counties]

    stats = CrawlStats()
    all_rows: list[HistoricalOutcome] = []
    page_log: list[dict[str, Any]] = []

    # --- Specialized: full MI Title Check past auctions (high quality) ---
    if include_specialized_mi:
        years = mi_years or [2023, 2024, 2025]
        if progress:
            print(f"[specialized] Michigan tax-sale.info years={years}")
        try:
            mi_rows = import_michigan_past_years(
                years, include_unsold=False, progress=progress
            )
            all_rows.extend(mi_rows)
            stats.outcomes += len(mi_rows)
            stats.by_state["MI"] = stats.by_state.get("MI", 0) + len(mi_rows)
            stats.by_host["tax-sale.info"] = stats.by_host.get("tax-sale.info", 0) + len(
                mi_rows
            )
        except Exception as e:  # noqa: BLE001
            stats.errors.append(f"mi_specialized: {e}")

    # --- Generic crawl: unique URLs from the map (not per-county re-fetch) ---
    # url -> list of (fips, state, saleType) that cite it
    url_owners: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for county in counties:
        fips = county.get("fips")
        state = county.get("state")
        sale_type = _sale_type_for(state, county.get("saleType"))
        for u, role in _county_seed_urls(county):
            # Prefer auction platform URLs; still include collector/clerk/sources
            url_owners[u].append(
                {
                    "fips": fips,
                    "state": state,
                    "sale_type": sale_type,
                    "role": role,
                    "county_name": None,
                }
            )

    # Prioritize auctionPlatform seeds first in crawl order
    def _url_priority(u: str) -> tuple[int, str]:
        roles = {o["role"] for o in url_owners[u]}
        if "auctionPlatform" in roles:
            return (0, u)
        if "taxCollector" in roles:
            return (1, u)
        if "clerkOfCourt" in roles:
            return (2, u)
        return (3, u)

    seed_urls = sorted(url_owners.keys(), key=_url_priority)
    fetched_ok: set[str] = set()
    hosts_touched: set[str] = set()
    queue: list[str] = list(seed_urls)
    # Cap follow-up past links globally to keep runtime bounded
    max_followups = max(200, len(seed_urls) // 2)
    followups_added = 0

    if progress:
        print(f"[map] unique seed URLs: {len(seed_urls)} across {len(counties)} counties")

    while queue:
        url = queue.pop(0)
        if url in fetched_ok:
            continue
        owners = url_owners.get(url) or [
            {"fips": None, "state": None, "sale_type": SaleType.TAX_DEED, "role": "discovered"}
        ]
        primary = owners[0]
        fips = primary.get("fips")
        state = primary.get("state")
        sale_type = primary.get("sale_type") or SaleType.TAX_DEED

        pol = check_url_policy(url)
        hosts_touched.add(pol.host)
        if pol.decision in ("deny", "requires_agreement"):
            stats.urls_skipped_policy += 1
            page_log.append(
                {"fips": fips, "url": url, "skipped": pol.decision, "reason": pol.reason}
            )
            fetched_ok.add(url)
            continue

        html, meta = fetch_url(url, use_cache=use_cache)
        stats.urls_fetched += 1
        fetched_ok.add(url)

        if progress and stats.urls_fetched % 25 == 0:
            print(
                f"[map] fetched {stats.urls_fetched} urls, "
                f"sold_pages={stats.pages_with_sold}, outcomes={len(all_rows)}, queue={len(queue)}"
            )

        if html is None:
            stats.urls_failed += 1
            page_log.append({"fips": fips, **meta})
            continue

        hits = extract_sold_amounts(html)
        if hits:
            stats.pages_with_sold += 1
            rows = outcomes_from_sold_hits(
                hits,
                fips=fips,
                state=state,
                source_url=url,
                sale_type=sale_type if isinstance(sale_type, SaleType) else SaleType.TAX_DEED,
            )
            rows = rows[:40]
            all_rows.extend(rows)
            stats.outcomes += len(rows)
            if state:
                stats.by_state[str(state)] = stats.by_state.get(str(state), 0) + len(rows)
            stats.by_host[pol.host] = stats.by_host.get(pol.host, 0) + len(rows)
            page_log.append(
                {"fips": fips, "url": url, "sold_hits": len(hits), "kept": len(rows)}
            )

        if follow_past_links and followups_added < max_followups:
            for past in extract_past_links(html, url, limit=6):
                if past in fetched_ok or past in queue:
                    continue
                ph = urlparse(past).hostname
                uh = urlparse(url).hostname
                if not ph or not uh:
                    continue
                if ph.removeprefix("www.") != uh.removeprefix("www."):
                    continue
                queue.append(past)
                # inherit owners of parent URL
                url_owners[past] = list(owners)
                stats.discovered_past_urls.append(past)
                followups_added += 1
                if followups_added >= max_followups:
                    break

    stats.hosts_seen = len(hosts_touched)

    # Merge with existing real rows (drop synthetic)
    existing = [o for o in load_outcomes() if o.provenance != "synthetic_seed"]
    merged = merge_outcomes(all_rows, existing=existing, drop_synthetic=True)
    n = write_outcomes(merged)
    # Calibrate on rows with winning bids / ownership
    cal = [
        o
        for o in merged
        if o.winning_bid is not None or o.ownership_taken or o.redeemed
    ]
    priors = calibrate_priors(cal, cache=True)

    report = {
        "finished_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "n_counties_in_index": len(src["counties"]),
        "n_counties_crawled": len(counties),
        "stats": {
            "hosts_seen": stats.hosts_seen,
            "urls_fetched": stats.urls_fetched,
            "urls_skipped_policy": stats.urls_skipped_policy,
            "urls_failed": stats.urls_failed,
            "pages_with_sold": stats.pages_with_sold,
            "outcomes_extracted_this_run": stats.outcomes,
            "by_state": dict(sorted(stats.by_state.items(), key=lambda x: -x[1])),
            "by_host": dict(sorted(stats.by_host.items(), key=lambda x: -x[1])[:40]),
            "errors": stats.errors[:20],
            "n_discovered_past_urls": len(stats.discovered_past_urls),
        },
        "merged_n": n,
        "priors": {
            "n_outcomes": priors.n_outcomes,
            "buckets": len(priors.buckets),
            "provenance_counts": priors.provenance_counts,
        },
        "sample_pages": page_log[:100],
    }
    CRAWL_REPORT.write_text(json.dumps(report, indent=2), encoding="utf-8")
    if progress:
        print(json.dumps(report["stats"], indent=2))
        print(f"[write] {n} outcomes → {outcomes_path()}")
        print(f"[report] {CRAWL_REPORT}")
    return report
