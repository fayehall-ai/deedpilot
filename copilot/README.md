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

# 3) Smoke tests
pytest -q

# 4) One flywheel cycle
deedpilot-copilot cycle
# or: python -m deedpilot_copilot.cli cycle
```

### HTTP tools (Next.js)

```bash
# From deedpilot root
npm run dev

# Atlas
curl 'http://localhost:3000/api/tools/atlas?fips=48201'

# Maxbid
curl -X POST http://localhost:3000/api/tools/maxbid \
  -H 'content-type: application/json' \
  -d '{"state":"TX","saleType":"Redeemable Deed","assessedValue":200000,"rehabCost":20000,"openingBid":10000}'
```

### FastAPI (Python)

```bash
cd copilot && source .venv/bin/activate
uvicorn deedpilot_copilot.api:app --reload --port 8090
```

## CLI

```bash
deedpilot-copilot lookup 48201
deedpilot-copilot maxbid TX --sale-type "Redeemable Deed" --assessed 200000 --rehab 20000
deedpilot-copilot run-lot 48201 TX 180000 --opening 12000 --rehab 25000
deedpilot-copilot cycle
```

## What is “state of the art” here (honestly)

| Layer | Status |
|-------|--------|
| Trusted atlas + maxbid oracles | **Implemented** (TS + Python) |
| Trajectory schema + critique | **Implemented** |
| Simulator with redemption/QT sampling | **Implemented** (prior-based; needs historical calibration) |
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

## Next upgrades

1. ~~Swap rule-based `reflect_on_batch` for a strong-model structured reflection call.~~ **Done**
2. Load historical auction outcomes into the simulator noise model.
3. LLM planner on the agent decide node (still oracle-bound for numbers).
4. Add LangGraph persistence checkpointer when you wire multi-turn sessions.
5. Preference pairs from human spot-checks for prompt optimization.
