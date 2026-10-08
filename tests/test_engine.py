from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest

from luna_ngo.demo.scenarios import RESTAURANT, _hours, ngo, passport
from luna_ngo.engine.checks import check_capacity, check_food_compatibility, check_receiving_hours, check_status
from luna_ngo.engine.geo import estimate_delivery_plan, haversine_km
from luna_ngo.engine.passport import validate_food_passport
from luna_ngo.engine.scoring import compute_reliability, evaluate_ngo, plan_split, rank_evaluations
from luna_ngo.models import NGO


def food(**kw):
    return validate_food_passport(passport(**kw))["food"]


def N(*a, **k):
    return NGO.model_validate(ngo(*a, **k))


# ------------------------------------------------------------------ geo / ETA
def test_haversine_known_distance():
    # Bengaluru MG Road -> Kempegowda airport ~ 30 km
    d = haversine_km(12.9716, 77.5946, 13.1989, 77.7068)
    assert 27 < d < 30


def test_eta_plan_components(cfg):
    p = estimate_delivery_plan(2.0, cfg)
    assert p["travel_minutes"] == pytest.approx(2.0 * 1.35 / 20 * 60, abs=0.1)
    assert p["total_plan_minutes"] == pytest.approx(8 + p["travel_minutes"] + 5, abs=0.1)
    assert estimate_delivery_plan(2.0, cfg, extra_ngos_in_plan=1)["total_plan_minutes"] > p["total_plan_minutes"]


# ------------------------------------------------------------------ capacity / quantity matching
def test_quantity_matching_prefers_ngo_that_can_absorb(cfg):
    f = food(qty=80)
    a = N("A", "A", 2, 0, 20, "HIGH", 20)
    b = N("B", "B", 2, 90, 100, "HIGH", 120)
    c = N("C", "C", 2, 180, 50, "HIGH", 50)
    evs = [evaluate_ngo(n, f, 80, cfg) for n in (a, b, c)]
    ranked = rank_evaluations(evs)["ranked"]
    assert ranked[0]["ngo_id"] == "B"
    assert check_capacity(a, 80, cfg)["allocatable"] == 20
    assert check_capacity(b, 80, cfg)["capacity_fit"] == 1.0


def test_no_demand_or_capacity_is_infeasible(cfg):
    assert not check_capacity(N("X", "X", 1, 0, 0, "LOW", 50), 80, cfg)["ok"]
    assert not check_capacity(N("Y", "Y", 1, 0, 50, "LOW", 0), 80, cfg)["ok"]


def test_overloaded_ngo_excluded(cfg):
    assert not check_capacity(N("X", "X", 1, 0, 100, "HIGH", 100, active=5), 80, cfg)["ok"]


def test_demand_urgency_affects_score(cfg):
    f = food(qty=80)
    hi = evaluate_ngo(N("H", "H", 2, 0, 100, "HIGH", 120), f, 80, cfg)
    lo = evaluate_ngo(N("L", "L", 2, 0, 100, "LOW", 120), f, 80, cfg)
    assert hi["factors"]["demand_urgency"] > lo["factors"]["demand_urgency"]
    assert hi["match_score"] > lo["match_score"]


# ------------------------------------------------------------------ status / memory
def test_status_rules(cfg):
    assert check_status(N("A", "A", 1, 0, 10, "LOW", 10))["ok"]
    assert check_status(N("A", "A", 1, 0, 10, "LOW", 10, status="AT_CAPACITY"))["backup_only"]
    assert not check_status(N("A", "A", 1, 0, 10, "LOW", 10, status="CLOSED"))["ok"]
    assert not check_status(N("A", "A", 1, 0, 10, "LOW", 10, status="UNAVAILABLE"))["ok"]


def test_history_never_overrides_closed_status(cfg):
    perfect_history = N("P", "Perfect", 1, 0, 200, "CRITICAL", 200, acc=1.0, dist_rate=1.0, samples=1000, status="CLOSED")
    ev = evaluate_ngo(perfect_history, food(), 80, cfg)
    assert not ev["feasible"] and ev["match_score"] == 0
    assert ev["first_failed_stage"] == "status"


def test_reliability_neutral_prior_without_history(cfg):
    n = NGO.model_validate({**ngo("Z", "Z", 1, 0, 50, "HIGH", 50), "reliability": {}})
    r = compute_reliability(n, None, cfg)
    assert r["insufficient_history"] and r["acceptance_rate"] == cfg["reliability"]["neutral_prior"]


def test_observed_history_updates_reliability(cfg):
    n = N("Z", "Z", 1, 0, 50, "HIGH", 50, acc=0.9, samples=10)
    better = compute_reliability(n, {"requests": 10, "accepted": 10, "avg_confirmation_minutes": 2}, cfg)
    worse = compute_reliability(n, {"requests": 10, "accepted": 0, "avg_confirmation_minutes": 2}, cfg)
    assert better["acceptance_rate"] > worse["acceptance_rate"]


def test_category_rejection_memory_penalises(cfg):
    f = food()
    plain = N("A", "A", 2, 0, 100, "HIGH", 120)
    picky = N("B", "B", 2, 0, 100, "HIGH", 120, cat_stats={"cooked_meal": {"requests": 8, "accepted": 1}})
    a, b = evaluate_ngo(plain, f, 80, cfg), evaluate_ngo(picky, f, 80, cfg)
    assert b["feasible"]  # memory influences ranking, does not hard-exclude
    assert b["factors"]["food_compatibility"] < a["factors"]["food_compatibility"]
    assert any("Memory" in c for c in b["concerns"])


# ------------------------------------------------------------------ hours
def _arr(minutes):
    return datetime.now(timezone.utc) + timedelta(minutes=minutes)


def test_receiving_hours_open(cfg):
    assert check_receiving_hours(N("A", "A", 1, 0, 1, "LOW", 1), _arr(15), 5, cfg)["ok"]


def test_receiving_hours_closing_before_arrival(cfg):
    n = N("A", "A", 1, 0, 1, "LOW", 1, hours=_hours("Asia/Kolkata", 6, 0.1))
    r = check_receiving_hours(n, _arr(20), 5, cfg, latest_completion=_arr(120))
    assert not r["ok"]


def test_receiving_hours_wait_for_opening_within_deadline(cfg):
    n = N("A", "A", 1, 0, 1, "LOW", 1, hours=_hours("Asia/Kolkata", -0.5, 5))  # opens in 30 min
    r = check_receiving_hours(n, _arr(10), 5, cfg, latest_completion=_arr(120))
    assert r["ok"] and 15 <= r["wait_minutes"] <= 21
    assert not check_receiving_hours(n, _arr(10), 5, cfg, latest_completion=_arr(25))["ok"]


def test_overnight_hours(cfg):
    tz = ZoneInfo("Asia/Kolkata")
    n = N("A", "A", 1, 0, 1, "LOW", 1, hours={"start": "20:00", "end": "02:00"})
    late = datetime.now(tz).replace(hour=23, minute=30, second=0, microsecond=0)
    noon = late.replace(hour=12, minute=0)
    assert check_receiving_hours(n, late, 5, cfg, latest_completion=late + timedelta(minutes=30))["ok"]
    assert not check_receiving_hours(n, noon, 5, cfg, latest_completion=noon + timedelta(hours=2))["ok"]


# ------------------------------------------------------------------ compatibility
def test_vegetarian_only_rejects_non_veg(cfg):
    n = N("V", "V", 1, 0, 50, "HIGH", 50, constraints=["vegetarian_only"])
    assert check_food_compatibility(n, food(ingredients=("rice", "chicken")))["ok"] is False
    assert check_food_compatibility(n, food(ingredients=("rice", "peas")))["ok"] is True


def test_allergen_constraint_needs_known_allergens(cfg):
    n = N("V", "V", 1, 0, 50, "HIGH", 50, constraints=["nut_free"])
    p = passport()
    p.pop("allergens")
    unknown = validate_food_passport(p)["food"]
    assert not check_food_compatibility(n, unknown)["ok"]
    assert not check_food_compatibility(n, food(allergens=("peanuts",)))["ok"]
    assert check_food_compatibility(n, food(allergens=()))["ok"]


def test_category_hard_filter_and_jain(cfg):
    bakery_only = N("B", "B", 1, 0, 50, "HIGH", 50, accepted=["bakery"])
    assert not check_food_compatibility(bakery_only, food())["ok"]
    jain = N("J", "J", 1, 0, 50, "HIGH", 50, constraints=["no_onion_garlic"])
    assert not check_food_compatibility(jain, food(ingredients=("rice", "onion")))["ok"]
    assert check_food_compatibility(jain, food(ingredients=("rice", "peas")))["ok"]


# ------------------------------------------------------------------ urgency / window
def test_urgency_excludes_ngos_that_cannot_make_it(cfg):
    f = food(qty=50, minutes=24)
    far = evaluate_ngo(N("F", "Far", 6, 0, 200, "CRITICAL", 200), f, 50, cfg)
    near = evaluate_ngo(N("C", "Near", 1.0, 0, 50, "LOW", 50), f, 50, cfg)
    assert not far["feasible"] and far["first_failed_stage"] == "rescue_window"
    assert near["feasible"]


def test_eta_preferred_when_window_moderate(cfg):
    f = food(qty=80, minutes=120)
    near = evaluate_ngo(N("A", "A", 1.5, 0, 100, "HIGH", 120), f, 80, cfg)
    far = evaluate_ngo(N("B", "B", 10, 0, 110, "HIGH", 120, area=15), f, 80, cfg)
    assert near["match_score"] > far["match_score"]


# ------------------------------------------------------------------ ranking / weights / split
def test_ranking_funnel_and_order(cfg):
    f = food()
    ngos = [N("A", "A", 2, 0, 100, "HIGH", 120), N("B", "B", 3, 0, 60, "MEDIUM", 80),
            N("C", "C", 2, 0, 100, "HIGH", 120, status="CLOSED")]
    r = rank_evaluations([evaluate_ngo(n, f, 80, cfg) for n in ngos])
    assert [e["ngo_id"] for e in r["ranked"]] == ["A", "B"]
    assert r["funnel"][0]["removed"] == 1 and r["excluded"][0]["ngo_id"] == "C"


def test_weights_are_configurable(cfg):
    from luna_ngo.config import load_config
    f = food()
    near_low = N("A", "A", 1, 0, 100, "LOW", 120)
    far_high = N("B", "B", 6, 0, 100, "CRITICAL", 120)
    travel_cfg = load_config(overrides={"match_score_weights": {"demand_urgency": 0.0, "travel_time": 1.0,
                                                                 "capacity_fit": 0, "food_compatibility": 0,
                                                                 "receiving_hours": 0, "reliability": 0, "current_load": 0}})
    demand_cfg = load_config(overrides={"match_score_weights": {"demand_urgency": 1.0, "travel_time": 0.0,
                                                                 "capacity_fit": 0, "food_compatibility": 0,
                                                                 "receiving_hours": 0, "reliability": 0, "current_load": 0}})
    rt = rank_evaluations([evaluate_ngo(n, f, 80, travel_cfg) for n in (near_low, far_high)])["ranked"]
    rd = rank_evaluations([evaluate_ngo(n, f, 80, demand_cfg) for n in (near_low, far_high)])["ranked"]
    assert rt[0]["ngo_id"] == "A" and rd[0]["ngo_id"] == "B"


def test_split_recommended_when_no_single_ngo_fits(cfg):
    f = food(qty=200)
    a, b = N("A", "A", 2, 0, 100, "HIGH", 100), N("B", "B", 2.5, 90, 100, "HIGH", 100)
    evs = rank_evaluations([evaluate_ngo(n, f, 200, cfg) for n in (a, b)])["ranked"]
    plan = plan_split(f, 200, evs, {"A": a, "B": b}, cfg)
    assert plan["recommended"] == "SPLIT_DONATION"
    assert sum(x["quantity"] for x in plan["split"]["allocations"]) == 200


def test_no_split_when_single_ngo_can_absorb(cfg):
    f = food(qty=80)
    a, b = N("A", "A", 2, 0, 100, "HIGH", 120), N("B", "B", 2.5, 90, 100, "HIGH", 100)
    evs = rank_evaluations([evaluate_ngo(n, f, 80, cfg) for n in (a, b)])["ranked"]
    assert plan_split(f, 80, evs, {"A": a, "B": b}, cfg)["recommended"] == "SINGLE_NGO"


# ------------------------------------------------------------------ invalid NGO data
def test_invalid_ngo_data_rejected_by_model():
    bad = ngo("X", "X", 1, 0, 10, "HIGH", 10)
    bad["capacity"]["available_capacity_today"] = 999
    bad["capacity"]["daily_meal_capacity"] = 10
    with pytest.raises(Exception):
        NGO.model_validate(bad)
    bad2 = ngo("X", "X", 1, 0, 10, "HIGH", 10)
    bad2["receiving_hours"] = {"start": "9am", "end": "25:00"}
    with pytest.raises(Exception):
        NGO.model_validate(bad2)
