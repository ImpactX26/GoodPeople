"""Food Passport validation + normalisation.

The NGO Agent does NOT re-evaluate food safety (the Food Agent owns that).
It only checks that the passport is ELIGIBLE and contains what matching needs.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from pydantic import ValidationError

from ..models import FoodPassport

CATEGORY_SYNONYMS = {
    "cooked_meals": "cooked_meal", "cooked": "cooked_meal", "meal": "cooked_meal", "meals": "cooked_meal",
    "cooked_food": "cooked_meal", "hot_meal": "cooked_meal",
    "bakery_items": "bakery", "bread": "bakery", "baked_goods": "bakery",
    "produce": "raw_produce", "fruits": "raw_produce", "vegetables": "raw_produce", "fruit_and_veg": "raw_produce",
    "packaged_food": "packaged", "packaged_foods": "packaged", "dry_ration": "packaged", "dry_rations": "packaged",
    "milk": "dairy", "dairy_products": "dairy",
    "drinks": "beverages", "beverage": "beverages",
}
KNOWN_CATEGORIES = {"cooked_meal", "bakery", "raw_produce", "packaged", "dairy", "beverages"}

NON_VEG_KEYWORDS = {
    "chicken", "mutton", "lamb", "goat", "beef", "pork", "ham", "bacon", "fish", "prawn", "prawns", "shrimp",
    "crab", "egg", "eggs", "meat", "keema", "sausage", "salami", "tuna", "anchovy", "gelatin", "lard",
}
DAIRY_KEYWORDS = {"milk", "paneer", "curd", "yogurt", "yoghurt", "ghee", "butter", "cheese", "cream", "khoa"}
ONION_GARLIC = {"onion", "onions", "garlic", "shallot", "leek"}


def normalise_category(raw: Optional[str]) -> Optional[str]:
    if not raw:
        return None
    c = raw.strip().lower().replace(" ", "_").replace("-", "_")
    return CATEGORY_SYNONYMS.get(c, c)


def normalise_tag(raw: str) -> str:
    t = raw.strip().lower().replace(" ", "_").replace("-", "_")
    return {"veg": "vegetarian", "non_veg": "non_vegetarian", "nonveg": "non_vegetarian",
            "cooked_meals": "cooked_meal"}.get(t, t)


@dataclass
class FoodContext:
    passport_id: str
    food_id: Optional[str]
    restaurant_id: Optional[str]
    restaurant_name: Optional[str]
    food_name: str
    category: str
    quantity: int
    unit: str
    ingredients: Optional[list[str]]
    allergens: Optional[list[str]]          # None = unknown (different from [] = none)
    dietary_tags: set[str]
    dietary_source: str                     # passport | derived_from_ingredients | unknown
    latitude: float
    longitude: float
    deadline: datetime
    risk_level: Optional[str] = None
    warnings: list[str] = field(default_factory=list)

    def remaining_minutes(self, now: Optional[datetime] = None) -> float:
        now = now or datetime.now(timezone.utc)
        return (self.deadline - now).total_seconds() / 60.0

    @property
    def is_vegetarian(self) -> Optional[bool]:
        if "non_vegetarian" in self.dietary_tags:
            return False
        if self.dietary_tags & {"vegetarian", "vegan", "jain"}:
            return True
        return None

    def summary(self, now: Optional[datetime] = None) -> dict[str, Any]:
        return {
            "passport_id": self.passport_id, "food_name": self.food_name, "food_category": self.category,
            "quantity": self.quantity, "unit": self.unit, "dietary_tags": sorted(self.dietary_tags),
            "dietary_source": self.dietary_source,
            "allergens": self.allergens if self.allergens is not None else "UNKNOWN",
            "restaurant_location": {"latitude": self.latitude, "longitude": self.longitude},
            "rescue_deadline": self.deadline.isoformat(),
            "remaining_rescue_minutes": round(self.remaining_minutes(now), 1),
            "warnings": self.warnings,
        }


def _aware(dt: Optional[datetime]) -> Optional[datetime]:
    if dt is None:
        return None
    if dt.tzinfo is None:
        # Naive timestamps from the Food Agent are interpreted as the configured local tz
        from zoneinfo import ZoneInfo
        from ..config import get_config
        return dt.replace(tzinfo=ZoneInfo(get_config()["receiving_hours"]["timezone"]))
    return dt


def validate_food_passport(raw: dict[str, Any], received_at: Optional[datetime] = None) -> dict[str, Any]:
    """Returns {valid, missing_fields, errors, warnings, food (FoodContext|None)}.

    Critical (cannot match without): passport_id, food_category, quantity>0,
    restaurant_location, rescue window, eligibility.decision == ELIGIBLE.
    Missing critical info is reported back - never guessed.
    """
    received_at = received_at or datetime.now(timezone.utc)
    missing: list[str] = []
    errors: list[str] = []
    warnings: list[str] = []
    try:
        p = FoodPassport.model_validate(raw or {})
    except ValidationError as e:
        bad = ["/".join(str(x) for x in er["loc"]) for er in e.errors()]
        return {"valid": False, "missing_fields": [], "errors": [f"Malformed field(s): {', '.join(bad)}"],
                "warnings": [], "food": None}

    if not p.passport_id:
        missing.append("passport_id")
    category = normalise_category(p.food_category)
    if not category:
        missing.append("food_category")
    elif category not in KNOWN_CATEGORIES:
        warnings.append(f"Unrecognised food_category '{p.food_category}'; NGOs with explicit category lists may not accept it.")
    if p.quantity is None:
        missing.append("quantity")
    elif p.quantity <= 0 or not math.isfinite(p.quantity):
        errors.append("quantity must be a positive number")
    if p.restaurant_location is None:
        missing.append("restaurant_location")

    # Rescue window: absolute expires_at preferred, else issued_at/received_at + remaining_minutes
    deadline: Optional[datetime] = None
    rw = p.rescue_window
    if rw is None or (rw.expires_at is None and rw.remaining_minutes is None):
        missing.append("rescue_window.remaining_minutes")
    elif rw.expires_at is not None:
        deadline = _aware(rw.expires_at)
    else:
        if rw.remaining_minutes is not None and rw.remaining_minutes <= 0:
            errors.append("rescue window already expired (remaining_minutes <= 0)")
        base = _aware(p.issued_at) or received_at
        deadline = base + timedelta(minutes=float(rw.remaining_minutes or 0))

    # Contract with Food Agent: only ELIGIBLE passports are routed here.
    if p.eligibility is None or not p.eligibility.decision:
        missing.append("eligibility.decision")
    elif p.eligibility.decision.upper() != "ELIGIBLE":
        errors.append(f"Food Agent decision is '{p.eligibility.decision}', not ELIGIBLE - NGO matching is not permitted.")

    # Dietary information (not critical, but affects which NGOs are compatible)
    tags: set[str] = set()
    dietary_source = "unknown"
    if p.dietary_tags:
        tags = {normalise_tag(t) for t in p.dietary_tags}
        dietary_source = "passport"
    elif p.ingredients:
        ing = {normalise_tag(i) for i in p.ingredients}
        words = set()
        for i in ing:
            words.update(i.split("_"))
        if words & NON_VEG_KEYWORDS:
            tags.add("non_vegetarian")
        else:
            tags.add("vegetarian")
            if not (words & DAIRY_KEYWORDS):
                tags.add("possibly_vegan")
        if not (words & ONION_GARLIC) and "vegetarian" in tags:
            tags.add("no_onion_garlic")
        dietary_source = "derived_from_ingredients"
        warnings.append("dietary_tags not supplied by Food Agent; vegetarian status derived from the ingredient list.")
    else:
        warnings.append("No dietary_tags or ingredients: NGOs with dietary restrictions will be treated as incompatible.")

    allergens = None if p.allergens is None else [normalise_tag(a) for a in p.allergens]
    if allergens is None:
        warnings.append("Allergen list missing: NGOs with allergen constraints will be treated as incompatible.")

    valid = not missing and not errors
    food = None
    if valid:
        if deadline is not None and deadline <= received_at:
            errors.append("rescue window already expired")
            valid = False
        else:
            food = FoodContext(
                passport_id=p.passport_id, food_id=p.food_id, restaurant_id=p.restaurant_id,
                restaurant_name=p.restaurant_name,
                food_name=p.food_name or category.replace("_", " ").title(), category=category,
                quantity=int(round(p.quantity)), unit=p.quantity_unit or "meals",
                ingredients=p.ingredients, allergens=allergens, dietary_tags=tags, dietary_source=dietary_source,
                latitude=p.restaurant_location.latitude, longitude=p.restaurant_location.longitude,
                deadline=deadline, risk_level=p.eligibility.risk_level if p.eligibility else None,
                warnings=warnings,
            )
    return {"valid": valid, "missing_fields": missing, "errors": errors, "warnings": warnings, "food": food}
