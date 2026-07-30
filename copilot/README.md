# DeedPilot Copilot

**Self-improving tax-deed investment co-pilot** (Aug 2026 architecture).

Trusted tools do the arithmetic and atlas lookups. The agent reasons, cites
sources, and improves via a run → critique → reflect → store → re-evaluate
flywheel. The LLM never invents a walk-away price.

## Architecture

```
Trusted tools (oracles)
  lookup_atlas(fips)     → resolved rules + inheritance + asOf + sources
  compute_maxbid(inputs) → deterministic DealResult (never LLM)
  check_policy(url)      → ingest/web tool gate

Data integrity (everything downstream depends on this)
  labels.py   → what each row observes; quarantines what it does not
  splits.py   → frozen temporal train/val/test + leakage guard

Models
  world_model.py → clearing-price quantiles → P(win | bid)
  search.py      → argmax EV − λ·CVaR, hard-clamped to the oracle ceiling

Agent loop
  atlas → maxbid → history → search → decide → predict → simulate → critique

Flywheel
  real lots → trajectories → reflection lessons → memory → re-run
           → promotion gate on the val split (test never consulted)
```

**The ceiling and the room.** `compute_maxbid` says what a parcel is worth to
you; the world model says what the room will pay for it. The first is a hard
constraint, the second is an optimisation target. Confusing them is how bidders
lose money in both directions — overpaying to win, or losing lots they had
priced correctly.

## Trusted tools (highest-leverage surface)

**Rule:** the LLM never invents a walk-away price or county statute facts.
Import the callables, or hit FastAPI / Next.js — same contracts.

### Python callables

```python
from deedpilot_copilot import lookup_atlas, compute_maxbid, DealInputs, resolve_atlas

atlas = lookup_atlas("48201")
# or: resolve_atlas(state="TX", county="harris")
print(atlas.sale_type, atlas.is_state_default, atlas.as_of, atlas.sources)

deal = compute_maxbid(
    DealInputs(
        state="TX",
        sale_type="Redeemable Deed",  # or saleType= via camelCase dict
        assessed_value=200_000,
        rehab_cost=20_000,
        opening_bid=10_000,
    )
)
# dict form also works (JS-friendly keys):
# compute_maxbid({"state":"TX","saleType":"Redeemable Deed","assessedValue":200000,...})
print(deal.max_bid, deal.recommendation, deal.warnings)
```

### FastAPI (Python)

```bash
cd copilot && source .venv/bin/activate
uvicorn deedpilot_copilot.api:app --reload --port 8090
# or: deedpilot-tools
# OpenAPI: http://localhost:8090/docs
```

```bash
curl 'http://localhost:8090/tools/atlas?fips=48201'
curl 'http://localhost:8090/tools/atlas?state=TX&county=harris'
curl -X POST http://localhost:8090/tools/maxbid \
  -H 'content-type: application/json' \
  -d '{"state":"TX","saleType":"Redeemable Deed","assessedValue":200000,"rehabCost":20000,"openingBid":10000}'
```

Aliases: `/tools/lookup_atlas`, `/tools/compute_maxbid` (same handlers).
Catalog: `GET /tools`.

## Setup

From the DeedPilot repo root:

```bash
# 1) Export atlas JSON for Python
npx tsx scripts/export-atlas-for-copilot.ts

# 2) Install Python package
cd copilot
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"

# 3) Import *real* historical auction outcomes (MI Title Check past sales)
deedpilot-copilot import-history --years 2023,2024,2025

# 4) Smoke tests
pytest -q

# 5) One flywheel cycle
DEEDPILOT_REFLECT_MODE=rules deedpilot-copilot cycle
# or: python -m deedpilot_copilot.cli cycle
```

### HTTP tools (Next.js product)

Same semantics as the Python tools; used by the web app.

```bash
# From deedpilot root
npm run dev

curl 'http://localhost:3000/api/tools/atlas?fips=48201'
curl -X POST http://localhost:3000/api/tools/maxbid \
  -H 'content-type: application/json' \
  -d '{"state":"TX","saleType":"Redeemable Deed","assessedValue":200000,"rehabCost":20000,"openingBid":10000}'
```

## CLI

```bash
deedpilot-copilot lookup 48201
deedpilot-copilot lookup --state TX --county harris
deedpilot-copilot maxbid TX --sale-type "Redeemable Deed" --assessed 200000 --rehab 20000
deedpilot-copilot run-lot 48201 TX 180000 --opening 12000 --rehab 25000
deedpilot-copilot cycle
```

## What the corpus actually observes

Read this before trusting any number below it. The corpus is 92,208 recorded
rows, and the headline count is misleading — most of those rows do not observe
what the simulator needs. `deedpilot-copilot labels` prints the current
breakdown; `labels.py` holds the per-source rules and the reasoning for each.

| Source | Rows | `winning_bid` is | Redemption observed? |
|---|---:|---|---|
| Cook County IL annual tax sale | 70,109 | the **delinquent tax owed** — Illinois bids *down the penalty rate*, so there is no price competition to learn | No follow-up published |
| MI Title Check foreclosure auctions | 17,156 | a real competitive clearing price | **Yes** — redemption is extinguished at the foreclosure judgment, so `False` is statutory fact |
| Howard County MD open data | 2,524 | a high-bid premium, median **42× the opening bid** — quarantined pending field-mapping review | No |
| San Diego CA pre-sale cures | 1,404 | n/a — the owner paid before the sale, so the parcel never sold | No (and these are *not* post-sale redemptions) |
| CA county sold lots | 614 | a real clearing price | No |
| Map-crawl regex extractions | 401 | quarantined — one row scraped `42` from an Arizona statute heading (`42-18102`) | No |

**Usable for a price model: 17,770 rows. Usable for a redemption rate: 17,156,
all Michigan.** No row in the corpus records an exit price, quiet-title cost,
holding period, rehab spend, or realised P&L — those come from statute and
expert ranges, and `SimulatorPriors.unobserved_fields` says so at runtime.

This matters because it was silently wrong before. Counting `redeemed=False`
defaults as observed non-redemptions let 70k Cook County rows outvote the expert
prior and pin IL Tax Lien at **p_redeem = 0.02** — the simulator believed an
Illinois lien almost never redeems, when redemption is the entire thesis of
buying one. Fitting now runs on observed dispositions only:

| Bucket | Before | Now | Basis |
|---|---:|---:|---|
| IL Tax Lien | 0.02 | **0.72** | expert prior, `n_observed=0` |
| CA Tax Deed | 0.645 | **0.12** | expert prior; the 1,404 "redeemed" were pre-sale cures |
| MI Tax Deed | 0.02 | **0.02** | observed on 17,156 rows |

## What is “state of the art” here (honestly)

| Layer | Status |
|-------|--------|
| Trusted atlas + maxbid oracles | **Implemented** — Python callables + FastAPI + Next `/api/tools/*` |
| Label semantics + quarantine | **Implemented** — `labels.py`, 100% of rows classified |
| Frozen temporal splits + leakage guard | **Implemented** — `splits.py`, guard raises on held-out rows |
| Trajectory schema + critique | **Implemented** |
| Simulator with redemption/QT sampling | **Implemented** — observed-only fit + expert shrinkage |
| Clearing-price world model | **Implemented** — hierarchical log-price quantiles; 3.5% mean coverage error on val, +8% pinball vs a global baseline |
| Risk-adjusted bid search | **Implemented** — `search.py`, EV − CVaR penalty, hard-clamped to the oracle |
| Evaluation vs real baselines | **Implemented** — recorded clearing prices as ground truth, four baselines |
| Lesson memory + flywheel | **Implemented** — now runs on real lots from the train split |
| Structured LLM reflection | **Implemented** — Grok primary / Claude fallback; rules fallback + safety merge |
| LLM planner (decide node) | **Implemented** — search supplies the reference bid; numbers stay oracle-only |
| Learned redemption model | **Not possible on this corpus** — only Michigan observes disposition, and there it is statutorily zero |
| Exit / rehab / QT models | **Not possible on this corpus** — zero rows observe them |
| MCTS / neural world model | **Not yet** — the feature set (county, year) does not justify it |
| Autonomous profitable bidding | **Not claimed** — this is a co-pilot |

## Does it actually work? (held-out results)

Ground truth is the recorded clearing price, so "did this bid win" is a fact,
not a simulation. Policies scored on sales the fitting code never saw:

| Policy | Win rate | Mean bid | Mean overpay | Total surplus | Oracle violations |
|---|---:|---:|---:|---:|---:|
| `oracle_ceiling` | 0.654 | $18,877 | $15,713 | $13.9M | 0 |
| `fixed_fraction_0.90` *(previously shipping)* | 0.627 | $16,989 | $14,150 | $15.8M | 0 |
| **`search`** | 0.472 | **$7,558** | **$6,016** | **$20.8M** | 0 |

*Test split (2025+), n=2,008. Validation (2024, n=1,693) agrees: +36.9% surplus.*

The search wins fewer auctions and that is the point — it stops paying $14k over
the clearing price to win lots that were going to clear at $4k. Mean overpay
falls 57%; surplus rises 32% on test, 37% on val.

Caveats that belong next to those numbers: surplus is oracle-derived value, not
realised P&L, because no row records an exit. ARV is proxied from each county's
*training* median clearing price × 4 — an assumption applied identically to every
policy, and deliberately not from the row's own price, which is what the older
`backtest_historical` did (`winning_bid * 4`) and which leaks the answer into the
decision. Both splits are Michigan and California only.

## Design rules (non-negotiable)

1. `compute_maxbid` is an **oracle**. Agents may only *use* its numbers.
2. `lookup_atlas` results require citing **asOf**, **sources**, and **is_state_default**.
3. When atlas falls back to state defaults, the rationale must say so explicitly.
4. Promotion is decided on the **validation** split. Test is reported and never
   gated on — it only answers "did we fool ourselves on val", and it can only do
   that if no decision has consulted it.
5. A bid above the oracle ceiling is **disqualifying**, whatever the returns.
6. Never fit a parameter on a row a held-out metric will score. Call
   `assert_no_leakage` at the top of anything that fits.
7. A default is not an observation. If a source does not publish an outcome,
   that row does not enter the numerator *or* the denominator.
8. A source with no label rule contributes no rows. `archivist.import_batch`
   refuses the whole batch rather than importing the labelled part, so adding a
   source stays a reviewed code change. See `docs/agent-architecture.md`.

## Evaluation commands

```bash
deedpilot-copilot labels                 # what the corpus observes, by source
deedpilot-copilot corpus                 # per-source: how much is actually fittable
deedpilot-copilot archive rows.jsonl     # dry-run import; refuses unlabelled sources
deedpilot-copilot splits                 # frozen temporal split + counts
deedpilot-copilot world-model            # fit on train, score val + test
deedpilot-copilot evaluate --split test  # policy comparison vs recorded prices
deedpilot-copilot suggest-bid MI --fips 26049 --county "Genesee County" \
    --assessed 40000 --opening 3000 --rehab 15000 --year 2026
```

HTTP equivalents: `POST /tools/suggest_bid`, `GET /model/clearing_price`,
`GET /eval/policies?split=test`, `GET /data/labels`.

## LLM reflection

`critique.reflect_on_batch` prefers a strong-model structured call (same lesson
schema the flywheel already stores):

| Env | Role |
|-----|------|
| `XAI_API_KEY` | Primary (Grok / `XAI_MODEL`, default `grok-4.5`) |
| `ANTHROPIC_API_KEY` | Fallback |
| `DEEDPILOT_REFLECT_MODE` | `auto` (default), `llm`, or `rules` |

Keys are loaded from `deedpilot/.env.local` (or `.env`) automatically. When no
key is set or the provider chain fails, reflection degrades to the deterministic
rule engine. Hard safety lessons (oracle overbid, state-default disclosure) are
always merged under successful LLM output.

```bash
# Offline / CI — rules only
DEEDPILOT_REFLECT_MODE=rules deedpilot-copilot cycle

# Live reflection (needs XAI or Anthropic key in .env.local)
deedpilot-copilot cycle
```

## Self-improvement pass (`improve`)

One command updates priors, comps index, runs the flywheel (reflect → lessons),
and scores the agent on historical lots:

```bash
# Fast local improve (no network re-import)
DEEDPILOT_REFLECT_MODE=rules DEEDPILOT_DECIDE_MODE=rules \
  deedpilot-copilot improve --backtest-limit 30

# With live LLM reflection + decide (needs XAI_API_KEY or ANTHROPIC_API_KEY)
deedpilot-copilot improve

# Also refresh deep history first (slow)
deedpilot-copilot improve --deep
```

| Env | Meaning |
|-----|---------|
| `DEEDPILOT_REFLECT_MODE` | `auto` / `llm` / `rules` — batch lesson reflection |
| `DEEDPILOT_DECIDE_MODE` | `auto` / `llm` / `rules` — per-lot bid/pass (always oracle-clamped) |

Reports: `copilot/data/improve/latest.json`.

**Honest scope:** improves *data + lessons + evaluation*. Does not fine-tune weights.
Schedule with cron, e.g. weekly `improve --deep` then daily `improve`.

## History → agent, comps UI, backtest

Recorded outcomes are not just stored — they drive decisions and the lot page.

| Surface | How |
|---------|-----|
| **Agent** | `history_guidance` adds buffers + bid fraction; never above oracle maxbid |
| **Simulator** | `p_redeem` / noise from calibrated priors |
| **Lot page** | `HistoricalComps` + **history-guided suggested bid** (always ≤ maxBid) |
| **API** | `GET /api/tools/comparables?...` · `GET /api/tools/suggested-bid?state=MI&saleType=Tax%20Deed&assessedValue=80000&openingBid=5000` |
| **Backtest** | `deedpilot-copilot backtest-history --limit 80` |

```bash
# After import-history --deep:
deedpilot-copilot build-history-index
deedpilot-copilot comparables MI --sale-type "Tax Deed" --assessed 80000
deedpilot-copilot backtest-history --limit 40 --state MI
```

## Minimal historical-lot simulator

Replay a recorded auction row, or re-sample redemption / ownership costs while
keeping that lot’s bid-time economics (opening, ARV, winning bid).

| Mode | Behavior |
|------|----------|
| `replay` | Lock observed redeemed flag + recorded costs / P&L |
| `sample` | Monte Carlo: draw redemption *and* QT/liens/rehab/exit from noise model |
| `costs_only` | Lock redemption; re-draw ownership costs only |

```python
from deedpilot_copilot.historical_sim import (
    replay_historical,
    sample_historical,
    monte_carlo_historical,
    lot_from_historical,
    get_outcome,
)

h = get_outcome("seed-tx-0001")  # or any id from data/historical_outcomes.jsonl
lot = lot_from_historical(h)     # agent inputs
actual = replay_historical(h)    # ground-truth path
alt = sample_historical(h, mode="sample", seed="what-if-1")
stats = monte_carlo_historical(h, n=200, mode="sample")
```

```bash
deedpilot-copilot simulate --list
deedpilot-copilot simulate seed-tx-0001 --mode replay
deedpilot-copilot simulate seed-tx-0001 --mode sample -n 100
deedpilot-copilot simulate              # batch replay summary
```

HTTP: `GET /simulate/historical`, `POST /simulate/historical`
`{"outcome_id":"...","mode":"sample","n":100}`.

## Real historical outcomes → simulator noise

**Synthetic seed data is disabled.** The simulator calibrates only from
`provenance=recorded|investor_log|inferred` rows.

### Current source of truth

| Source | What we get | Command |
|--------|-------------|---------|
| **Deep multi-state** (open data + archives + PDFs) | Cook IL Socrata, Howard MD, San Diego sale PDFs, MI 2018–2026 Title Check | `import-history --deep` |
| **tax-deed-map county links** | Walk auction/tax URLs; extract sold prices when published | `import-history --from-map` |
| **Michigan Title Check** | Past auction sold lots | `import-history` (default years) |
| DeedPilot Postgres `lots` (optional) | `sold` / `redeemed` when ingest filled them | `--from-db` |

The map has **~1,010 researched counties** (Census pop 50k+ LA-depth research in
`tax-deed-map/data/county-data.js`), not 50k separate counties (the US has ~3,142).
Unresearched counties inherit **state** defaults and usually have **no** per-county
auction URL — the crawl indexes every URL that *is* in county research (~2k hosts).

Policy: `tax-sale.info` is allow-listed in `lib/ingest/policy.ts` (robots-permissive,
2s+ delay). RealAuction hosts stay blocked without agreement.

**Honest limits of public auction results**

Superseded by *What the corpus actually observes* at the top of this file, which
reports the measured fill rates rather than the expected ones. Summary: winning
bid is available and trustworthy on 17,770 rows; county, sale date and sale type
are near-complete; post-sale redemption, exit price, rehab, quiet-title cost and
holding period are observed on **zero** rows; assessed value survives on 2,524
rows, all of them in the quarantined Maryland set.

```bash
# Deep multi-state (recommended): open data + MI archive + CA sale PDFs
deedpilot-copilot import-history --deep

# Map link crawl (all researched county URLs; long; lower yield)
deedpilot-copilot import-history --from-map --map-root /path/to/tax-deed-map

# MI-only (Title Check past auctions)
deedpilot-copilot import-history --years 2018,2019,2020,2021,2022,2023,2024,2025

deedpilot-copilot priors
# Reports: data/deep_import_report.json, data/map_crawl_report.json
```

| Artifact | Role |
|----------|------|
| `data/historical_outcomes.jsonl` | Real outcomes only (`provenance=recorded`) |
| `data/simulator_priors.json` | Fitted cache from those rows |
| `deedpilot_copilot/ingest_real_history.py` | Importers |

Investor dispositions (exit price, rehab, QT, post-sale redeem in TX/GA) should be
appended as JSONL with `provenance: "investor_log"`.

## Next upgrades

1. ~~Swap rule-based `reflect_on_batch` for a strong-model structured reflection call.~~ **Done**
2. ~~Load historical auction outcomes into the simulator noise model.~~ **Done** (real MI sales; synthetic removed)
3. ~~LLM planner on the agent decide node (still oracle-bound for numbers).~~ **Done**
4. ~~Frozen splits, leakage guard, and evaluation against real baselines.~~ **Done**
5. ~~Clearing-price world model + risk-adjusted bid search.~~ **Done**

What would actually move the needle next, in order of value per unit of work:

6. **Verify the Maryland field mapping.** 2,524 quarantined rows come back if
   `bid_amount` turns out to be decomposable into lien + premium. That is the
   cheapest available expansion of the price corpus.
7. **Michigan opening bids.** Title Check publishes minimum bids on the *listing*
   pages, but the importer only keeps sold rows — 0% opening-bid fill. Recovering
   them adds the single most predictive feature the price model is missing, and
   would let `opening_only` function as a real baseline.
8. **Assessed values for MI parcels.** Joining SEV from county assessors would
   replace the ARV proxy multiplier with a real valuation and make surplus a
   defensible number rather than a ranking device.
9. **Investor disposition logs** (exit price, rehab, QT, post-sale redeem in
   TX/GA) as `provenance: "investor_log"` JSONL. Until these exist, every
   ownership-path economic is an expert range and no amount of modelling changes
   that.
10. Illinois penalty-rate model — the IL rows *do* carry signal, just not price
    signal. `winning_bid_percent` is the bid-down rate and is learnable.
11. LangGraph persistence checkpointer for multi-turn sessions.
12. Preference pairs from human spot-checks for prompt optimisation.
