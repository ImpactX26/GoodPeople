"""Deterministic distance + ETA model.

ETA here is an *estimate* for matching feasibility only. The Logistics Agent
owns real routing; when it exists, `estimate_delivery_plan` is the single
function to swap for a routing-API call.
"""
from __future__ import annotations

import math
from typing import Any

EARTH_RADIUS_KM = 6371.0088


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(min(1.0, math.sqrt(a)))


def estimate_travel_minutes(distance_km: float, cfg: dict[str, Any]) -> float:
    le = cfg["logistics_estimates"]
    road_km = distance_km * le["road_distance_factor"]
    speed = max(1e-6, le["average_speed_kmph"])
    return road_km / speed * 60.0


def estimate_delivery_plan(distance_km: float, cfg: dict[str, Any], extra_ngos_in_plan: int = 0) -> dict[str, float]:
    """pickup preparation + travel + receiving handover (+ split overhead)."""
    le = cfg["logistics_estimates"]
    travel = estimate_travel_minutes(distance_km, cfg)
    overhead = le["split_overhead_minutes_per_extra_ngo"] * max(0, extra_ngos_in_plan)
    prep = le["pickup_preparation_minutes"] + overhead
    return {
        "distance_km": round(distance_km, 2),
        "road_distance_km": round(distance_km * le["road_distance_factor"], 2),
        "pickup_preparation_minutes": round(prep, 1),
        "travel_minutes": round(travel, 1),
        "handover_minutes": float(le["receiving_handover_minutes"]),
        "minutes_to_arrival": round(prep + travel, 1),
        "total_plan_minutes": round(prep + travel + le["receiving_handover_minutes"], 1),
        "method": "deterministic_estimate(haversine x road_factor / avg_speed)",
    }
