"""Agent tools.

Every number the agent reasons over (capacity, distance, ETA, demand, hours,
scores, acceptance) is produced HERE from the database + deterministic engine.
The LLM only chooses which tool to call and with which arguments; tools
re-validate those arguments (e.g. an infeasible NGO can never be sent a
confirmation request, a match can never be declared without a recorded
ACCEPTED confirmation).
"""
from __future__ import annotations

import json
import traceback
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Optional

from ..db import DatabaseError, Repository
from ..engine.checks import check_capacity, check_food_compatibility, check_receiving_hours
from ..engine.geo import estimate_delivery_plan, haversine_km
from ..engine.passport import validate_food_passport
from ..engine.scoring import FACTOR_LABELS, evaluate_ngo, merged_category_memory, plan_split, rank_evaluations
from ..models import CandidateStatus, MatchStatus, NGO, NGOStatus
from .confirmation import ConfirmationChannel
from .result import build_result, compute_outcome
from .state import AgentState


class ToolError(Exception):
    """Recoverable: returned to the policy as an error result."""


@dataclass
class ToolContext:
    state: AgentState
    repo: Repository
    cfg: dict[str, Any]
    channel: ConfirmationChannel
    emit: Callable[[str, str, Optional[dict]], None]
    now: Callable[[], datetime] = field(default=lambda: datetime.now(timezone.utc))
    should_stop: Callable[[], bool] = field(default=lambda: False)


# =========================================================================== schemas
def _obj(props: dict, required: list[str] | None = None) -> dict:
    return {"type": "object", "properties": props, "required": required or []}


NGO_ID = {"type": "string", "description": "NGO identifier, e.g. NGO-0042"}
QTY = {"type": "integer", "description": "Meals to allocate. Defaults to the still-unplaced quantity.", "minimum": 1}

TOOL_SPECS: list[dict[str, Any]] = [
    {"name": "get_food_passport", "description": "Load the incoming Food Passport (as produced by the Food Agent).",
     "parameters": _obj({})},
    {"name": "validate_food_passport",
     "description": "Validate the passport for matching: critical fields, ELIGIBLE decision, rescue deadline. "
                    "Returns missing fields instead of guessing them.", "parameters": _obj({})},
    {"name": "find_candidate_ngos",
     "description": "Search the NGO database for NGOs within a radius of the restaurant. Returns id, name, status, distance.",
     "parameters": _obj({"radius_km": {"type": "number", "description": "Search radius; default from config."}})},
    {"name": "get_ngo_details", "description": "Full profile + live operational status of one NGO.",
     "parameters": _obj({"ngo_id": NGO_ID}, ["ngo_id"])},
    {"name": "get_ngo_current_demand", "description": "Latest recorded demand (meals needed, urgency) for one NGO.",
     "parameters": _obj({"ngo_id": NGO_ID}, ["ngo_id"])},
    {"name": "check_ngo_capacity", "description": "How many meals the NGO can realistically absorb right now.",
     "parameters": _obj({"ngo_id": NGO_ID, "quantity": QTY}, ["ngo_id"])},
    {"name": "check_receiving_hours", "description": "Whether the NGO is receiving at the estimated arrival time.",
     "parameters": _obj({"ngo_id": NGO_ID}, ["ngo_id"])},
    {"name": "check_food_compatibility", "description": "Category, dietary and allergen compatibility (+ memory of past rejections).",
     "parameters": _obj({"ngo_id": NGO_ID}, ["ngo_id"])},
    {"name": "calculate_distance", "description": "Great-circle and estimated road distance restaurant -> NGO.",
     "parameters": _obj({"ngo_id": NGO_ID}, ["ngo_id"])},
    {"name": "estimate_delivery_time",
     "description": "Estimated pickup+travel+handover minutes and whether it fits the remaining rescue window.",
     "parameters": _obj({"ngo_id": NGO_ID}, ["ngo_id"])},
    {"name": "get_ngo_history", "description": "Memory: historical acceptance, distribution, confirmation time, category rejections.",
     "parameters": _obj({"ngo_id": NGO_ID}, ["ngo_id"])},
    {"name": "calculate_match_score", "description": "Explainable weighted match score for one NGO with per-factor breakdown.",
     "parameters": _obj({"ngo_id": NGO_ID, "quantity": QTY}, ["ngo_id"])},
    {"name": "rank_ngos",
     "description": "Run all deterministic filters (status, distance, compatibility, capacity, hours, rescue window) and "
                    "scoring on the candidate pool; returns ranked feasible NGOs, exclusions with reasons, and the filter funnel.",
     "parameters": _obj({"quantity": QTY})},
    {"name": "evaluate_split_options",
     "description": "Compare SINGLE_NGO vs SPLIT_DONATION by expected meals delivered for the unplaced quantity.",
     "parameters": _obj({"quantity": QTY})},
    {"name": "create_match",
     "description": "Record your decision (proposed allocation) with a short human explanation, before requesting confirmations. "
                    "Allocations are re-validated deterministically.",
     "parameters": _obj({
         "strategy": {"type": "string", "enum": ["SINGLE_NGO", "SPLIT_DONATION"]},
         "allocations": {"type": "array", "items": _obj({"ngo_id": NGO_ID, "quantity": {"type": "integer", "minimum": 1}},
                                                          ["ngo_id", "quantity"])},
         "reasoning": {"type": "array", "items": {"type": "string"},
                       "description": "3-6 short plain-English reasons, grounded only in tool outputs."}},
         ["strategy", "allocations", "reasoning"])},
    {"name": "request_ngo_confirmation",
     "description": "Ask an NGO to confirm it will receive the allocation, then wait for its answer "
                    "(ACCEPTED / REJECTED / NO_RESPONSE after timeout / UNAVAILABLE).",
     "parameters": _obj({"ngo_id": NGO_ID, "quantity": QTY,
                         "reason": {"type": "string", "description": "One sentence: why this NGO now."}}, ["ngo_id"])},
    {"name": "update_ngo_status",
     "description": "Mark an NGO's status within THIS match (e.g. EXCLUDED after you judge it unsuitable). "
                    "Cannot change an NGO's real operational status.",
     "parameters": _obj({"ngo_id": NGO_ID,
                         "status": {"type": "string", "enum": ["EXCLUDED", "REJECTED", "UNAVAILABLE", "NO_RESPONSE"]},
                         "reason": {"type": "string"}}, ["ngo_id", "status", "reason"])},
    {"name": "replan_match",
     "description": "After a rejection / no-response / unavailability: drop failed NGOs, refresh live NGO data, "
                    "recompute the remaining rescue window and re-rank candidates for the unplaced quantity.",
     "parameters": _obj({"reason": {"type": "string"}}, ["reason"])},
    {"name": "finalize_match",
     "description": "Finish the run and return the Match Result to the Luna Orchestrator. The outcome (MATCHED, "
                    "PARTIALLY_MATCHED, NO_FEASIBLE_MATCH, NEEDS_INFORMATION ...) is computed from recorded confirmations.",
     "parameters": _obj({"reasoning": {"type": "array", "items": {"type": "string"},
                                       "description": "Plain-English explanation of the final outcome."},
                         "force_reason": {"type": "string",
                                          "description": "Only if finalizing although feasible candidates remain."}},
                        ["reasoning"])},
]
TOOL_NAMES = [t["name"] for t in TOOL_SPECS]


# =========================================================================== helpers
def _require_food(ctx: ToolContext):
    if ctx.state.food is None:
        raise ToolError("Food Passport has not been validated successfully yet. Call validate_food_passport first.")
    return ctx.state.food


def _ngo(ctx: ToolContext, ngo_id: str) -> NGO:
    if not ngo_id:
        raise ToolError("ngo_id is required")
    try:
        ngo = ctx.repo.get_ngo(ngo_id)
    except DatabaseError:
        raise
    except Exception as e:  # invalid stored record
        raise ToolError(f"NGO {ngo_id} has invalid data and cannot be used: {e}")
    if ngo is None:
        raise ToolError(f"Unknown NGO '{ngo_id}'. Only use ngo_ids returned by find_candidate_ngos / rank_ngos.")
    return ngo


def _qty(ctx: ToolContext, args: dict) -> int:
    q = args.get("quantity")
    default = ctx.state.unplaced_quantity or ctx.state.total_quantity
    if q is None:
        return default
    try:
        q = int(q)
    except (TypeError, ValueError):
        raise ToolError("quantity must be an integer")
    if q < 1:
        raise ToolError("quantity must be >= 1")
    return q


def _evaluate(ctx: ToolContext, ngo: NGO, quantity: int, extra: int = 0) -> dict:
    food = _require_food(ctx)
    hist = ctx.repo.confirmation_history(ngo.ngo_id)
    ev = evaluate_ngo(ngo, food, quantity, ctx.cfg, ctx.now(), hist, extra_ngos_in_plan=extra)
    if ngo.ngo_id in ctx.state.excluded:
        ev["feasible"] = False
        ev["match_score"] = 0.0
        ev["exclusion_reasons"] = [f"Already tried in this match: {ctx.state.excluded[ngo.ngo_id]}"] + ev["exclusion_reasons"]
        ev["first_failed_stage"] = ev["first_failed_stage"] or "match_history"
    return ev


def _compact(ev: dict) -> dict:
    m = ev["metrics"]
    return {
        "ngo_id": ev["ngo_id"], "name": ev["name"], "rank": ev.get("rank"), "match_score": ev["match_score"],
        "factors": ev["factors"],
        "allocatable_quantity": m["allocatable_quantity"], "meals_needed": m["meals_needed"],
        "available_capacity": m["available_capacity"], "demand_urgency": m["demand_urgency"],
        "distance_km": m["distance_km"], "travel_minutes": m["travel_minutes"],
        "total_plan_minutes": m["total_plan_minutes"], "slack_minutes": m["slack_minutes"],
        "acceptance_rate": ev["reliability"]["acceptance_rate"],
        "history_insufficient": ev["reliability"]["insufficient_history"],
        "p_success": m["p_success"], "strengths": ev["strengths"], "concerns": ev["concerns"],
    }


def _persist(ctx: ToolContext) -> None:
    s = ctx.state
    ctx.repo.update_match(s.match_id, status=s.status.value, state=s.snapshot(),
                          result=build_result(s, final=False), reasoning_source=s.brain,
                          strategy=(s.proposal or {}).get("strategy"))


def _set_status(ctx: ToolContext, st: MatchStatus) -> None:
    ctx.state.status = st


def _s(score: float) -> int:
    """Display rounding (half-up) - identical to the dashboard's Math.round."""
    return int(float(score) + 0.5)


def _name(ctx: ToolContext, ngo_id: str) -> str:
    ev = ctx.state.evaluations.get(ngo_id)
    if ev:
        return ev["name"]
    try:
        n = ctx.repo.get_ngo(ngo_id)
        return n.name if n else ngo_id
    except Exception:
        return ngo_id


# =========================================================================== implementations
def t_get_food_passport(ctx: ToolContext, args: dict) -> dict:
    ctx.state.passport_loaded = True
    raw = ctx.state.raw_passport
    ctx.emit("step", f"Reading Food Passport {raw.get('passport_id') or '(no id)'}.", {"passport_id": raw.get("passport_id")})
    keys = ["passport_id", "food_name", "food_category", "quantity", "prepared_at", "storage_method", "ingredients",
            "allergens", "dietary_tags", "eligibility", "rescue_window", "restaurant_location", "restaurant_id"]
    return {"passport": {k: raw.get(k) for k in keys if k in raw},
            "note": "Food safety is owned by the Food Agent; do not re-evaluate it."}


def t_validate_food_passport(ctx: ToolContext, args: dict) -> dict:
    s = ctx.state
    _set_status(ctx, MatchStatus.VALIDATING)
    ctx.emit("step", "Validating Food Passport.", None)
    v = validate_food_passport(s.raw_passport, s.received_at)
    s.validation = v
    s.food = v["food"]
    if v["valid"]:
        f = s.food
        ctx.emit("step", f"Passport valid: {f.quantity} {f.unit} of {f.food_name} ({f.category.replace('_', ' ')}), "
                         f"{f.remaining_minutes(ctx.now()):.0f} min left in rescue window.", None)
        for w in v["warnings"]:
            ctx.emit("warning", w, None)
    else:
        if v["missing_fields"]:
            ctx.emit("warning", "Passport is missing information needed for matching: " + ", ".join(v["missing_fields"]) + ".", None)
        for e in v["errors"]:
            ctx.emit("warning", e, None)
    _persist(ctx)
    return {"valid": v["valid"], "missing_fields": v["missing_fields"], "errors": v["errors"],
            "warnings": v["warnings"], "food": s.food.summary(ctx.now()) if s.food else None,
            "next_step_hint": None if v["valid"] else
            "Do not guess missing data. Call finalize_match so the Orchestrator can request it from the Food Agent."}


def t_find_candidate_ngos(ctx: ToolContext, args: dict) -> dict:
    food = _require_food(ctx)
    s = ctx.state
    _set_status(ctx, MatchStatus.SEARCHING)
    radius = float(args.get("radius_km") or ctx.cfg["candidate_search"]["search_radius_km"])
    ctx.emit("step", "Searching active NGOs.", None)
    ngos, invalid = ctx.repo.list_ngos()
    s.invalid_ngo_records = invalid
    for bad in invalid:
        ctx.emit("warning", f"Skipped NGO record {bad['ngo_id']}: invalid data ({bad['error']}).", None)
    found = []
    for n in ngos:
        d = haversine_km(food.latitude, food.longitude, n.location.latitude, n.location.longitude)
        if d <= radius:
            found.append({"ngo_id": n.ngo_id, "name": n.name, "status": n.status.value, "distance_km": round(d, 2),
                          "already_tried_in_this_match": n.ngo_id in s.excluded})
    found.sort(key=lambda x: x["distance_km"])
    s.candidate_pool = [f["ngo_id"] for f in found]
    s.ranking_stale = True
    active = sum(1 for f in found if f["status"] == "ACTIVE")
    ctx.emit("step", f"Found {len(found)} candidate NGOs within {radius:g} km ({active} currently active).",
             {"count": len(found)})
    _persist(ctx)
    return {"radius_km": radius, "count": len(found), "candidates": found,
            "invalid_records_skipped": len(invalid)}


def t_get_ngo_details(ctx: ToolContext, args: dict) -> dict:
    ngo = _ngo(ctx, args.get("ngo_id"))
    d = ngo.model_dump(mode="json")
    d.pop("contact", None)
    d["match_status"] = ctx.state.candidate_status.get(ngo.ngo_id)
    return d


def t_get_ngo_current_demand(ctx: ToolContext, args: dict) -> dict:
    ngo = _ngo(ctx, args.get("ngo_id"))
    latest = ctx.repo.latest_demand(ngo.ngo_id)
    return {"ngo_id": ngo.ngo_id, "meals_needed": ngo.current_demand.meals_needed,
            "urgency": ngo.current_demand.urgency, "population_served": ngo.population_served,
            "last_recorded": latest}


def t_check_ngo_capacity(ctx: ToolContext, args: dict) -> dict:
    ngo = _ngo(ctx, args.get("ngo_id"))
    q = _qty(ctx, args)
    c = check_capacity(ngo, q, ctx.cfg)
    return {"ngo_id": ngo.ngo_id, "quantity": q, **c}


def t_check_receiving_hours(ctx: ToolContext, args: dict) -> dict:
    food = _require_food(ctx)
    ngo = _ngo(ctx, args.get("ngo_id"))
    d = haversine_km(food.latitude, food.longitude, ngo.location.latitude, ngo.location.longitude)
    plan = estimate_delivery_plan(d, ctx.cfg)
    arrival = ctx.now() + timedelta(minutes=plan["minutes_to_arrival"])
    latest = food.deadline - timedelta(minutes=ctx.cfg["logistics_estimates"]["safety_margin_minutes"])
    h = check_receiving_hours(ngo, arrival, plan["handover_minutes"], ctx.cfg, latest_completion=latest)
    h.pop("handover_complete_at", None)
    return {"ngo_id": ngo.ngo_id, "receiving_hours": ngo.receiving_hours.model_dump(),
            "estimated_arrival": arrival.isoformat(), **h}


def t_check_food_compatibility(ctx: ToolContext, args: dict) -> dict:
    food = _require_food(ctx)
    ngo = _ngo(ctx, args.get("ngo_id"))
    hist = ctx.repo.confirmation_history(ngo.ngo_id)
    c = check_food_compatibility(ngo, food, merged_category_memory(ngo, hist), ctx.cfg)
    return {"ngo_id": ngo.ngo_id, **c}


def t_calculate_distance(ctx: ToolContext, args: dict) -> dict:
    food = _require_food(ctx)
    ngo = _ngo(ctx, args.get("ngo_id"))
    d = haversine_km(food.latitude, food.longitude, ngo.location.latitude, ngo.location.longitude)
    return {"ngo_id": ngo.ngo_id, "distance_km": round(d, 2),
            "road_distance_km_estimate": round(d * ctx.cfg["logistics_estimates"]["road_distance_factor"], 2),
            "within_service_area": d <= ngo.service_area_km * ctx.cfg["candidate_search"]["service_area_tolerance_factor"]}


def t_estimate_delivery_time(ctx: ToolContext, args: dict) -> dict:
    food = _require_food(ctx)
    ngo = _ngo(ctx, args.get("ngo_id"))
    d = haversine_km(food.latitude, food.longitude, ngo.location.latitude, ngo.location.longitude)
    plan = estimate_delivery_plan(d, ctx.cfg)
    remaining = food.remaining_minutes(ctx.now())
    margin = ctx.cfg["logistics_estimates"]["safety_margin_minutes"]
    return {"ngo_id": ngo.ngo_id, **plan, "remaining_rescue_minutes": round(remaining, 1),
            "safety_margin_minutes": margin,
            "fits_rescue_window": plan["total_plan_minutes"] + margin <= remaining}


def t_get_ngo_history(ctx: ToolContext, args: dict) -> dict:
    ngo = _ngo(ctx, args.get("ngo_id"))
    from ..engine.scoring import compute_reliability
    hist = ctx.repo.confirmation_history(ngo.ngo_id)
    rel = compute_reliability(ngo, hist, ctx.cfg)
    return {"ngo_id": ngo.ngo_id, "reliability": rel, "observed_by_luna": hist,
            "baseline": ngo.reliability.model_dump(), "typical_daily_distribution":
                [ngo.history.typical_daily_distribution_min, ngo.history.typical_daily_distribution_max],
            "category_memory": merged_category_memory(ngo, hist),
            "rule": "History influences ranking only. Current status always overrides history."}


def t_calculate_match_score(ctx: ToolContext, args: dict) -> dict:
    ngo = _ngo(ctx, args.get("ngo_id"))
    q = _qty(ctx, args)
    ev = _evaluate(ctx, ngo, q)
    ctx.state.evaluations[ngo.ngo_id] = ev
    return {"ngo_id": ngo.ngo_id, "quantity": q, "match_score": ev["match_score"], "feasible": ev["feasible"],
            "exclusion_reasons": ev["exclusion_reasons"], "factors": ev["factors"],
            "weighted_contributions": ev["contributions"], "weights": ctx.cfg["match_score_weights"],
            "metrics": ev["metrics"], "strengths": ev["strengths"], "concerns": ev["concerns"]}


def _rank(ctx: ToolContext, quantity: int, announce: bool = True) -> dict:
    s = ctx.state
    if s.candidate_pool is None:
        raise ToolError("No candidate pool yet. Call find_candidate_ngos first.")
    _set_status(ctx, MatchStatus.EVALUATING)
    evals = []
    for ngo_id in s.candidate_pool:
        try:
            ngo = ctx.repo.get_ngo(ngo_id)
        except DatabaseError:
            raise
        except Exception:
            continue
        if ngo is None:
            continue
        ev = _evaluate(ctx, ngo, quantity)
        s.evaluations[ngo_id] = ev
        evals.append(ev)
    r = rank_evaluations(evals)
    if announce:
        prev = len(evals)
        for st in r["funnel"]:
            if st["removed"]:
                ctx.emit("step", f"Filtering by {st['label']}: {st['remaining']} NGOs remain.", None)
            prev = st["remaining"]
        ctx.emit("step", f"Ranking {len(r['ranked'])} feasible candidates by explainable match score.", None)
        top = r["ranked"][:3]
        if top:
            ctx.emit("step", "Top candidates: " + ", ".join(f"{e['name']} ({_s(e['match_score'])})" for e in top) + ".", None)
        else:
            ctx.emit("warning", "No NGO passes all feasibility checks.", None)
    s.ranking = {"quantity": quantity, "ranked": [_compact(e) for e in r["ranked"]],
                 "excluded": [{"ngo_id": e["ngo_id"], "name": e["name"], "reasons": e["exclusion_reasons"],
                               "backup_only": e["backup_only"]} for e in r["excluded"]],
                 "funnel": r["funnel"]}
    s.ranking_stale = False
    s.split_options = None
    _persist(ctx)
    return s.ranking


def t_rank_ngos(ctx: ToolContext, args: dict) -> dict:
    _require_food(ctx)
    q = _qty(ctx, args)
    r = _rank(ctx, q)
    best = r["ranked"][0] if r["ranked"] else None
    out = {"quantity": q, "remaining_rescue_minutes": round(ctx.state.food.remaining_minutes(ctx.now()), 1),
           "ranked": r["ranked"][: ctx.cfg["candidate_search"]["max_candidates_returned"]],
           "excluded": r["excluded"], "funnel": r["funnel"], "weights": ctx.cfg["match_score_weights"]}
    if best and best["allocatable_quantity"] < q:
        out["note"] = (f"Best candidate can absorb only {best['allocatable_quantity']} of {q} meals. "
                       "Consider evaluate_split_options.")
    return out


def t_evaluate_split_options(ctx: ToolContext, args: dict) -> dict:
    food = _require_food(ctx)
    s = ctx.state
    q = _qty(ctx, args)
    if s.ranking is None or s.ranking_stale or s.ranking.get("quantity") != q:
        _rank(ctx, q, announce=False)
    ranked_full = [s.evaluations[r["ngo_id"]] for r in s.ranking["ranked"]]
    ngos = {}
    for r in ranked_full:
        n = ctx.repo.get_ngo(r["ngo_id"])
        if n:
            ngos[n.ngo_id] = n
    observed = {nid: ctx.repo.confirmation_history(nid) for nid in ngos}
    plan = plan_split(food, q, ranked_full, ngos, ctx.cfg, ctx.now(), observed)
    s.split_options = plan
    ctx.emit("step", "Evaluating whether splitting the donation improves the rescue: " + plan["explanation"][-1], None)
    _persist(ctx)
    return plan


def t_create_match(ctx: ToolContext, args: dict) -> dict:
    food = _require_food(ctx)
    s = ctx.state
    strategy = args.get("strategy")
    allocs = args.get("allocations") or []
    reasoning = [str(r) for r in (args.get("reasoning") or [])][:8]
    if strategy not in ("SINGLE_NGO", "SPLIT_DONATION"):
        raise ToolError("strategy must be SINGLE_NGO or SPLIT_DONATION")
    if not allocs:
        raise ToolError("allocations must contain at least one NGO")
    if strategy == "SINGLE_NGO" and len(allocs) != 1:
        raise ToolError("SINGLE_NGO requires exactly one allocation")
    if strategy == "SPLIT_DONATION" and len(allocs) < 2:
        raise ToolError("SPLIT_DONATION requires at least two allocations")
    if s.pending_quantity:
        raise ToolError("Confirmations are still pending; wait for them before proposing a new plan.")
    total = 0
    checked = []
    ids = set()
    for i, a in enumerate(allocs):
        nid, q = a.get("ngo_id"), int(a.get("quantity") or 0)
        if nid in ids:
            raise ToolError(f"{nid} appears twice in allocations")
        ids.add(nid)
        ngo = _ngo(ctx, nid)
        ev = _evaluate(ctx, ngo, q, extra=i)
        s.evaluations[nid] = ev
        if not ev["feasible"]:
            raise ToolError(f"{ngo.name} is not feasible for {q} meals: {'; '.join(ev['exclusion_reasons'])}")
        if q > ev["metrics"]["allocatable_quantity"]:
            raise ToolError(f"{ngo.name} can absorb at most {ev['metrics']['allocatable_quantity']} meals, not {q}.")
        total += q
        checked.append({"ngo_id": nid, "name": ngo.name, "quantity": q, "match_score": ev["match_score"],
                        "status": "PROPOSED", "receiving_hours": ngo.receiving_hours.model_dump()})
    if total > s.unplaced_quantity:
        raise ToolError(f"Allocations total {total} but only {s.unplaced_quantity} meals are unplaced.")
    kept = [a for a in (s.proposal or {}).get("allocations", []) if a["status"] == "ACCEPTED"]
    s.proposal = {"strategy": "SPLIT_DONATION" if len(kept) + len(checked) > 1 else strategy,
                  "allocations": kept + checked, "reasoning": reasoning, "created_at": ctx.now().isoformat()}
    s.decision_reasoning = reasoning
    for a in checked:
        s.set_candidate_status(a["ngo_id"], CandidateStatus.CANDIDATE)
    if strategy == "SINGLE_NGO":
        a = checked[0]
        ctx.emit("decision", f"{a['name']} selected as best candidate (match score {_s(a['match_score'])}) for {a['quantity']} meals.",
                 {"allocations": checked})
    else:
        ctx.emit("decision", "Split donation planned: " + ", ".join(f"{a['quantity']} → {a['name']}" for a in checked) + ".",
                 {"allocations": checked})
    _persist(ctx)
    return {"proposal": s.proposal, "unplaced_after_plan": s.unplaced_quantity - total,
            "next_step_hint": "Call request_ngo_confirmation for each proposed allocation."}


def t_request_ngo_confirmation(ctx: ToolContext, args: dict) -> dict:
    food = _require_food(ctx)
    s = ctx.state
    ngo = _ngo(ctx, args.get("ngo_id"))
    nid = ngo.ngo_id
    cst = s.candidate_status.get(nid)
    if nid in s.excluded:
        raise ToolError(f"{ngo.name} was already excluded in this match ({s.excluded[nid]}). Choose another NGO.")
    if cst in ("AWAITING_CONFIRMATION", "ACCEPTED"):
        raise ToolError(f"{ngo.name} is already {cst}.")
    prop_alloc = next((a for a in (s.proposal or {}).get("allocations", [])
                       if a["ngo_id"] == nid and a["status"] == "PROPOSED"), None)
    q = int(args["quantity"]) if args.get("quantity") else (prop_alloc["quantity"] if prop_alloc else s.unplaced_quantity)
    if q < 1:
        raise ToolError("Nothing left to place.")
    available_to_place = s.unplaced_quantity  # total - accepted - awaiting
    if q > available_to_place:
        raise ToolError(f"Only {available_to_place} meals are still unplaced.")
    remaining = food.remaining_minutes(ctx.now())
    if remaining <= 0:
        raise ToolError("The rescue window has expired; finalize the match.")
    # deterministic gate: live re-check right before contacting the NGO
    position = sum(1 for a in (s.proposal or {}).get("allocations", []) if a["status"] in ("ACCEPTED", "AWAITING_CONFIRMATION"))
    ev = _evaluate(ctx, ngo, q, extra=position)
    s.evaluations[nid] = ev
    if not ev["feasible"]:
        raise ToolError(f"Cannot request {ngo.name}: {'; '.join(ev['exclusion_reasons'])}. "
                        "Re-rank or choose another candidate.")
    if q > ev["metrics"]["allocatable_quantity"]:
        raise ToolError(f"{ngo.name} can absorb at most {ev['metrics']['allocatable_quantity']} meals right now.")

    # register in proposal
    if s.proposal is None:
        s.proposal = {"strategy": "SINGLE_NGO", "allocations": [], "reasoning": [args.get("reason") or ""],
                      "created_at": ctx.now().isoformat()}
        if args.get("reason"):
            s.decision_reasoning = [args["reason"]]
    if prop_alloc is None:
        prop_alloc = {"ngo_id": nid, "name": ngo.name, "quantity": q, "match_score": ev["match_score"],
                      "status": "PROPOSED", "receiving_hours": ngo.receiving_hours.model_dump()}
        s.proposal["allocations"].append(prop_alloc)
        if len([a for a in s.proposal["allocations"] if a["status"] in ("PROPOSED", "AWAITING_CONFIRMATION", "ACCEPTED")]) > 1:
            s.proposal["strategy"] = "SPLIT_DONATION"
        ctx.emit("decision", f"{ngo.name} selected (match score {_s(ev['match_score'])}) for {q} meals.", None)
    prop_alloc["quantity"] = q
    prop_alloc["status"] = "AWAITING_CONFIRMATION"
    s.set_candidate_status(nid, CandidateStatus.AWAITING_CONFIRMATION)
    _set_status(ctx, MatchStatus.AWAITING_CONFIRMATION)
    attempt_id = ctx.repo.add_attempt(s.match_id, nid, q, ev["match_score"])
    attempt = {"attempt_no": len(s.attempts) + 1, "ngo_id": nid, "name": ngo.name, "quantity": q,
               "match_score": ev["match_score"], "outcome": "AWAITING_CONFIRMATION", "reason": None,
               "requested_at": ctx.now().isoformat()}
    s.attempts.append(attempt)
    is_live = ctx.channel.source != "SIMULATED"
    timeout = ctx.cfg["confirmation"]["live_timeout_seconds" if is_live else "demo_timeout_seconds"]
    cid = ctx.channel.send(s.match_id, ngo, q, food.summary(ctx.now()))
    prop_alloc["confirmation_id"] = cid
    ctx.emit("confirmation", f"Requesting confirmation from {ngo.name} for {q} meals via {ctx.channel.label}"
                             f" (timeout {timeout:g}s).", {"ngo_id": nid, "confirmation_id": cid})
    _persist(ctx)

    resp = ctx.channel.wait_for_response(cid, nid, timeout, ctx.cfg["confirmation"]["poll_interval_seconds"],
                                         ctx.should_stop)
    outcome, reason = resp["response"], resp.get("reason")
    ctx.repo.resolve_attempt(attempt_id, outcome, reason)
    attempt.update(outcome=outcome, reason=reason, responded_after_seconds=resp["waited_seconds"],
                   response_source=resp["source"])
    prop_alloc["status"] = outcome
    remaining = food.remaining_minutes(ctx.now())
    if outcome == "ACCEPTED":
        s.set_candidate_status(nid, CandidateStatus.ACCEPTED)
        # delivery OTP for the NGO + when the food reaches them (pickup prep + travel + handover)
        handoff = ctx.repo.ensure_handoff(cid, ev["metrics"]["total_plan_minutes"]) or {}
        s.accepted.append({k: prop_alloc.get(k) for k in ("ngo_id", "name", "quantity", "match_score",
                                                           "receiving_hours", "confirmation_id")}
                          | {"status": "ACCEPTED", "eta_at": handoff.get("eta_at"),
                             "delivery_notes": handoff.get("delivery_notes")})
        ctx.repo.reserve_capacity(nid, q)
        if s.unplaced_quantity > 0 and not any(a["status"] == "PROPOSED" for a in s.proposal["allocations"]):
            s.ranking_stale = True  # remaining meals need a fresh ranking
        ctx.emit("confirmation", f"✅ {ngo.name} ACCEPTED {q} meals.", {"ngo_id": nid})
        hint = ("All food is placed. Call finalize_match." if s.unplaced_quantity == 0 and s.pending_quantity == 0
                else "Continue with remaining allocations or replan for the unplaced quantity.")
    else:
        status_map = {"REJECTED": CandidateStatus.REJECTED, "NO_RESPONSE": CandidateStatus.NO_RESPONSE,
                      "UNAVAILABLE": CandidateStatus.UNAVAILABLE}
        s.set_candidate_status(nid, status_map.get(outcome, CandidateStatus.REJECTED))
        s.excluded[nid] = f"{outcome.replace('_', ' ').lower()}" + (f" ({reason})" if reason else "")
        s.needs_replan = True
        s.ranking_stale = True
        icon = {"REJECTED": "❌", "NO_RESPONSE": "⏱️", "UNAVAILABLE": "⚠️"}.get(outcome, "❌")
        verb = {"REJECTED": "REJECTED the donation", "NO_RESPONSE": "did not respond in time",
                "UNAVAILABLE": "is now UNAVAILABLE"}.get(outcome, outcome)
        ctx.emit("confirmation", f"{icon} {ngo.name} {verb}" + (f" — {reason}" if reason and outcome == "REJECTED" else "") + ".",
                 {"ngo_id": nid, "outcome": outcome})
        hint = "Call replan_match to re-rank the remaining candidates for the unplaced meals."
    _set_status(ctx, MatchStatus.AWAITING_CONFIRMATION if s.pending_quantity else MatchStatus.EVALUATING)
    _persist(ctx)
    return {"ngo_id": nid, "response": outcome, "reason": reason, "confirmation_id": cid,
            "accepted_quantity_total": s.accepted_quantity, "unplaced_quantity": s.unplaced_quantity,
            "remaining_rescue_minutes": round(remaining, 1), "next_step_hint": hint}


def t_update_ngo_status(ctx: ToolContext, args: dict) -> dict:
    s = ctx.state
    ngo = _ngo(ctx, args.get("ngo_id"))
    st = args.get("status")
    reason = args.get("reason") or "agent decision"
    if st not in ("EXCLUDED", "REJECTED", "UNAVAILABLE", "NO_RESPONSE"):
        raise ToolError("status must be one of EXCLUDED, REJECTED, UNAVAILABLE, NO_RESPONSE")
    if s.candidate_status.get(ngo.ngo_id) in ("ACCEPTED", "AWAITING_CONFIRMATION"):
        raise ToolError(f"{ngo.name} is {s.candidate_status[ngo.ngo_id]}; its status is driven by its confirmation.")
    s.candidate_status[ngo.ngo_id] = st
    s.excluded[ngo.ngo_id] = reason
    s.ranking_stale = True
    ctx.emit("step", f"{ngo.name} removed from this match's candidates: {reason}.", None)
    _persist(ctx)
    return {"ngo_id": ngo.ngo_id, "match_status": st, "note": "NGO operational status unchanged (owned by the NGO)."}


def t_replan_match(ctx: ToolContext, args: dict) -> dict:
    food = _require_food(ctx)
    s = ctx.state
    if s.pending_quantity:
        raise ToolError("Confirmations still pending; replan after they resolve.")
    _set_status(ctx, MatchStatus.REPLANNING)
    s.replans += 1
    s.needs_replan = False
    failed = [nid for nid, st in s.candidate_status.items() if st in ("REJECTED", "NO_RESPONSE", "UNAVAILABLE", "EXCLUDED")]
    if s.proposal:
        s.proposal["allocations"] = [a for a in s.proposal["allocations"] if a["status"] in ("ACCEPTED",)]
    remaining = food.remaining_minutes(ctx.now())
    ctx.emit("replan", f"Re-planning ({args.get('reason') or 'previous attempt failed'}). "
                       f"Removing {len(failed)} failed NGO(s); {s.unplaced_quantity} meals to place, "
                       f"{remaining:.0f} min left.", {"failed": failed})
    if remaining <= 0:
        _persist(ctx)
        return {"feasible_candidates": 0, "remaining_rescue_minutes": round(remaining, 1),
                "next_step_hint": "Rescue window expired. Call finalize_match."}
    # refresh pool (NGOs may have come online / gone offline)
    ngos, invalid = ctx.repo.list_ngos()
    radius = ctx.cfg["candidate_search"]["search_radius_km"]
    s.candidate_pool = [n.ngo_id for n in ngos
                        if haversine_km(food.latitude, food.longitude, n.location.latitude, n.location.longitude) <= radius]
    q = s.unplaced_quantity
    if q <= 0:
        _persist(ctx)
        return {"unplaced_quantity": 0, "next_step_hint": "Nothing left to place. Call finalize_match."}
    r = _rank(ctx, q)
    out = {"unplaced_quantity": q, "remaining_rescue_minutes": round(remaining, 1),
           "removed_ngos": [{"ngo_id": nid, "name": _name(ctx, nid), "why": s.excluded.get(nid)} for nid in failed],
           "ranked": r["ranked"][:8], "excluded_count": len(r["excluded"]), "funnel": r["funnel"]}
    if r["ranked"]:
        best = r["ranked"][0]
        ctx.emit("replan", f"New best candidate: {best['name']} (score {_s(best['match_score'])}, "
                           f"~{best['travel_minutes']:.0f} min away).", None)
        if best["allocatable_quantity"] < q:
            out["note"] = "Best remaining NGO cannot take everything; consider evaluate_split_options."
        out["next_step_hint"] = "Choose the next NGO (create_match) and request confirmation."
    else:
        ctx.emit("warning", "No feasible NGO remains after re-planning.", None)
        out["next_step_hint"] = "No feasible candidate remains. Call finalize_match with an explanation."
    return out


def t_finalize_match(ctx: ToolContext, args: dict) -> dict:
    s = ctx.state
    if s.pending_quantity:
        raise ToolError("Confirmations are still pending; cannot finalize yet.")
    outcome = compute_outcome(s, ctx.now())
    reasoning = [str(r) for r in (args.get("reasoning") or [])][:10]
    if outcome in (MatchStatus.NO_FEASIBLE_MATCH, MatchStatus.PARTIALLY_MATCHED) and s.food and \
            s.food.remaining_minutes(ctx.now()) > 0 and not args.get("force_reason") and s.finalize_warnings < 1:
        if s.candidate_pool is None or s.ranking is None:
            s.finalize_warnings += 1
            raise ToolError("No food has been placed and candidates have not been evaluated yet. Call "
                            "find_candidate_ngos / rank_ngos first (or pass force_reason).")
        if s.needs_replan:
            s.finalize_warnings += 1
            raise ToolError("A confirmation failed and candidates have not been re-ranked. Call replan_match first "
                            "(or pass force_reason).")
        if s.ranking_stale:
            s.finalize_warnings += 1
            raise ToolError("Meals remain unplaced and the ranking is out of date. Call rank_ngos first "
                            "(or pass force_reason).")
        untried = s.untried_feasible()
        if untried:
            s.finalize_warnings += 1
            raise ToolError(f"{s.unplaced_quantity} meals unplaced but feasible candidates remain untried: "
                            + ", ".join(f"{u['name']} ({u['ngo_id']})" for u in untried[:4])
                            + ". Request confirmation, or call finalize_match with force_reason.")
    if reasoning:
        s.decision_reasoning = (s.decision_reasoning if outcome == MatchStatus.MATCHED and s.decision_reasoning else []) + \
            [r for r in reasoning if r not in s.decision_reasoning]
    s.status = outcome
    s.finalized = True
    s.result = build_result(s, final=True, now=ctx.now())
    label = {"MATCHED": "✅ MATCH COMPLETE", "PARTIALLY_MATCHED": "🟡 PARTIAL MATCH",
             "NO_FEASIBLE_MATCH": "⛔ NO FEASIBLE MATCH", "NEEDS_INFORMATION": "❓ NEEDS INFORMATION",
             "WINDOW_EXPIRED": "⌛ RESCUE WINDOW EXPIRED"}.get(outcome.value, outcome.value)
    detail = ""
    if s.accepted:
        detail = ": " + ", ".join(f"{a['quantity']} meals → {a['name']}" for a in s.accepted)
    ctx.emit("result", f"{label}{detail}.", {"status": outcome.value})
    ctx.repo.update_match(s.match_id, status=outcome.value, state=s.snapshot(), result=s.result,
                          strategy=s.result["strategy"], finalized_at=ctx.now().isoformat(), reasoning_source=s.brain)
    return {"status": outcome.value, "strategy": s.result["strategy"], "allocated_quantity": s.accepted_quantity,
            "next_action": s.result["next_action"], "done": True}


IMPLEMENTATIONS: dict[str, Callable[[ToolContext, dict], dict]] = {
    "get_food_passport": t_get_food_passport,
    "validate_food_passport": t_validate_food_passport,
    "find_candidate_ngos": t_find_candidate_ngos,
    "get_ngo_details": t_get_ngo_details,
    "get_ngo_current_demand": t_get_ngo_current_demand,
    "check_ngo_capacity": t_check_ngo_capacity,
    "check_receiving_hours": t_check_receiving_hours,
    "check_food_compatibility": t_check_food_compatibility,
    "calculate_distance": t_calculate_distance,
    "estimate_delivery_time": t_estimate_delivery_time,
    "get_ngo_history": t_get_ngo_history,
    "calculate_match_score": t_calculate_match_score,
    "rank_ngos": t_rank_ngos,
    "evaluate_split_options": t_evaluate_split_options,
    "create_match": t_create_match,
    "request_ngo_confirmation": t_request_ngo_confirmation,
    "update_ngo_status": t_update_ngo_status,
    "replan_match": t_replan_match,
    "finalize_match": t_finalize_match,
}
assert set(IMPLEMENTATIONS) == set(TOOL_NAMES)


def execute_tool(ctx: ToolContext, name: str, args: dict) -> dict:
    """Runs a tool. ToolError -> {"error": ...} (recoverable, shown to the policy).
    DatabaseError propagates (the runner fails safely)."""
    fn = IMPLEMENTATIONS.get(name)
    if fn is None:
        return {"error": f"Unknown tool '{name}'. Available: {', '.join(TOOL_NAMES)}"}
    if not isinstance(args, dict) or "__invalid_json__" in args:
        return {"error": "Tool arguments were not valid JSON."}
    try:
        return fn(ctx, args)
    except ToolError as e:
        return {"error": str(e)}
    except DatabaseError:
        raise
    except (KeyError, TypeError, ValueError) as e:
        return {"error": f"Invalid arguments for {name}: {e}"}


def to_json(obj: Any, limit: int = 12000) -> str:
    s = json.dumps(obj, default=str, ensure_ascii=False)
    if len(s) > limit:
        s = s[:limit] + '..."(truncated)"'
    return s
