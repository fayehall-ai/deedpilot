"""
Historical auction outcomes → simulator noise model.

Load JSONL outcomes, fit empirical redemption / exit / QT / lien distributions,
shrink toward expert priors when sample size is small, and cache the result.
"""

from __future__ import annotations

import json
import math
import os
import statistics
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Iterable

from .schemas import (
    HistoricalOutcome,
    NoiseBucket,
    SaleType,
    SimulatorPriors,
    utc_now,
)
from .statute import statute_for

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
DEFAULT_OUTCOMES_PATH = DATA_DIR / "historical_outcomes.jsonl"
DEFAULT_PRIORS_PATH = DATA_DIR / "simulator_priors.json"

# Expert pseudo-counts: with n << this, expert prior dominates.
DEFAULT_PRIOR_STRENGTH = 20.0

# Expert base redemption rates by sale type (aligned with simulator.base_p_redeem)
EXPERT_P_REDEEM_SALE: dict[str, float] = {
    SaleType.TAX_LIEN.value: 0.72,
    SaleType.REDEEMABLE_DEED.value: 0.38,
    SaleType.TAX_DEED.value: 0.12,
    SaleType.HYBRID.value: 0.25,
}

# State multipliers applied on top of sale-type expert prior
EXPERT_STATE_MULT: dict[str, float] = {
    "TX": 1.10,
    "GA": 1.10,
    "MI": 0.70,
}

# Fallback ownership noise when history is empty for a bucket
DEFAULT_EXIT = (0.72, 0.85, 0.95)


def outcomes_path() -> Path:
    env = os.environ.get("DEEDPILOT_HISTORICAL_OUTCOMES")
    return Path(env) if env else DEFAULT_OUTCOMES_PATH


def priors_path() -> Path:
    env = os.environ.get("DEEDPILOT_SIMULATOR_PRIORS")
    return Path(env) if env else DEFAULT_PRIORS_PATH


def expert_p_redeem(state: str | None, sale_type: str | SaleType | None) -> float:
    st = sale_type.value if isinstance(sale_type, SaleType) else (sale_type or "")
    p = EXPERT_P_REDEEM_SALE.get(st, 0.25)
    if state and state in EXPERT_STATE_MULT:
        p = p * EXPERT_STATE_MULT[state]
    return max(0.02, min(0.95, p))


def load_outcomes(path: Path | None = None) -> list[HistoricalOutcome]:
    path = path or outcomes_path()
    if not path.exists():
        return []
    out: list[HistoricalOutcome] = []
    for line_no, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = line.strip()
        if not line:
            continue
        try:
            out.append(HistoricalOutcome.model_validate_json(line))
        except Exception as e:  # noqa: BLE001
            raise ValueError(f"Invalid historical outcome at {path}:{line_no}: {e}") from e
    return out


def append_outcome(outcome: HistoricalOutcome, path: Path | None = None) -> None:
    path = path or outcomes_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(outcome.model_dump_json() + "\n")


def write_outcomes(outcomes: Iterable[HistoricalOutcome], path: Path | None = None) -> int:
    path = path or outcomes_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    rows = list(outcomes)
    with path.open("w", encoding="utf-8") as f:
        for o in rows:
            f.write(o.model_dump_json() + "\n")
    return len(rows)


def _percentile(sorted_vals: list[float], q: float) -> float:
    if not sorted_vals:
        return 0.0
    if len(sorted_vals) == 1:
        return sorted_vals[0]
    idx = (len(sorted_vals) - 1) * q
    lo = int(math.floor(idx))
    hi = int(math.ceil(idx))
    if lo == hi:
        return sorted_vals[lo]
    w = idx - lo
    return sorted_vals[lo] * (1 - w) + sorted_vals[hi] * w


def _shrink(p_hat: float, n: int, p_expert: float, strength: float) -> float:
    return (n * p_hat + strength * p_expert) / (n + strength)


def _bucket_key(state: str | None, sale_type: str | None) -> str:
    return f"{state or '*'}|{sale_type or '*'}"


def _fit_group(
    rows: list[HistoricalOutcome],
    *,
    state: str | None,
    sale_type: str | None,
    prior_strength: float,
) -> NoiseBucket:
    n = len(rows)
    n_red = sum(1 for r in rows if r.redeemed)
    p_raw = (n_red / n) if n else None
    p_exp = expert_p_redeem(state, sale_type)
    p = _shrink(p_raw if p_raw is not None else p_exp, n, p_exp, prior_strength)

    # Exit multiples: exit_price / arv on ownership paths
    exit_mults: list[float] = []
    holdings: list[float] = []
    qt_costs: list[float] = []
    liens: list[float] = []
    rehabs: list[float] = []
    n_own = 0
    for r in rows:
        if not r.ownership_taken:
            continue
        n_own += 1
        arv = r.arv_estimate or r.assessed_value
        if r.exit_price is not None and arv and arv > 0:
            exit_mults.append(max(0.05, min(1.5, r.exit_price / arv)))
        if r.holding_months is not None:
            holdings.append(r.holding_months)
        if r.quiet_title_cost is not None:
            qt_costs.append(r.quiet_title_cost)
        if r.surviving_liens is not None:
            liens.append(r.surviving_liens)
        if r.rehab_cost is not None:
            rehabs.append(r.rehab_cost)

    if exit_mults:
        sm = sorted(exit_mults)
        e10, e50, e90 = _percentile(sm, 0.1), _percentile(sm, 0.5), _percentile(sm, 0.9)
    else:
        e10, e50, e90 = DEFAULT_EXIT

    lien_pos = [x for x in liens if x > 0]
    lien_rate = (len(lien_pos) / len(liens)) if liens else 0.2
    mean_lien = statistics.mean(lien_pos) if lien_pos else 4000.0

    return NoiseBucket(
        key=_bucket_key(state, sale_type),
        state=state,
        sale_type=sale_type,
        n=n,
        n_redeemed=n_red,
        p_redeem_raw=round(p_raw, 4) if p_raw is not None else None,
        p_redeem=round(max(0.02, min(0.95, p)), 4),
        expert_p_redeem=round(p_exp, 4),
        exit_mult_p10=round(e10, 4),
        exit_mult_p50=round(e50, 4),
        exit_mult_p90=round(e90, 4),
        holding_months_mean=round(statistics.mean(holdings), 3) if holdings else None,
        holding_months_std=(
            round(statistics.pstdev(holdings), 3) if len(holdings) >= 2 else None
        ),
        qt_cost_mean=round(statistics.mean(qt_costs), 2) if qt_costs else None,
        qt_cost_std=(
            round(statistics.pstdev(qt_costs), 2) if len(qt_costs) >= 2 else None
        ),
        lien_rate=round(lien_rate, 4),
        mean_lien_if_any=round(mean_lien, 2),
        mean_rehab=round(statistics.mean(rehabs), 2) if rehabs else None,
    )


def calibrate_priors(
    outcomes: list[HistoricalOutcome] | None = None,
    *,
    path: Path | None = None,
    prior_strength: float = DEFAULT_PRIOR_STRENGTH,
    cache: bool = True,
) -> SimulatorPriors:
    """Fit SimulatorPriors from historical outcomes and optionally cache JSON."""
    outcomes = outcomes if outcomes is not None else load_outcomes(path)
    by_state_sale: dict[tuple[str, str], list[HistoricalOutcome]] = defaultdict(list)
    by_sale: dict[str, list[HistoricalOutcome]] = defaultdict(list)
    provenance = Counter()

    for o in outcomes:
        st = o.sale_type.value
        by_state_sale[(o.state, st)].append(o)
        by_sale[st].append(o)
        provenance[o.provenance] += 1

    buckets = {
        _bucket_key(state, st): _fit_group(
            rows, state=state, sale_type=st, prior_strength=prior_strength
        )
        for (state, st), rows in sorted(by_state_sale.items())
    }
    by_sale_type = {
        st: _fit_group(rows, state=None, sale_type=st, prior_strength=prior_strength)
        for st, rows in sorted(by_sale.items())
    }
    global_bucket = _fit_group(
        outcomes, state=None, sale_type=None, prior_strength=prior_strength
    )
    # Global expert when empty should still be sensible mid prior
    if not outcomes:
        global_bucket = NoiseBucket(
            key="*|*",
            n=0,
            p_redeem=0.25,
            expert_p_redeem=0.25,
        )

    priors = SimulatorPriors(
        calibrated_at=utc_now(),
        n_outcomes=len(outcomes),
        provenance_counts=dict(provenance),
        prior_strength=prior_strength,
        buckets=buckets,
        by_sale_type=by_sale_type,
        global_bucket=global_bucket,
        source_path=str(path or outcomes_path()),
    )
    if cache:
        save_priors(priors)
    return priors


def save_priors(priors: SimulatorPriors, path: Path | None = None) -> Path:
    path = path or priors_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(priors.model_dump_json(indent=2), encoding="utf-8")
    return path


def load_priors(path: Path | None = None) -> SimulatorPriors | None:
    path = path or priors_path()
    if not path.exists():
        return None
    return SimulatorPriors.model_validate_json(path.read_text(encoding="utf-8"))


_CACHED: SimulatorPriors | None = None
_CACHED_MTIME: float | None = None


def get_priors(*, force_reload: bool = False) -> SimulatorPriors:
    """
    Return calibrated priors (cached in-process).

    Prefer cached simulator_priors.json; if missing/stale vs outcomes file,
    recalibrate from historical_outcomes.jsonl.
    """
    global _CACHED, _CACHED_MTIME

    o_path = outcomes_path()
    p_path = priors_path()
    o_mtime = o_path.stat().st_mtime if o_path.exists() else 0.0
    p_mtime = p_path.stat().st_mtime if p_path.exists() else 0.0

    if (
        not force_reload
        and _CACHED is not None
        and _CACHED_MTIME is not None
        and _CACHED_MTIME >= max(o_mtime, p_mtime)
    ):
        return _CACHED

    if p_path.exists() and p_mtime >= o_mtime and not force_reload:
        priors = load_priors(p_path)
        if priors is not None:
            _CACHED = priors
            _CACHED_MTIME = max(o_mtime, p_mtime)
            return priors

    priors = calibrate_priors(path=o_path if o_path.exists() else None, cache=True)
    _CACHED = priors
    _CACHED_MTIME = max(
        o_path.stat().st_mtime if o_path.exists() else 0.0,
        p_path.stat().st_mtime if p_path.exists() else 0.0,
    )
    return priors


def resolve_bucket(
    priors: SimulatorPriors,
    state: str,
    sale_type: SaleType | str,
) -> NoiseBucket:
    """Best available bucket: state+sale → sale → global → expert-only."""
    st = sale_type.value if isinstance(sale_type, SaleType) else sale_type
    key = _bucket_key(state, st)
    if key in priors.buckets and priors.buckets[key].n > 0:
        return priors.buckets[key]
    if st in priors.by_sale_type and priors.by_sale_type[st].n > 0:
        return priors.by_sale_type[st]
    if priors.global_bucket and priors.global_bucket.n > 0:
        # Overlay expert p for this state/sale even if using global exit noise
        gb = priors.global_bucket.model_copy()
        gb.p_redeem = expert_p_redeem(state, st)
        gb.expert_p_redeem = expert_p_redeem(state, st)
        gb.state = state
        gb.sale_type = st
        gb.key = key
        return gb
    return NoiseBucket(
        key=key,
        state=state,
        sale_type=st,
        n=0,
        p_redeem=expert_p_redeem(state, st),
        expert_p_redeem=expert_p_redeem(state, st),
    )


def sample_exit_mult(bucket: NoiseBucket, rng: Any) -> float:
    """Piecewise sample between p10/p50/p90 of historical exit/ARV."""
    # 50% in lower half (p10–p50), 50% upper (p50–p90)
    if rng.random() < 0.5:
        return rng.uniform(bucket.exit_mult_p10, bucket.exit_mult_p50)
    return rng.uniform(bucket.exit_mult_p50, bucket.exit_mult_p90)


def sample_holding_months(
    bucket: NoiseBucket,
    statute: dict[str, Any] | None,
    rng: Any,
    *,
    redeemed: bool,
) -> float:
    if redeemed:
        if statute and statute.get("redemption"):
            max_days = statute["redemption"].get("maxDays") or 365
            return float(rng.uniform(1, max(2, max_days / 30 / 2)))
        return float(rng.uniform(1, 6))

    if bucket.holding_months_mean is not None:
        mu = bucket.holding_months_mean
        sigma = bucket.holding_months_std or max(1.0, mu * 0.25)
        return max(1.0, float(rng.gauss(mu, sigma)))

    if statute:
        base = statute["quietTitle"]["typicalMonths"]
        return float(base + rng.uniform(0, 3))
    return float(rng.uniform(3, 9))


def sample_qt_cost(
    bucket: NoiseBucket,
    statute: dict[str, Any] | None,
    rng: Any,
) -> float:
    if bucket.qt_cost_mean is not None and bucket.n >= 5:
        mu = bucket.qt_cost_mean
        sigma = bucket.qt_cost_std or max(500.0, mu * 0.3)
        # Blend with statute range when available
        cost = float(rng.gauss(mu, sigma))
        if statute:
            lo = statute["quietTitle"]["typicalLow"]
            hi = statute["quietTitle"]["typicalHigh"]
            # Pull toward statute mid slightly
            mid = (lo + hi) / 2
            cost = 0.7 * cost + 0.3 * mid
            cost = max(lo * 0.5, min(hi * 1.5, cost))
        return max(0.0, cost)

    if statute:
        qt = statute["quietTitle"]
        return float(rng.uniform(qt["typicalLow"], qt["typicalHigh"]))
    return float(rng.uniform(2000, 6000))


def sample_surviving_liens(bucket: NoiseBucket, rng: Any) -> float:
    if rng.random() < bucket.lien_rate:
        # Log-ish around mean
        base = bucket.mean_lien_if_any or 4000.0
        return max(0.0, float(rng.gauss(base, base * 0.4)))
    return 0.0


def sample_rehab(bucket: NoiseBucket, lot_rehab: float | None, rng: Any) -> float:
    if lot_rehab is not None and lot_rehab > 0:
        return float(lot_rehab)
    if bucket.mean_rehab is not None:
        return max(0.0, float(rng.gauss(bucket.mean_rehab, bucket.mean_rehab * 0.35)))
    return float(rng.uniform(5000, 25000))


def apply_bid_arv_adjustment(
    p: float,
    opening_bid: float | None,
    arv: float | None,
) -> float:
    """Same structural cue as expert model: cheap openers → less redeem."""
    if opening_bid and arv and arv > 0:
        ratio = opening_bid / arv
        if ratio < 0.05:
            p *= 0.85
        elif ratio > 0.35:
            p = min(0.85, p * 1.25)
    return max(0.02, min(0.95, p))


def priors_summary(priors: SimulatorPriors | None = None) -> dict[str, Any]:
    priors = priors or get_priors()
    return {
        "calibrated_at": priors.calibrated_at,
        "n_outcomes": priors.n_outcomes,
        "provenance_counts": priors.provenance_counts,
        "prior_strength": priors.prior_strength,
        "n_buckets": len(priors.buckets),
        "buckets": {
            k: {
                "n": b.n,
                "p_redeem": b.p_redeem,
                "p_redeem_raw": b.p_redeem_raw,
                "expert_p_redeem": b.expert_p_redeem,
                "exit_mult_p50": b.exit_mult_p50,
                "lien_rate": b.lien_rate,
            }
            for k, b in sorted(priors.buckets.items())
        },
        "source_path": priors.source_path,
    }


# ---------------------------------------------------------------------------
# Deterministic synthetic seed (bootstrap until real outcomes are logged)
# ---------------------------------------------------------------------------

_SEED_SPECS: list[dict[str, Any]] = [
    # state, sale_type, fips, county, n, target_redeem_rate, mean_exit_mult
    {"state": "TX", "sale_type": SaleType.REDEEMABLE_DEED, "fips": "48201", "county": "Harris", "n": 24, "p_redeem": 0.42, "exit_mult": 0.84},
    {"state": "TX", "sale_type": SaleType.REDEEMABLE_DEED, "fips": "48453", "county": "Travis", "n": 12, "p_redeem": 0.40, "exit_mult": 0.86},
    {"state": "GA", "sale_type": SaleType.REDEEMABLE_DEED, "fips": "13121", "county": "Fulton", "n": 18, "p_redeem": 0.44, "exit_mult": 0.82},
    {"state": "GA", "sale_type": SaleType.REDEEMABLE_DEED, "fips": "13089", "county": "DeKalb", "n": 10, "p_redeem": 0.40, "exit_mult": 0.80},
    {"state": "FL", "sale_type": SaleType.TAX_DEED, "fips": "12086", "county": "Miami-Dade", "n": 16, "p_redeem": 0.08, "exit_mult": 0.78},
    {"state": "FL", "sale_type": SaleType.TAX_DEED, "fips": "12011", "county": "Broward", "n": 10, "p_redeem": 0.10, "exit_mult": 0.81},
    {"state": "AZ", "sale_type": SaleType.TAX_LIEN, "fips": "04013", "county": "Maricopa", "n": 20, "p_redeem": 0.78, "exit_mult": 0.88},
    {"state": "MI", "sale_type": SaleType.TAX_DEED, "fips": "26163", "county": "Wayne", "n": 14, "p_redeem": 0.06, "exit_mult": 0.74},
    {"state": "MI", "sale_type": SaleType.TAX_DEED, "fips": "26099", "county": "Macomb", "n": 8, "p_redeem": 0.08, "exit_mult": 0.77},
]


def generate_seed_outcomes(*, seed: int = 42) -> list[HistoricalOutcome]:
    """
    Build a deterministic synthetic seed corpus for calibration structure.

    Rates track expert priors with mild state variation. Replace / append with
    provenance=recorded rows as real auction results arrive.
    """
    import random

    rng = random.Random(seed)
    rows: list[HistoricalOutcome] = []
    seq = 0

    for spec in _SEED_SPECS:
        state = spec["state"]
        sale_type: SaleType = spec["sale_type"]
        statute = statute_for(state)
        pen = 0.0
        if statute and statute.get("redemption"):
            pen = float(statute["redemption"]["tiers"][0]["penalty"])

        for i in range(int(spec["n"])):
            seq += 1
            arv = float(rng.uniform(40_000, 280_000))
            opening = float(arv * rng.uniform(0.03, 0.28))
            # Bids cluster under a naive max
            winning = float(opening * rng.uniform(1.0, 1.55))
            redeemed = rng.random() < float(spec["p_redeem"])
            ownership = not redeemed
            days_to_redeem = None
            holding = None
            qt = None
            exit_price = None
            liens = None
            rehab = None
            pl = None

            if redeemed:
                days_to_redeem = float(rng.uniform(30, 400))
                holding = days_to_redeem / 30.0
                pl = winning * pen if pen else winning * -0.02
            else:
                holding = float(rng.uniform(2.5, 10.0))
                if statute:
                    qt = float(
                        rng.uniform(
                            statute["quietTitle"]["typicalLow"],
                            statute["quietTitle"]["typicalHigh"],
                        )
                    )
                else:
                    qt = float(rng.uniform(2000, 6000))
                mult = float(rng.gauss(spec["exit_mult"], 0.06))
                mult = max(0.55, min(1.05, mult))
                exit_price = arv * mult
                liens = 0.0 if rng.random() > 0.28 else float(rng.uniform(1500, 12000))
                rehab = float(rng.uniform(4000, 35000))
                pl = exit_price - winning - qt - liens - rehab * 0.5

            rows.append(
                HistoricalOutcome(
                    id=f"seed-{state.lower()}-{seq:04d}",
                    state=state,
                    fips=spec["fips"],
                    county_name=spec["county"],
                    sale_type=sale_type,
                    sale_date=f"2024-{(i % 12) + 1:02d}-{(i % 27) + 1:02d}",
                    opening_bid=round(opening, 2),
                    winning_bid=round(winning, 2),
                    assessed_value=round(arv * rng.uniform(0.85, 1.05), 2),
                    arv_estimate=round(arv, 2),
                    redeemed=redeemed,
                    ownership_taken=ownership,
                    days_to_redeem=round(days_to_redeem, 1) if days_to_redeem else None,
                    holding_months=round(holding, 2) if holding else None,
                    quiet_title_cost=round(qt, 2) if qt is not None else None,
                    exit_price=round(exit_price, 2) if exit_price is not None else None,
                    profit_loss=round(pl, 2) if pl is not None else None,
                    surviving_liens=round(liens, 2) if liens is not None else None,
                    rehab_cost=round(rehab, 2) if rehab is not None else None,
                    penalty_rate=pen if redeemed and pen else None,
                    bid_to_arv=round(winning / arv, 4),
                    provenance="synthetic_seed",
                    source="deedpilot_seed_v1",
                    notes="Bootstrap seed for simulator noise; not a county record.",
                )
            )
    return rows


def ensure_seed_outcomes(*, force: bool = False) -> Path:
    """Write seed JSONL if missing (or force regenerate)."""
    path = outcomes_path()
    if path.exists() and not force and path.stat().st_size > 0:
        return path
    n = write_outcomes(generate_seed_outcomes())
    calibrate_priors(cache=True)
    return path if n else path
