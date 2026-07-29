"""
FastAPI surface for trusted tools + agent one-shot.

Run:
  uvicorn deedpilot_copilot.api:app --reload --port 8090
  # or
  python -m deedpilot_copilot.api
"""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI, HTTPException, Query
from pydantic import BaseModel, Field

from . import __version__
from .agent import DeedCopilotAgent
from .atlas import atlas_meta
from .maxbid import compute_maxbid
from .policy import check_url_policy
from .schemas import DealInputs, Lot
from .tools import (
    TOOL_CATALOG,
    resolve_atlas,
    tool_envelope_atlas,
    tool_envelope_maxbid,
)

app = FastAPI(
    title="DeedPilot Trusted Tools",
    version=__version__,
    description=(
        "Clean HTTP surface for lookup_atlas + compute_maxbid oracles. "
        "Numbers and jurisdiction facts come only from these tools — never from the LLM."
    ),
)


class AgentBody(BaseModel):
    lot: Lot
    seed: str | None = None


@app.get("/", tags=["meta"])
def root() -> dict[str, Any]:
    return {
        "service": "deedpilot-copilot",
        "version": __version__,
        "docs": "/docs",
        "tools": "/tools",
        "health": "/health",
    }


@app.get("/health", tags=["meta"])
def health() -> dict[str, Any]:
    meta: dict[str, Any] = {"ok": True, "service": "deedpilot-copilot", "version": __version__}
    try:
        meta["atlas"] = atlas_meta()
    except FileNotFoundError as e:
        meta["atlas"] = {"ok": False, "error": str(e)}
    return meta


@app.get("/tools", tags=["meta"])
def list_tools() -> dict[str, Any]:
    return {"tools": TOOL_CATALOG}


def _atlas_response(
    fips: str | None,
    state: str | None,
    county: str | None,
) -> dict[str, Any]:
    try:
        result = resolve_atlas(fips=fips, state=state, county=county)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except KeyError as e:
        raise HTTPException(404, str(e)) from e
    except FileNotFoundError as e:
        raise HTTPException(503, str(e)) from e
    return tool_envelope_atlas(result)


@app.get("/tools/atlas", tags=["trusted-tools"])
@app.get("/tools/lookup_atlas", tags=["trusted-tools"])
def tool_lookup_atlas(
    fips: str | None = Query(None, description="5-digit county FIPS, e.g. 48201"),
    state: str | None = Query(None, description="USPS state code, e.g. TX"),
    county: str | None = Query(None, description="County name or slug, e.g. harris"),
) -> dict[str, Any]:
    """Trusted tool: resolve county tax-sale rules + provenance."""
    return _atlas_response(fips, state, county)


@app.post("/tools/maxbid", tags=["trusted-tools"])
@app.post("/tools/compute_maxbid", tags=["trusted-tools"])
def tool_compute_maxbid(body: DealInputs) -> dict[str, Any]:
    """
    Trusted oracle: deterministic walk-away price.

    Body accepts snake_case or camelCase (saleType, assessedValue, ...).
    """
    result = compute_maxbid(body)
    return tool_envelope_maxbid(result, body)


@app.get("/tools/check_policy", tags=["trusted-tools"])
def tool_check_policy(url: str = Query(..., description="URL to gate for ingest/web tools")):
    p = check_url_policy(url)
    return {
        "tool": "check_policy",
        "trusted": True,
        "host": p.host,
        "decision": p.decision,
        "minDelayMs": p.min_delay_ms,
        "reason": p.reason,
    }


@app.post("/agent/run_lot", tags=["agent"])
def agent_run_lot(body: AgentBody):
    """One-shot agent trajectory (uses trusted tools internally)."""
    agent = DeedCopilotAgent()
    traj = agent.run_lot(body.lot, seed=body.seed)
    return traj.model_dump(by_alias=True)


def main() -> None:
    import uvicorn

    uvicorn.run(
        "deedpilot_copilot.api:app",
        host="0.0.0.0",
        port=8090,
        reload=False,
    )


if __name__ == "__main__":
    main()
