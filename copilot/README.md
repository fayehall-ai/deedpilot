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

Agent loop
  atlas → maxbid → decide → predict → simulate → critique

Flywheel
  batch trajectories → reflection lessons → memory → re-run → backtest gate
```

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

## What is “state of the art” here (honestly)

| Layer | Status |
|-------|--------|
| Trusted atlas + maxbid oracles | **Implemented** — Python callables + FastAPI + Next `/api/tools/*` |
| Trajectory schema + critique | **Implemented** |
| Simulator with redemption/QT sampling | **Implemented** — historical JSONL + expert shrinkage |
| Historical lot replay / sample sim | **Implemented** — `historical_sim` + CLI/API |
| Lesson memory + flywheel | **Implemented** |
| Structured LLM reflection | **Implemented** — Grok primary / Claude fallback; rules fallback + safety merge |
| Backtest harness | **Implemented** (synthetic) |
| LLM planner (decide node) | **Hook-ready** — agent decide still scaffold; numbers stay oracle-only |
| MCTS / world-model NN | **Not yet** — next phase |
| Autonomous profitable bidding | **Not claimed** — co-pilot + simulation fidelity first |

## Design rules (non-negotiable)

1. `compute_maxbid` is an **oracle**. Agents may only *use* its numbers.
2. `lookup_atlas` results require citing **asOf**, **sources**, and **is_state_default**.
3. When atlas falls back to state defaults, the rationale must say so explicitly.
4. Promote flywheel changes only if backtest metrics do not regress.

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
| **Lot page** | `HistoricalComps` sidebar (from `history_index.json`) |
| **API** | `GET /api/tools/comparables?state=MI&saleType=Tax%20Deed&assessedValue=80000` |
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

| Field | Available today? |
|-------|------------------|
| Winning bid / sold price | Yes (MI past sales) |
| County, sale date, tax deed type | Yes |
| Post-sale owner redemption | **No** for public past-sale pages — MI deeds have none by statute; TX/GA redeemable post-sale needs investor logs |
| Exit sale / rehab / QT actuals | **Not** on auction host — still sampled from statute/expert noise until logged |
| SEV / assessed on past cards | Often missing on result cards (enrich later) |

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
3. Expand real history: TX/GA sold lists + investor disposition logs (exit/rehab/redeem)
4. LLM planner on the agent decide node (still oracle-bound for numbers).
5. Add LangGraph persistence checkpointer when you wire multi-turn sessions.
6. Preference pairs from human spot-checks for prompt optimization.
