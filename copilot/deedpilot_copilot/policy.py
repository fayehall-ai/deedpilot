"""Ingestion / web-tool access policy (Python port of lib/ingest/policy.ts)."""

from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import urlparse


@dataclass(frozen=True)
class SourcePolicy:
    host: str
    decision: str  # allow | deny | requires_agreement
    min_delay_ms: int
    reason: str


SOURCE_POLICIES: list[SourcePolicy] = [
    SourcePolicy(
        "realtaxdeed.com",
        "requires_agreement",
        5000,
        "RealAuction robots Disallow:/ — prefer county clerk of record.",
    ),
    SourcePolicy(
        "realforeclose.com",
        "requires_agreement",
        5000,
        "Same RealAuction platform policy as realtaxdeed.com.",
    ),
    SourcePolicy(
        "tax-sale.info",
        "allow",
        2000,
        "Michigan Title Check host; robots permits crawling.",
    ),
    SourcePolicy(
        "taxsales.lgbs.com",
        "allow",
        2000,
        "LGBS Texas public notice lists; robots permits crawling.",
    ),
    SourcePolicy(
        "govease.com",
        "allow",
        3000,
        "Public auction listings permitted.",
    ),
    SourcePolicy(
        "bid4assets.com",
        "allow",
        3000,
        "Public listings; rate-limit conservatively.",
    ),
]


def check_url_policy(url: str) -> SourcePolicy:
    host = urlparse(url).hostname or ""
    host = host.lower().removeprefix("www.")
    for p in SOURCE_POLICIES:
        if host == p.host or host.endswith("." + p.host):
            return p
    return SourcePolicy(
        host=host or "unknown",
        decision="allow",
        min_delay_ms=3000,
        reason="No explicit policy — default polite allow; still respect robots.txt.",
    )
