"""Deterministic per-NGO checks. Each returns a dict with `ok` (hard filter),
a 0..1 `factor` (for scoring, when relevant) and a human `detail`."""
from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone
from typing import Any, Optional
from zoneinfo import ZoneInfo

from ..models import NGO, NGOStatus
from .passport import FoodContext, normalise_category, normalise_tag


# --------------------------------------------------------------------- status
def check_status(ngo: NGO) -> dict[str, Any]:
    s = ngo.status
    if s == NGOStatus.ACTIVE:
        return {"ok": True, "detail": "Currently accepting donations"}
    if s == NGOStatus.AT_CAPACITY:
        return {"ok": False, "backup_only": True, "detail": "At capacity - not eligible as a primary candidate"}
    return {"ok": False, "detail": f"NGO is {s.value} - excluded"}


# --------------------------------------------------------------------- capacity / demand
def check_capacity(ngo: NGO, quantity: int, cfg: dict[str, Any]) -> dict[str, Any]:
    cap_cfg = cfg["capacity"]
    available = ngo.capacity.available_capacity_today
    need = ngo.current_demand.meals_needed
    demand_cap = math.ceil(need * (1 + cap_cfg["demand_overflow_tolerance"]))
    absorbable = min(available, demand_cap)
    limits = [f"available capacity {available}", f"current need {need} (+{int(cap_cfg['demand_overflow_tolerance']*100)}% tolerance)"]
    typ_max = ngo.history.typical_daily_distribution_max
    if typ_max:
        realistic = int(typ_max * cap_cfg["typical_distribution_overflow_factor"])
        if realistic < absorbable:
            absorbable = realistic
            limits.append(f"typically distributes up to {typ_max}/day")
    allocatable = max(0, min(absorbable, quantity))
    min_alloc = min(cap_cfg["min_allocation_meals"], quantity)
    ok = allocatable >= min_alloc and allocatable > 0
    if available <= 0:
        detail = "No capacity left today"
    elif need <= 0:
        detail = "No current food demand"
    elif not ok:
        detail = f"Can only absorb {allocatable} meals (minimum useful allocation {min_alloc})"
    elif allocatable >= quantity:
        detail = f"Can absorb the full {quantity} meals (capacity {available}, need {need})"
    else:
        detail = f"Can absorb {allocatable} of {quantity} meals (capacity {available}, need {need})"
    if ngo.active_donations >= cap_cfg["max_active_donations"]:
        ok = False
        detail = f"Already handling {ngo.active_donations} active donations (limit {cap_cfg['max_active_donations']})"
    return {
        "ok": ok, "available_capacity": available, "meals_needed": need, "absorbable": absorbable,
        "allocatable": allocatable, "capacity_fit": round(allocatable / quantity, 4) if quantity else 0.0,
        "limited_by": limits, "detail": detail,
    }


# --------------------------------------------------------------------- receiving hours
def _hm(s: str) -> tuple[int, int]:
    h, m = s.split(":")
    return int(h), int(m)


def _open_intervals(ngo: NGO, around: datetime) -> list[tuple[datetime, datetime]]:
    sh, sm = _hm(ngo.receiving_hours.start)
    eh, em = _hm(ngo.receiving_hours.end)
    out = []
    for d in (-1, 0, 1):
        day = (around + timedelta(days=d)).replace(hour=0, minute=0, second=0, microsecond=0)
        start = day + timedelta(hours=sh, minutes=sm)
        end = day + timedelta(hours=eh, minutes=em)
        if end <= start:  # overnight, e.g. 20:00-02:00
            end += timedelta(days=1)
        out.append((start, end))
    return out


def check_receiving_hours(ngo: NGO, arrival: datetime, handover_minutes: float, cfg: dict[str, Any],
                          latest_completion: Optional[datetime] = None) -> dict[str, Any]:
    """Arrival is when food reaches the NGO. If early, it waits for opening
    (only if hand-over still completes before `latest_completion`, i.e. the
    rescue deadline). Hand-over must finish before closing."""
    tz = ZoneInfo(cfg["receiving_hours"]["timezone"])
    local_arrival = arrival.astimezone(tz)
    best = None
    for start, end in _open_intervals(ngo, local_arrival):
        begin = max(local_arrival, start)
        done = begin + timedelta(minutes=handover_minutes)
        waits = begin > local_arrival
        if done <= end and (not waits or latest_completion is None or done <= latest_completion.astimezone(tz)):
            if best is None or begin < best[0]:
                best = (begin, done, start, end)
    if best is None:
        return {"ok": False, "factor": 0.0, "wait_minutes": None,
                "detail": f"Not receiving at arrival ({local_arrival:%H:%M}); hours {ngo.receiving_hours.start}-{ngo.receiving_hours.end}"
                          + (" and the next opening is after the rescue deadline" if latest_completion else "")}
    begin, done, start, end = best
    wait = max(0.0, (begin - local_arrival).total_seconds() / 60)
    buffer = (end - done).total_seconds() / 60
    comfort = cfg["receiving_hours"]["comfortable_buffer_minutes"]
    if wait > 0:
        factor = max(0.2, 1 - wait / 120)
        detail = f"Arrives {local_arrival:%H:%M}, NGO opens {start:%H:%M} (waits {wait:.0f} min)"
    else:
        factor = 0.5 + 0.5 * min(1.0, buffer / comfort) if comfort > 0 else 1.0
        detail = f"Open on arrival ({local_arrival:%H:%M}); receiving until {end:%H:%M}"
    return {"ok": True, "factor": round(factor, 4), "wait_minutes": round(wait, 1),
            "handover_complete_at": done.astimezone(timezone.utc), "minutes_before_closing": round(buffer, 1),
            "detail": detail}


# --------------------------------------------------------------------- food compatibility
ALLERGEN_CONSTRAINT_PREFIXES = ("no_", "")
ALLERGEN_CONSTRAINT_SUFFIX = "_free"


def check_food_compatibility(ngo: NGO, food: FoodContext, category_memory: Optional[dict] = None,
                             cfg: Optional[dict] = None) -> dict[str, Any]:
    reasons_fail: list[str] = []
    notes: list[str] = []
    accepted = {normalise_category(c) for c in ngo.accepted_categories}
    if accepted and food.category not in accepted:
        reasons_fail.append(f"Does not accept {food.category.replace('_', ' ')} (accepts {', '.join(sorted(accepted))})")

    veg = food.is_vegetarian
    for raw in ngo.dietary_constraints:
        c = normalise_tag(raw)
        if c in ("vegetarian_only", "veg_only", "vegetarian"):
            if veg is not True:
                reasons_fail.append("NGO accepts vegetarian food only" + (" (food vegetarian status unknown)" if veg is None else ""))
        elif c in ("vegan_only", "vegan"):
            if not (food.dietary_tags & {"vegan"}):
                reasons_fail.append("NGO accepts vegan food only")
        elif c in ("halal_only", "halal"):
            if "halal" not in food.dietary_tags and veg is not True:
                reasons_fail.append("NGO requires halal-certified or vegetarian food")
        elif c in ("jain_only", "jain", "no_onion_garlic"):
            if not (food.dietary_tags & {"jain", "no_onion_garlic"}):
                reasons_fail.append("NGO requires no onion/garlic (Jain) food")
        elif c.endswith(ALLERGEN_CONSTRAINT_SUFFIX) or c.startswith("no_"):
            allergen = c[:-len(ALLERGEN_CONSTRAINT_SUFFIX)] if c.endswith(ALLERGEN_CONSTRAINT_SUFFIX) else c[3:]
            if food.allergens is None:
                reasons_fail.append(f"NGO requires {allergen}-free food but allergen info is missing")
            elif any(allergen in a or a in allergen for a in food.allergens):
                reasons_fail.append(f"Food contains {allergen}; NGO requires {allergen}-free")
        else:
            notes.append(f"Unrecognised dietary constraint '{raw}' - flagged for review")

    prefs = {normalise_tag(p) for p in ngo.food_preferences}
    preferred = bool(prefs & ({food.category} | food.dietary_tags))
    factor = 1.0 if (preferred or not prefs) else 0.8
    if preferred:
        notes.append("Matches NGO food preference")

    # memory: category-level rejection history (never overrides hard filters)
    if category_memory and cfg:
        rcfg = cfg["reliability"]
        keys = [food.category] + (["non_vegetarian"] if veg is False else ["vegetarian"] if veg else [])
        for k in keys:
            st = category_memory.get(k)
            if st and st["requests"] >= rcfg["min_category_samples"]:
                acc = st["accepted"] / st["requests"]
                if acc < rcfg["category_rejection_penalty_threshold"]:
                    factor *= 0.5 + 0.5 * acc
                    notes.append(f"Memory: historically rejected {round((1-acc)*100)}% of {k.replace('_', ' ')} donations")
    ok = not reasons_fail
    return {"ok": ok, "factor": round(factor if ok else 0.0, 4), "preferred": preferred,
            "detail": "Compatible" if ok else "; ".join(reasons_fail), "failures": reasons_fail, "notes": notes}
