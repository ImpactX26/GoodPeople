"""Explainable match scoring, ranking and split planning (all deterministic).

match_score = 100 * sum(weight_i * factor_i), every factor in [0, 1],
weights come from config (`match_score_weights`). Hard filters run first:
a high score can never rescue an infeasible NGO.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from ..models import NGO
from .checks import check_capacity, check_food_compatibility, check_receiving_hours, check_status
from .geo import estimate_delivery_plan, haversine_km
from .passport import FoodContext

FACTOR_LABELS = {
    "demand_urgency": "Demand urgency",
    "capacity_fit": "Capacity fit",
    "travel_time": "Travel time",
    "food_compatibility": "Food compatibility",
    "receiving_hours": "Receiving hours",
    "reliability": "Reliability",
    "current_load": "Current load",
}


# --------------------------------------------------------------------- reliability / memory
def compute_reliability(ngo: NGO, observed: Optional[dict[str, Any]], cfg: dict[str, Any]) -> dict[str, Any]:
    """Blend declared baseline (synthetic in DEMO, reported in LIVE) with what
    Luna has actually observed. With too little evidence, use a neutral prior
    and say so - never invent statistics."""
    rc = cfg["reliability"]
    prior = rc["neutral_prior"]
    base = ngo.reliability
    observed = observed or {"requests": 0, "accepted": 0, "avg_confirmation_minutes": None}
    n_base = base.sample_size if base.acceptance_rate is not None else 0
    n_obs = observed["requests"]
    notes = []
    if n_base + n_obs >= rc["min_samples_for_history"]:
        acc_hits = (base.acceptance_rate or 0) * n_base + observed["accepted"]
        acceptance = acc_hits / (n_base + n_obs)
        src = []
        if n_base:
            src.append(f"{n_base} {base.source} records")
        if n_obs:
            src.append(f"{n_obs} observed by Luna")
        notes.append(f"Accepted {round(acceptance*100)}% of {n_base + n_obs} requests ({' + '.join(src)})")
        insufficient = False
    else:
        acceptance = prior
        insufficient = True
        notes.append(f"Insufficient history ({n_base + n_obs} requests) - neutral prior {prior} used")
    distribution = base.successful_distribution_rate if base.successful_distribution_rate is not None else prior
    cancellation = base.cancellation_rate if base.cancellation_rate is not None else 0.0
    conf_min = observed.get("avg_confirmation_minutes") or base.average_confirmation_minutes
    speed = 1.0 if conf_min is None or conf_min <= 5 else max(0.5, 1 - (conf_min - 5) / 50)
    factor = 0.45 * acceptance + 0.35 * distribution + 0.10 * (1 - cancellation) + 0.10 * speed
    return {
        "factor": round(factor, 4), "acceptance_rate": round(acceptance, 3),
        "successful_distribution_rate": round(distribution, 3), "cancellation_rate": round(cancellation, 3),
        "average_confirmation_minutes": round(conf_min, 1) if conf_min is not None else None,
        "insufficient_history": insufficient, "baseline_source": base.source, "notes": notes,
    }


def merged_category_memory(ngo: NGO, observed: Optional[dict[str, Any]]) -> dict[str, dict[str, int]]:
    merged: dict[str, dict[str, int]] = {k: {"requests": v.requests, "accepted": v.accepted}
                                         for k, v in ngo.history.category_stats.items()}
    for k, v in ((observed or {}).get("category_stats") or {}).items():
        m = merged.setdefault(k, {"requests": 0, "accepted": 0})
        m["requests"] += v["requests"]
        m["accepted"] += v["accepted"]
    return merged


# --------------------------------------------------------------------- single NGO evaluation
def evaluate_ngo(ngo: NGO, food: FoodContext, quantity: int, cfg: dict[str, Any],
                 now: Optional[datetime] = None, observed_history: Optional[dict] = None,
                 extra_ngos_in_plan: int = 0) -> dict[str, Any]:
    """Runs every deterministic check + factor for one NGO and one quantity."""
    now = now or datetime.now(timezone.utc)
    w = cfg["match_score_weights"]
    le = cfg["logistics_estimates"]
    exclusions: list[str] = []
    stage_failed: Optional[str] = None

    def fail(stage: str, reason: str):
        nonlocal stage_failed
        exclusions.append(reason)
        if stage_failed is None:
            stage_failed = stage

    status = check_status(ngo)
    if not status["ok"]:
        fail("status", status["detail"])

    dist = haversine_km(food.latitude, food.longitude, ngo.location.latitude, ngo.location.longitude)
    sc = cfg["candidate_search"]
    if dist > sc["search_radius_km"]:
        fail("distance", f"{dist:.1f} km away - outside the {sc['search_radius_km']:.0f} km search radius")
    elif sc["enforce_service_area"] and dist > ngo.service_area_km * sc["service_area_tolerance_factor"]:
        fail("distance", f"Restaurant is {dist:.1f} km away, outside NGO service area ({ngo.service_area_km:g} km)")

    memory = merged_category_memory(ngo, observed_history)
    compat = check_food_compatibility(ngo, food, memory, cfg)
    if not compat["ok"]:
        fail("compatibility", compat["detail"])

    cap = check_capacity(ngo, quantity, cfg)
    if not cap["ok"]:
        fail("capacity", cap["detail"])

    plan = estimate_delivery_plan(dist, cfg, extra_ngos_in_plan)
    arrival = now + timedelta(minutes=plan["minutes_to_arrival"])
    latest = food.deadline - timedelta(minutes=le["safety_margin_minutes"])
    hours = check_receiving_hours(ngo, arrival, plan["handover_minutes"], cfg, latest_completion=latest)
    if not hours["ok"]:
        fail("receiving_hours", hours["detail"])

    remaining = food.remaining_minutes(now)
    completion_minutes = plan["total_plan_minutes"] + (hours.get("wait_minutes") or 0)
    slack = remaining - le["safety_margin_minutes"] - completion_minutes
    window_ok = slack >= 0
    if not window_ok:
        fail("rescue_window", f"Delivery needs ~{completion_minutes:.0f} min but only {remaining:.0f} min remain "
                              f"(incl. {le['safety_margin_minutes']} min safety margin)")

    rel = compute_reliability(ngo, observed_history, cfg)

    # ---- factors (0..1)
    lvl = cfg["demand_urgency_levels"].get(ngo.current_demand.urgency, 0.5)
    need_ratio = min(1.0, ngo.current_demand.meals_needed / quantity) if quantity else 0
    f_demand = lvl * (0.5 + 0.5 * need_ratio)
    f_capacity = cap["capacity_fit"]
    max_travel = le["max_reasonable_travel_minutes"]
    f_window = max(0.0, 1 - completion_minutes / remaining) if remaining > 0 else 0.0
    f_travel = 0.5 * f_window + 0.5 * max(0.0, 1 - plan["travel_minutes"] / max_travel)
    f_compat = compat["factor"]
    f_hours = hours["factor"]
    f_rel = rel["factor"]
    max_active = cfg["capacity"]["max_active_donations"]
    f_load = max(0.0, 1 - min(1.0, (ngo.active_donations + 0.5 * ngo.donations_received_today) / max_active))
    factors = {
        "demand_urgency": round(f_demand, 4), "capacity_fit": round(f_capacity, 4),
        "travel_time": round(f_travel, 4), "food_compatibility": round(f_compat, 4),
        "receiving_hours": round(f_hours, 4), "reliability": round(f_rel, 4), "current_load": round(f_load, 4),
    }
    contributions = {k: round(100 * w.get(k, 0) * v, 2) for k, v in factors.items()}
    score = round(sum(contributions.values()), 1)

    # probability the allocation is actually delivered (used for split decisions)
    time_factor = 1.0 if slack >= 15 else (0.85 if slack >= 5 else 0.7)
    p_success = rel["acceptance_rate"] * rel["successful_distribution_rate"] * time_factor

    strengths, concerns = [], []
    if ngo.current_demand.urgency in ("HIGH", "CRITICAL"):
        strengths.append(f"{ngo.current_demand.urgency.title()} current demand ({ngo.current_demand.meals_needed} meals needed)")
    elif ngo.current_demand.urgency == "LOW":
        concerns.append("Low current demand")
    if cap["ok"] and cap["allocatable"] >= quantity:
        strengths.append(f"Enough capacity for all {quantity} meals")
    elif cap["ok"]:
        concerns.append(f"Can take only {cap['allocatable']} of {quantity} meals")
    if compat["ok"]:
        strengths.append("Food is compatible" + (" and preferred" if compat["preferred"] else ""))
    if window_ok:
        strengths.append(f"~{plan['travel_minutes']:.0f} min travel, {slack:.0f} min spare in rescue window")
    if hours["ok"] and not hours.get("wait_minutes"):
        strengths.append("Open to receive on arrival")
    if not rel["insufficient_history"] and rel["acceptance_rate"] >= 0.85:
        strengths.append(f"Reliable ({round(rel['acceptance_rate']*100)}% acceptance)")
    elif rel["insufficient_history"]:
        concerns.append("Little acceptance history")
    elif rel["acceptance_rate"] < 0.6:
        concerns.append(f"Low acceptance rate ({round(rel['acceptance_rate']*100)}%)")
    if ngo.active_donations >= 3:
        concerns.append(f"Already handling {ngo.active_donations} active donations")
    concerns += [n for n in compat["notes"] if n.startswith("Memory")]

    return {
        "ngo_id": ngo.ngo_id, "name": ngo.name, "status": ngo.status.value,
        "feasible": not exclusions, "backup_only": bool(status.get("backup_only")) and len(exclusions) == 1,
        "exclusion_reasons": exclusions, "first_failed_stage": stage_failed,
        "match_score": score if not exclusions else 0.0, "raw_score": score,
        "factors": factors, "contributions": contributions,
        "metrics": {
            "distance_km": plan["distance_km"], "travel_minutes": plan["travel_minutes"],
            "total_plan_minutes": round(completion_minutes, 1), "remaining_rescue_minutes": round(remaining, 1),
            "slack_minutes": round(slack, 1), "allocatable_quantity": cap["allocatable"],
            "available_capacity": cap["available_capacity"], "meals_needed": cap["meals_needed"],
            "demand_urgency": ngo.current_demand.urgency, "active_donations": ngo.active_donations,
            "estimated_arrival": arrival.isoformat(), "wait_minutes": hours.get("wait_minutes"),
            "p_success": round(p_success, 3),
        },
        "checks": {
            "status": status["detail"], "capacity": cap["detail"], "compatibility": compat["detail"],
            "receiving_hours": hours["detail"], "rescue_window": "Feasible" if window_ok else exclusions[-1],
        },
        "reliability": rel, "strengths": strengths, "concerns": concerns,
        "location": {"latitude": ngo.location.latitude, "longitude": ngo.location.longitude},
    }


# --------------------------------------------------------------------- ranking
FUNNEL_STAGES = [
    ("status", "status (closed / unavailable / at capacity)"),
    ("distance", "distance & service area"),
    ("compatibility", "food compatibility"),
    ("capacity", "capacity & demand"),
    ("receiving_hours", "receiving hours"),
    ("rescue_window", "rescue-window feasibility"),
]


def rank_evaluations(evals: list[dict[str, Any]]) -> dict[str, Any]:
    feasible = [e for e in evals if e["feasible"]]
    feasible.sort(key=lambda e: (-e["match_score"], -e["metrics"]["slack_minutes"], e["metrics"]["distance_km"]))
    for i, e in enumerate(feasible, 1):
        e["rank"] = i
    excluded = [e for e in evals if not e["feasible"]]
    remaining = len(evals)
    funnel = []
    for stage, label in FUNNEL_STAGES:
        removed = sum(1 for e in excluded if e["first_failed_stage"] == stage)
        remaining -= removed
        funnel.append({"stage": stage, "label": label, "removed": removed, "remaining": remaining})
    return {"ranked": feasible, "excluded": excluded, "funnel": funnel}


# --------------------------------------------------------------------- split planning
def plan_split(food: FoodContext, quantity: int, ranked: list[dict[str, Any]], ngos: dict[str, NGO],
               cfg: dict[str, Any], now: Optional[datetime] = None,
               observed: Optional[dict[str, dict]] = None) -> dict[str, Any]:
    """Compares SINGLE_NGO vs SPLIT_DONATION by expected meals delivered
    (allocation x P(accept) x P(distribute) x time factor)."""
    now = now or datetime.now(timezone.utc)
    sp = cfg["split"]
    min_alloc = min(cfg["capacity"]["min_allocation_meals"], quantity)
    if not ranked:
        return {"recommended": "NO_MATCH", "single": None, "split": None,
                "explanation": ["No feasible NGO remains for this food."]}
    best = ranked[0]
    single_alloc = min(quantity, best["metrics"]["allocatable_quantity"])
    single_expected = single_alloc * best["metrics"]["p_success"]
    single = {"allocations": [{"ngo_id": best["ngo_id"], "name": best["name"], "quantity": single_alloc,
                               "match_score": best["match_score"]}],
              "coverage": round(single_alloc / quantity, 3), "expected_meals_delivered": round(single_expected, 1)}

    split = None
    if sp["enabled"] and single_alloc < quantity:
        allocs, remaining = [], quantity
        for cand in ranked:
            if remaining <= 0 or len(allocs) >= sp["max_ngos"]:
                break
            ngo = ngos.get(cand["ngo_id"])
            if ngo is None:
                continue
            # re-check feasibility including split overhead for this position in the plan
            ev = evaluate_ngo(ngo, food, remaining, cfg, now, (observed or {}).get(ngo.ngo_id),
                              extra_ngos_in_plan=len(allocs))
            if not ev["feasible"]:
                continue
            q = min(remaining, ev["metrics"]["allocatable_quantity"])
            if q < min_alloc and q != remaining:
                continue
            allocs.append({"ngo_id": ngo.ngo_id, "name": ngo.name, "quantity": q, "match_score": ev["match_score"],
                           "p_success": ev["metrics"]["p_success"], "slack_minutes": ev["metrics"]["slack_minutes"]})
            remaining -= q
        if len(allocs) >= 2:
            exp = sum(a["quantity"] * a["p_success"] for a in allocs)
            placed = sum(a["quantity"] for a in allocs)
            split = {"allocations": allocs, "coverage": round(placed / quantity, 3),
                     "unallocated_quantity": quantity - placed, "expected_meals_delivered": round(exp, 1)}

    explanation = []
    if single_alloc >= quantity:
        recommended = "SINGLE_NGO"
        explanation.append(f"{best['name']} can absorb all {quantity} meals; splitting would add a pickup stop without benefit.")
    elif split and split["expected_meals_delivered"] >= single_expected * (1 + sp["min_expected_gain_ratio"]):
        recommended = "SPLIT_DONATION"
        explanation.append(f"No single NGO can take all {quantity} meals (best: {best['name']} can take {single_alloc}).")
        explanation.append(f"Splitting across {len(split['allocations'])} NGOs places {quantity - split['unallocated_quantity']} meals "
                           f"(expected ~{split['expected_meals_delivered']:.0f} delivered vs ~{single_expected:.0f} with one NGO).")
    else:
        recommended = "SINGLE_NGO"
        explanation.append(f"Best single NGO covers {single_alloc}/{quantity} meals; no split improves expected delivery enough.")
    return {"recommended": recommended, "single": single, "split": split, "explanation": explanation}
