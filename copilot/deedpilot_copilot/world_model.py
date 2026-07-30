"""
Clearing-price world model.

What a tax-deed bidder actually needs to know that the oracle cannot tell them:
*what will it take to win?* ``compute_maxbid`` answers "what is this worth to
me" — a ceiling. This module answers "what does the room pay" — a distribution.
Together they bound the bid: never above the ceiling, rarely far above the room.

Scope is set by the data, not by ambition. Of 92k recorded rows only 17,770
carry a competitive dollar clearing price (see ``labels.py``); the Illinois
majority is bid down on the penalty rate with the price pinned to taxes owed,
and Maryland's premium bids are quarantined. Those 17.8k rows are Michigan Title
Check and California county sales, and they carry **no opening bid and no
assessed value** — so the honest feature set is county, state, and sale year.

That rules out gradient boosting on rich features; there are no rich features.
What the data supports is a hierarchical quantile model in log-price space:
county shrunk toward state shrunk toward global, with a fitted year trend. It is
deliberately small, it fits in milliseconds with no third-party dependency, and
every number it emits can be traced to a row count.

The output is a distribution, and ``p_win`` reads its CDF: bidding B wins when B
clears what the rest of the room would have paid.
"""

from __future__ import annotations

import math
import statistics
from pathlib import Path
from typing import Any, Iterable

from pydantic import BaseModel, Field

from .labels import clearing_price_rows
from .schemas import HistoricalOutcome, utc_now
from .splits import assert_no_leakage, get_split_rows

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
DEFAULT_MODEL_PATH = DATA_DIR / "world_model.json"

#: Quantile levels the model carries. Dense in the tails because the bid
#: decision lives at p75–p95, not at the median.
LEVELS: tuple[float, ...] = (0.05, 0.10, 0.25, 0.50, 0.75, 0.90, 0.95)

#: Shrinkage pseudo-count. A county needs ~30 sales before its own quantiles
#: outweigh its state's.
SHRINK_K = 30.0

#: Year trend is clamped: eight years of thin county data cannot justify an
#: unbounded extrapolation.
MAX_LOG_TREND_PER_YEAR = 0.25


class PriceQuantiles(BaseModel):
    """Predicted clearing-price distribution for one lot."""

    levels: list[float]
    values: list[float]  # dollars, ascending
    group: str  # which level of the hierarchy supplied the estimate
    n_train: int  # rows behind the group actually used
    shrunk_from: list[str]
    year_adjustment: float = 0.0
    note: str = ""


class _Group(BaseModel):
    key: str
    n: int
    log_q: list[float]


class ClearingPriceModel(BaseModel):
    """Hierarchical log-price quantile model. Fitted on the train split only."""

    fitted_at: str = Field(default_factory=utc_now)
    levels: list[float] = Field(default_factory=lambda: list(LEVELS))
    n_train: int = 0
    shrink_k: float = SHRINK_K
    global_group: _Group | None = None
    by_state: dict[str, _Group] = Field(default_factory=dict)
    by_county: dict[str, _Group] = Field(default_factory=dict)
    #: log-price drift per year, and the year it is measured from.
    year_slope: float = 0.0
    year_ref: int = 2023
    train_years: list[int] = Field(default_factory=list)
    note: str = ""


def _county_key(state: str | None, fips: str | None, county_name: str | None) -> str | None:
    if fips:
        return f"fips:{fips}"
    if state and county_name:
        return f"name:{state}:{county_name.strip().lower()}"
    return None


def _quantiles(values: list[float], levels: Iterable[float]) -> list[float]:
    """Linear-interpolated quantiles. Pure python; samples here are small."""
    s = sorted(values)
    out: list[float] = []
    for q in levels:
        if not s:
            out.append(0.0)
            continue
        if len(s) == 1:
            out.append(s[0])
            continue
        idx = (len(s) - 1) * q
        lo, hi = math.floor(idx), math.ceil(idx)
        if lo == hi:
            out.append(s[lo])
        else:
            w = idx - lo
            out.append(s[lo] * (1 - w) + s[hi] * w)
    return out


def _year_of(o: HistoricalOutcome) -> int | None:
    d = (o.sale_date or "").strip()
    if len(d) >= 4 and d[:4].isdigit():
        return int(d[:4])
    return None


def _fit_year_slope(rows: list[HistoricalOutcome]) -> tuple[float, int, list[int]]:
    """Least-squares drift of median log price per year, clamped."""
    by_year: dict[int, list[float]] = {}
    for o in rows:
        y = _year_of(o)
        if y is None or not o.winning_bid or o.winning_bid <= 0:
            continue
        by_year.setdefault(y, []).append(math.log(o.winning_bid))
    years = sorted(by_year)
    if len(years) < 3:
        return 0.0, (years[-1] if years else 2023), years

    pts = [(y, statistics.median(by_year[y])) for y in years]
    mx = statistics.mean(y for y, _ in pts)
    my = statistics.mean(v for _, v in pts)
    num = sum((y - mx) * (v - my) for y, v in pts)
    den = sum((y - mx) ** 2 for y, _ in pts)
    slope = (num / den) if den else 0.0
    slope = max(-MAX_LOG_TREND_PER_YEAR, min(MAX_LOG_TREND_PER_YEAR, slope))
    return slope, years[-1], years


def fit_clearing_price_model(
    rows: list[HistoricalOutcome] | None = None,
    *,
    shrink_k: float = SHRINK_K,
) -> ClearingPriceModel:
    """
    Fit on train-split clearing-price rows only.

    The leakage guard runs before any statistic is computed — a model fitted on
    val or test invalidates every downstream number, so it should fail loudly
    rather than quietly score well.
    """
    rows = rows if rows is not None else get_split_rows("train")
    assert_no_leakage(rows, allowed=("train",), context="fit_clearing_price_model")

    usable = [o for o in clearing_price_rows(rows) if o.winning_bid and o.winning_bid > 0]
    if not usable:
        return ClearingPriceModel(n_train=0, note="No clearing-price rows in train split.")

    slope, year_ref, years = _fit_year_slope(usable)

    def detrended_log(o: HistoricalOutcome) -> float:
        y = _year_of(o)
        adj = slope * ((y - year_ref) if y is not None else 0)
        return math.log(o.winning_bid) - adj

    global_logs = [detrended_log(o) for o in usable]
    global_group = _Group(
        key="global", n=len(global_logs), log_q=_quantiles(global_logs, LEVELS)
    )

    by_state_logs: dict[str, list[float]] = {}
    by_county_logs: dict[str, list[float]] = {}
    for o in usable:
        by_state_logs.setdefault(o.state, []).append(detrended_log(o))
        ck = _county_key(o.state, o.fips, o.county_name)
        if ck:
            by_county_logs.setdefault(ck, []).append(detrended_log(o))

    # State shrunk toward global; county shrunk toward its own state.
    by_state: dict[str, _Group] = {}
    for st, logs in by_state_logs.items():
        q = _quantiles(logs, LEVELS)
        w = len(logs) / (len(logs) + shrink_k)
        by_state[st] = _Group(
            key=f"state:{st}",
            n=len(logs),
            log_q=[w * a + (1 - w) * b for a, b in zip(q, global_group.log_q)],
        )

    by_county: dict[str, _Group] = {}
    for ck, logs in by_county_logs.items():
        st = ck.split(":")[1] if ck.startswith("name:") else None
        parent = by_state.get(st) if st else None
        if parent is None:
            # fips-keyed: recover state from any row with that key
            parent = next(
                (
                    by_state[o.state]
                    for o in usable
                    if _county_key(o.state, o.fips, o.county_name) == ck
                    and o.state in by_state
                ),
                global_group,
            )
        q = _quantiles(logs, LEVELS)
        w = len(logs) / (len(logs) + shrink_k)
        by_county[ck] = _Group(
            key=ck,
            n=len(logs),
            log_q=[w * a + (1 - w) * b for a, b in zip(q, parent.log_q)],
        )

    return ClearingPriceModel(
        levels=list(LEVELS),
        n_train=len(usable),
        shrink_k=shrink_k,
        global_group=global_group,
        by_state=by_state,
        by_county=by_county,
        year_slope=round(slope, 6),
        year_ref=year_ref,
        train_years=years,
        note=(
            "Hierarchical log-price quantiles (county -> state -> global) with a "
            "clamped year trend. No opening bid or assessed value exists on these "
            "rows, so the model conditions on geography and time only."
        ),
    )


def predict_quantiles(
    model: ClearingPriceModel,
    *,
    state: str,
    fips: str | None = None,
    county_name: str | None = None,
    year: int | None = None,
) -> PriceQuantiles:
    """Clearing-price quantiles for a lot, most specific group available."""
    if model.n_train == 0 or model.global_group is None:
        return PriceQuantiles(
            levels=list(model.levels),
            values=[0.0] * len(model.levels),
            group="none",
            n_train=0,
            shrunk_from=[],
            note="Model is unfitted — no clearing-price training rows.",
        )

    chain: list[str] = []
    ck = _county_key(state, fips, county_name)
    group = None
    if ck and ck in model.by_county:
        group = model.by_county[ck]
        chain = [ck, f"state:{state}", "global"]
    elif state in model.by_state:
        group = model.by_state[state]
        chain = [f"state:{state}", "global"]
    else:
        # Out of domain. The global pool is Michigan and California only, so
        # quoting it for a Texas redeemable deed would dress one state's price
        # level as a national prior. Refuse instead: callers treat n_train=0 as
        # "no win-probability model" and fall back to oracle-only sizing.
        return PriceQuantiles(
            levels=list(model.levels),
            values=[0.0] * len(model.levels),
            group="out_of_domain",
            n_train=0,
            shrunk_from=sorted(model.by_state),
            note=(
                f"No clearing-price training data for {state}. Trained states: "
                f"{', '.join(sorted(model.by_state)) or 'none'}."
            ),
        )

    adj = 0.0
    if year is not None:
        adj = model.year_slope * (year - model.year_ref)

    values = [math.exp(lq + adj) for lq in group.log_q]
    return PriceQuantiles(
        levels=list(model.levels),
        values=[round(v, 2) for v in values],
        group=group.key,
        n_train=group.n,
        shrunk_from=chain,
        year_adjustment=round(adj, 4),
        note=(
            f"n={group.n} training sales behind {group.key}"
            + (f"; year trend {adj:+.3f} log" if adj else "")
        ),
    )


def p_win(quantiles: PriceQuantiles, bid: float) -> float:
    """
    P(bid clears the auction) = CDF of the clearing-price distribution at `bid`.

    Interpolates between the stored quantiles and saturates outside them. The
    tails are deliberately conservative: below p05 we do not claim a win chance
    materially above zero, and above p95 we cap at 0.98 rather than 1.0, because
    seven quantiles from a few hundred sales cannot rule out a determined rival.
    """
    if not quantiles.values or quantiles.n_train == 0:
        return 0.0
    lv, vs = quantiles.levels, quantiles.values
    if bid <= vs[0]:
        # Linear fade to zero below the 5th percentile.
        return max(0.0, lv[0] * (bid / vs[0])) if vs[0] > 0 else 0.0
    if bid >= vs[-1]:
        return min(0.98, lv[-1] + (0.98 - lv[-1]) * 0.5)
    for i in range(1, len(vs)):
        if bid <= vs[i]:
            lo_v, hi_v = vs[i - 1], vs[i]
            lo_l, hi_l = lv[i - 1], lv[i]
            if hi_v <= lo_v:
                return hi_l
            w = (bid - lo_v) / (hi_v - lo_v)
            return lo_l + w * (hi_l - lo_l)
    return lv[-1]


# ---------------------------------------------------------------------------
# Honest evaluation: does the distribution hold up out of time?
# ---------------------------------------------------------------------------


def _pinball(actual: float, pred: float, level: float) -> float:
    d = actual - pred
    return max(level * d, (level - 1) * d)


def evaluate_clearing_price_model(
    model: ClearingPriceModel,
    rows: list[HistoricalOutcome],
) -> dict[str, Any]:
    """
    Score the model on a held-out split.

    Two things matter and neither is accuracy:

    - **Coverage.** The share of actual prices landing below each predicted
      quantile should match that quantile's level. A p90 that only covers 60%
      of outcomes will make the bid search overbid systematically.
    - **Pinball loss vs a global-constant baseline.** Conditioning on county and
      year has to beat quoting one distribution for the whole corpus, or the
      hierarchy is decoration.
    """
    usable = [o for o in clearing_price_rows(rows) if o.winning_bid and o.winning_bid > 0]
    if not usable or model.n_train == 0:
        return {"n": 0, "note": "no evaluable rows"}

    levels = list(model.levels)
    below = [0] * len(levels)
    loss = [0.0] * len(levels)
    base_loss = [0.0] * len(levels)
    base_vals = [math.exp(q) for q in (model.global_group.log_q if model.global_group else [])]
    n_county_hit = 0

    for o in usable:
        pq = predict_quantiles(
            model,
            state=o.state,
            fips=o.fips,
            county_name=o.county_name,
            year=_year_of(o),
        )
        if pq.group.startswith("fips:") or pq.group.startswith("name:"):
            n_county_hit += 1
        actual = float(o.winning_bid)
        for i, lv in enumerate(levels):
            if actual <= pq.values[i]:
                below[i] += 1
            loss[i] += _pinball(actual, pq.values[i], lv)
            if base_vals:
                base_loss[i] += _pinball(actual, base_vals[i], lv)

    n = len(usable)
    coverage = {f"p{int(lv*100)}": round(below[i] / n, 4) for i, lv in enumerate(levels)}
    cov_err = statistics.mean(abs(below[i] / n - lv) for i, lv in enumerate(levels))
    mean_pinball = sum(loss) / (n * len(levels))
    mean_base = sum(base_loss) / (n * len(levels)) if base_vals else None

    return {
        "n": n,
        "coverage": coverage,
        "target_coverage": {f"p{int(lv*100)}": lv for lv in levels},
        "mean_abs_coverage_error": round(cov_err, 4),
        "mean_pinball_loss": round(mean_pinball, 2),
        "baseline_global_pinball_loss": (
            round(mean_base, 2) if mean_base is not None else None
        ),
        "pinball_improvement_vs_global": (
            round(1 - mean_pinball / mean_base, 4)
            if mean_base and mean_base > 0
            else None
        ),
        "county_group_hit_rate": round(n_county_hit / n, 4),
    }


def save_model(model: ClearingPriceModel, path: Path | None = None) -> Path:
    path = path or DEFAULT_MODEL_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(model.model_dump_json(indent=2), encoding="utf-8")
    return path


def load_model(path: Path | None = None) -> ClearingPriceModel | None:
    path = path or DEFAULT_MODEL_PATH
    if not path.exists():
        return None
    return ClearingPriceModel.model_validate_json(path.read_text(encoding="utf-8"))


_CACHED: ClearingPriceModel | None = None


def get_model(*, force_reload: bool = False) -> ClearingPriceModel | None:
    """Cached accessor. Returns None when no model has been fitted yet."""
    global _CACHED
    if _CACHED is not None and not force_reload:
        return _CACHED
    _CACHED = load_model()
    return _CACHED


def train_and_evaluate() -> dict[str, Any]:
    """Fit on train, score on val and test, persist. Returns the full report."""
    model = fit_clearing_price_model()
    save_model(model)
    global _CACHED
    _CACHED = model
    return {
        "n_train": model.n_train,
        "n_counties": len(model.by_county),
        "n_states": len(model.by_state),
        "year_slope": model.year_slope,
        "year_ref": model.year_ref,
        "val": evaluate_clearing_price_model(model, get_split_rows("val")),
        "test": evaluate_clearing_price_model(model, get_split_rows("test")),
    }
