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

# 3) Ensure historical outcomes seed + calibrated priors (no-op if present)
deedpilot-copilot seed-history

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

## Historical outcomes → simulator noise

The simulator no longer uses only hard-coded expert rates. It loads
`data/historical_outcomes.jsonl`, fits per `(state, sale_type)` buckets, and
**shrinks** empirical rates toward expert priors (`prior_strength=20`
pseudo-counts) so small samples cannot dominate.

| Artifact | Role |
|----------|------|
| `data/historical_outcomes.jsonl` | One outcome per line (`HistoricalOutcome`) |
| `data/simulator_priors.json` | Fitted cache (rebuild anytime) |
| `provenance` | `synthetic_seed` bootstrap vs `recorded` / `investor_log` real data |

Noise calibrated from history:

- **p_redeem** (Bernoulli draw)
- **exit / ARV multiples** (p10/p50/p90 on ownership paths)
- **quiet-title cost** and **holding months** (blended with statute ranges)
- **surviving-lien rate** and magnitude
- **rehab** prior when lot omits rehab

```bash
# Bootstrap seed (already shipped) or force regenerate
deedpilot-copilot seed-history
deedpilot-copilot seed-history --force

# After appending real outcomes to the JSONL:
deedpilot-copilot calibrate-priors
deedpilot-copilot priors
```

Append real results as JSONL lines with `provenance: "recorded"` or
`"investor_log"`. Override paths with `DEEDPILOT_HISTORICAL_OUTCOMES` /
`DEEDPILOT_SIMULATOR_PRIORS` if needed.

## Next upgrades

1. ~~Swap rule-based `reflect_on_batch` for a strong-model structured reflection call.~~ **Done**
2. ~~Load historical auction outcomes into the simulator noise model.~~ **Done** (seed + real-data path)
3. LLM planner on the agent decide node (still oracle-bound for numbers).
4. Add LangGraph persistence checkpointer when you wire multi-turn sessions.
5. Preference pairs from human spot-checks for prompt optimization.
6. Replace synthetic seed rows with county / investor recorded outcomes over time.
