"""Historical lot simulator: replay + sample on *real* recorded outcomes."""

from fastapi.testclient import TestClient

from deedpilot_copilot.api import app
from deedpilot_copilot.historical_sim import (
    batch_replay,
    bid_from_historical,
    list_outcomes,
    lot_from_historical,
    monte_carlo_historical,
    replay_historical,
    sample_historical,
    simulate_historical,
)


def _require_real_rows(n: int = 1, **kwargs):
    rows = list_outcomes(limit=max(n, 5), **kwargs)
    real = [r for r in rows if r.provenance == "recorded"]
    assert real, (
        "expected real historical_outcomes.jsonl — run: "
        "deedpilot-copilot import-history --years 2024,2025"
    )
    return real


def test_real_data_not_synthetic():
    rows = _require_real_rows(3)
    assert all(r.provenance == "recorded" for r in rows)
    assert all(r.source and "http" in r.source for r in rows)


def test_lot_from_historical_maps_inputs():
    h = _require_real_rows(1)[0]
    lot = lot_from_historical(h)
    assert lot.lot_id == h.id
    assert lot.state == h.state
    assert lot.metadata.get("redeemed_actual") == h.redeemed
    assert bid_from_historical(h) is not None


def test_replay_matches_recorded_redemption_flag():
    h = _require_real_rows(1)[0]
    sim = replay_historical(h)
    assert sim.redeemed == h.redeemed
    assert sim.ownership_taken == h.ownership_taken
    assert sim.cash_out > 0
    assert sim.details["mode"] == "replay"
    assert sim.details["provenance"] == "recorded"


def test_replay_by_id():
    h = _require_real_rows(1)[0]
    sim = simulate_historical(h.id, mode="replay")
    assert sim.details.get("historical_id") == h.id


def test_sample_is_seeded():
    h = _require_real_rows(1)[0]
    a = sample_historical(h, mode="sample", seed="s-a")
    b = sample_historical(h, mode="sample", seed="s-a")
    c = sample_historical(h, mode="sample", seed="s-b")
    assert a.profit_loss == b.profit_loss
    assert a.details["mode"] == "sample"
    assert c.details["seed"] != a.details["seed"]


def test_costs_only_locks_redemption_on_owned():
    rows = _require_real_rows(20)
    owned = next(r for r in rows if r.ownership_taken)
    sim = sample_historical(owned, mode="costs_only", seed="lock-1")
    assert sim.redeemed == owned.redeemed
    assert sim.details.get("locked_redemption") is True


def test_monte_carlo_summary():
    h = _require_real_rows(1, state="MI")[0]
    summary = monte_carlo_historical(h, n=40, mode="sample", seed="mc")
    assert summary["n"] == 40
    assert 0.0 <= summary["sample_redeem_rate"] <= 1.0
    assert "mean_profit" in summary
    assert summary["historical_id"] == h.id
    # MI tax deeds: empirical redeem rate should stay low in samples
    assert summary["model_p_redeem"] < 0.2


def test_batch_replay():
    summary = batch_replay(limit=25)
    assert summary["n"] == 25
    assert "total_profit" in summary


def test_fastapi_simulate_historical():
    client = TestClient(app)
    listed = client.get("/simulate/historical", params={"limit": 3, "state": "MI"})
    assert listed.status_code == 200
    ids = listed.json()["outcomes"]
    assert ids
    assert ids[0]["provenance"] == "recorded"
    oid = ids[0]["id"]

    rep = client.post(
        "/simulate/historical",
        json={"outcome_id": oid, "mode": "replay"},
    )
    assert rep.status_code == 200
    assert rep.json()["details"]["mode"] == "replay"

    mc = client.post(
        "/simulate/historical",
        json={"outcomeId": oid, "mode": "sample", "n": 15, "seed": "api"},
    )
    assert mc.status_code == 200
    body = mc.json()
    assert body["n"] == 15
    assert "mean_profit" in body
