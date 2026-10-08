"""DEMO MODE scenarios.

Everything here is SYNTHETIC and labelled as such (data_source=DEMO_SYNTHETIC,
reliability.source="synthetic", confirmations source=SIMULATED).

Scenarios script only how NGOs *respond* (controlled failures). Ranking,
selection, replanning and splitting are NOT scripted: they come from the
real deterministic engine + the agent's own decisions.

Receiving hours are generated relative to the current local time so the demo
works whenever you run it (e.g. "opened 3h ago, closes in 8h").
"""
from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

from ..models import NGO

RESTAURANT = {"latitude": 12.9716, "longitude": 77.5946}  # central Bengaluru (MG Road area)


def _offset(dist_km: float, bearing_deg: float) -> dict[str, float]:
    b = math.radians(bearing_deg)
    dlat = dist_km * math.cos(b) / 110.574
    dlon = dist_km * math.sin(b) / (111.320 * math.cos(math.radians(RESTAURANT["latitude"])))
    return {"latitude": round(RESTAURANT["latitude"] + dlat, 6), "longitude": round(RESTAURANT["longitude"] + dlon, 6)}


def _hours(tz: str, opened_hours_ago: float = 3, closes_in_hours: float = 8) -> dict[str, str]:
    now = datetime.now(ZoneInfo(tz))
    s = now - timedelta(hours=opened_hours_ago)
    e = now + timedelta(hours=closes_in_hours)
    return {"start": s.strftime("%H:%M"), "end": e.strftime("%H:%M")}


def ngo(ngo_id, name, dist, bearing, need, urgency, cap, daily=None, prefs=("vegetarian", "cooked_meal"),
        constraints=(), accepted=(), acc=0.9, dist_rate=0.9, samples=40, conf_min=4.0, cancel=0.02, active=1,
        today=1, status="ACTIVE", area=8, hours=None, population=None, typical=None, cat_stats=None, tz="Asia/Kolkata"):
    d: dict[str, Any] = {
        "ngo_id": ngo_id, "name": name, "location": _offset(dist, bearing), "service_area_km": area,
        "capacity": {"daily_meal_capacity": daily or max(cap, 200), "available_capacity_today": cap},
        "current_demand": {"meals_needed": need, "urgency": urgency},
        "food_preferences": list(prefs), "dietary_constraints": list(constraints), "accepted_categories": list(accepted),
        "receiving_hours": hours or _hours(tz), "active_donations": active, "donations_received_today": today,
        "population_served": population,
        "reliability": {"acceptance_rate": acc, "successful_distribution_rate": dist_rate,
                        "average_confirmation_minutes": conf_min, "cancellation_rate": cancel,
                        "sample_size": samples, "source": "synthetic"},
        "history": {"typical_daily_distribution_min": typical[0] if typical else None,
                    "typical_daily_distribution_max": typical[1] if typical else None,
                    "category_stats": cat_stats or {}},
        "status": status, "data_source": "DEMO_SYNTHETIC",
    }
    return d


def passport(food_name="Vegetable Rice", category="cooked_meal", qty=80, minutes=120,
             ingredients=("rice", "carrot", "peas", "beans", "onion"), allergens=(), tags=None, pid="F1842"):
    now = datetime.now(timezone.utc)
    p = {
        "passport_id": f"PASS-LUNA-{pid}", "food_id": f"LUNA-{pid}", "restaurant_id": "REST-0091",
        "restaurant_name": "Green Leaf Kitchen (demo)",
        "food_name": food_name, "food_category": category, "quantity": qty,
        "prepared_at": (now - timedelta(minutes=95)).isoformat(), "issued_at": now.isoformat(),
        "storage_method": "refrigerated", "storage_temperature": 4,
        "ingredients": list(ingredients), "allergens": list(allergens),
        "eligibility": {"decision": "ELIGIBLE", "risk_level": "LOW", "risk_score": 8},
        "rescue_window": {"remaining_minutes": minutes},
        "restaurant_location": dict(RESTAURANT),
    }
    if tags is not None:
        p["dietary_tags"] = list(tags)
    return p


def _closed_hours(tz="Asia/Kolkata"):
    return _hours(tz, opened_hours_ago=-3, closes_in_hours=10)  # opens in 3h


def scenario_defs() -> dict[str, dict[str, Any]]:
    S: dict[str, dict[str, Any]] = {}

    S["perfect_match"] = {
        "title": "1 · Perfect match",
        "description": "80 veg meals. A nearby NGO with high demand and enough capacity accepts.",
        "expected": "MATCHED",
        "passport": passport(),
        "ngos": [
            ngo("NGO-0042", "Hope Foundation", 2.1, 40, 100, "HIGH", 120, acc=0.94, dist_rate=0.91, population=180),
            ngo("NGO-0107", "Care Center Shivajinagar", 3.7, 330, 70, "MEDIUM", 100, acc=0.88),
            ngo("NGO-0119", "Sneha Community Kitchen", 4.9, 200, 60, "MEDIUM", 90, acc=0.81, active=3),
            ngo("NGO-0131", "Udaya Elders Home", 1.6, 120, 25, "LOW", 30, acc=0.97),
            ngo("NGO-0150", "Asha Night Shelter", 6.2, 260, 150, "HIGH", 160, acc=0.72, dist_rate=0.8),
            ngo("NGO-0163", "Nanna Mane Women's Shelter", 3.1, 90, 40, "MEDIUM", 45, acc=0.9),
        ],
        "responses": {},
    }

    flagship_ngos = [
        ngo("NGO-0042", "Hope Foundation", 2.1, 40, 110, "HIGH", 120, acc=0.94, dist_rate=0.91, population=180),
        ngo("NGO-0201", "Annapoorna Community Kitchen", 3.0, 300, 90, "HIGH", 100, acc=0.90, dist_rate=0.93, population=150),
        ngo("NGO-0107", "Care Center Shivajinagar", 3.7, 330, 70, "MEDIUM", 100, acc=0.88),
        ngo("NGO-0131", "Udaya Elders Home", 1.6, 120, 10, "LOW", 10, acc=0.97),
        ngo("NGO-0301", "Little Lamps Children's Home", 1.4, 150, 40, "HIGH", 40, acc=0.95,
            hours=_hours("Asia/Kolkata", opened_hours_ago=6, closes_in_hours=0.15)),
        ngo("NGO-0220", "Seva Sadan Shelter", 2.4, 160, 150, "CRITICAL", 200, acc=0.98, status="CLOSED",
            hours=_closed_hours()),
        ngo("NGO-0233", "Roti Ghar", 2.9, 70, 0, "LOW", 0, daily=150, acc=0.85, status="AT_CAPACITY"),
        ngo("NGO-0245", "Jain Seva Mandal", 3.3, 250, 80, "HIGH", 100, constraints=["no_onion_garlic"], acc=0.92),
        ngo("NGO-0258", "Grace Mission Hall", 4.2, 20, 90, "HIGH", 120, acc=0.55, dist_rate=0.85,
            cat_stats={"cooked_meal": {"requests": 8, "accepted": 2}}),
        ngo("NGO-0270", "Hosakote Rural Trust", 13.5, 80, 300, "CRITICAL", 300, area=20, acc=0.9),
    ]
    S["best_rejects"] = {
        "title": "2 · Best NGO rejects → autonomous replan",
        "description": "10 NGOs evaluated. The top-ranked NGO rejects; the agent observes, re-ranks and gets the next NGO to accept — no clicks.",
        "expected": "REPLAN → MATCHED",
        "passport": passport(),
        "ngos": flagship_ngos,
        "responses": {"NGO-0042": {"response": "REJECTED", "delay_s": 3,
                                   "reason": "Kitchen volunteers unavailable tonight"}},
    }

    S["best_unavailable"] = {
        "title": "3 · Best NGO becomes unavailable",
        "description": "While awaiting confirmation, the selected NGO goes offline. The agent detects UNAVAILABLE and replans.",
        "expected": "REPLAN → MATCHED",
        "passport": passport(qty=80),
        "ngos": [
            ngo("NGO-0042", "Hope Foundation", 2.1, 40, 110, "HIGH", 120, acc=0.94, population=180),
            ngo("NGO-0107", "Care Center Shivajinagar", 2.9, 330, 95, "HIGH", 100, acc=0.89),
            ngo("NGO-0301", "Little Lamps Children's Home", 1.4, 150, 25, "HIGH", 25, acc=0.95),
            ngo("NGO-0119", "Sneha Community Kitchen", 4.9, 200, 50, "MEDIUM", 60, acc=0.81),
            ngo("NGO-0150", "Asha Night Shelter", 6.2, 260, 150, "HIGH", 160, acc=0.72, dist_rate=0.8),
        ],
        "responses": {"NGO-0042": {"response": "UNAVAILABLE", "delay_s": 2.5}},
    }

    S["split_donation"] = {
        "title": "4 · No NGO has enough capacity → split",
        "description": "200 meals; no single NGO can absorb them all. The agent evaluates and executes a split.",
        "expected": "SPLIT_DONATION",
        "passport": passport(food_name="Veg Pulao & Dal", qty=200, minutes=150, pid="F1907"),
        "ngos": [
            ngo("NGO-0042", "Hope Foundation", 2.1, 40, 100, "HIGH", 110, acc=0.94),
            ngo("NGO-0201", "Annapoorna Community Kitchen", 3.0, 300, 95, "HIGH", 100, acc=0.9),
            ngo("NGO-0107", "Care Center Shivajinagar", 3.7, 330, 40, "MEDIUM", 40, acc=0.88),
            ngo("NGO-0131", "Udaya Elders Home", 1.6, 120, 20, "LOW", 20, acc=0.97),
        ],
        "responses": {},
    }

    S["too_urgent"] = {
        "title": "5 · Food too urgent",
        "description": "Only 28 minutes remain. Far NGOs with higher demand are infeasible; the agent picks one it can reach in time.",
        "expected": "MATCHED (nearest feasible)",
        "passport": passport(food_name="Idli & Sambar", qty=50, minutes=28, ingredients=("rice", "urad dal", "lentils", "tamarind"), pid="F1955"),
        "ngos": [
            ngo("NGO-0150", "Asha Night Shelter", 6.5, 260, 200, "CRITICAL", 200, acc=0.95),
            ngo("NGO-0107", "Care Center Shivajinagar", 3.0, 330, 90, "HIGH", 100, acc=0.9),
            ngo("NGO-0131", "Udaya Elders Home", 1.8, 120, 60, "MEDIUM", 60, acc=0.93),
            ngo("NGO-0119", "Sneha Community Kitchen", 1.2, 200, 30, "LOW", 30, acc=0.85),
        ],
        "responses": {},
    }

    S["no_feasible"] = {
        "title": "6 · No feasible NGO",
        "description": "Non-veg biryani, 45 minutes left. Every NGO fails a hard constraint; the agent explains why.",
        "expected": "NO_FEASIBLE_MATCH",
        "passport": passport(food_name="Chicken Biryani", qty=60, minutes=45,
                             ingredients=("rice", "chicken", "onion", "spices"), pid="F1990"),
        "ngos": [
            ngo("NGO-0245", "Jain Seva Mandal", 3.3, 250, 80, "HIGH", 100, constraints=["vegetarian_only", "no_onion_garlic"]),
            ngo("NGO-0401", "ISKCON Annadana Hall", 2.5, 10, 120, "HIGH", 150, constraints=["vegetarian_only"]),
            ngo("NGO-0220", "Seva Sadan Shelter", 2.4, 160, 150, "CRITICAL", 200, acc=0.98, status="CLOSED", hours=_closed_hours()),
            ngo("NGO-0233", "Roti Ghar", 2.9, 70, 0, "LOW", 0, daily=150, status="AT_CAPACITY"),
            ngo("NGO-0270", "Hosakote Rural Trust", 13.5, 80, 300, "CRITICAL", 300, area=20),
            ngo("NGO-0410", "Mercy Home", 1.9, 300, 0, "LOW", 50, acc=0.9),
        ],
        "responses": {},
    }

    S["no_response"] = {
        "title": "7 · NGO does not respond (timeout)",
        "description": "The top NGO never answers. After the configured timeout the agent replans automatically.",
        "expected": "TIMEOUT → REPLAN → MATCHED",
        "passport": passport(),
        "ngos": flagship_ngos[:5],
        "responses": {"NGO-0042": {"response": "NO_RESPONSE"}},
    }
    return S


def list_scenarios() -> list[dict[str, str]]:
    return [{"id": k, "title": v["title"], "description": v["description"], "expected": v["expected"]}
            for k, v in scenario_defs().items()]


def build_scenario(scenario_id: str) -> dict[str, Any]:
    defs = scenario_defs()
    if scenario_id not in defs:
        raise KeyError(scenario_id)
    d = defs[scenario_id]
    d["ngo_models"] = [NGO.model_validate(n) for n in d["ngos"]]
    return d
