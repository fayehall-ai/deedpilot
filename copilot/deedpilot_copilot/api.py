"""FastAPI surface for trusted tools + agent one-shot."""

from __future__ import annotations

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from .agent import DeedCopilotAgent
from .atlas import lookup_atlas
from .maxbid import compute_maxbid
from .policy import check_url_policy
from .schemas import DealInputs, Lot

app = FastAPI(
    title="DeedPilot Copilot Tools",
    version="0.1.0",
    description="Trusted atlas + maxbid oracles and copilot agent endpoints.",
)


class MaxBidBody(DealInputs):
    pass


class AgentBody(BaseModel):
    lot: Lot
    seed: str | None = None


@app.get("/health")
def health():
    return {"ok": True, "service": "deedpilot-copilot"}


@app.get("/tools/lookup_atlas")
def tool_lookup_atlas(fips: str):
    try:
        result = lookup_atlas(fips)
    except KeyError as e:
        raise HTTPException(404, str(e)) from e
    except FileNotFoundError as e:
        raise HTTPException(503, str(e)) from e
    return {
        "tool": "lookup_atlas",
        "trusted": True,
        "mustCite": result.must_cite,
        "result": result.model_dump(),
    }


@app.post("/tools/compute_maxbid")
def tool_compute_maxbid(body: MaxBidBody):
    result = compute_maxbid(body)
    return {
        "tool": "compute_maxbid",
        "trusted": True,
        "oracle": True,
        "result": result.model_dump(),
    }


@app.get("/tools/check_policy")
def tool_check_policy(url: str):
    p = check_url_policy(url)
    return {
        "tool": "check_policy",
        "trusted": True,
        "host": p.host,
        "decision": p.decision,
        "minDelayMs": p.min_delay_ms,
        "reason": p.reason,
    }


@app.post("/agent/run_lot")
def agent_run_lot(body: AgentBody):
    agent = DeedCopilotAgent()
    traj = agent.run_lot(body.lot, seed=body.seed)
    return traj.model_dump(by_alias=True)
