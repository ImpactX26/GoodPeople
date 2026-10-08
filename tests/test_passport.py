from datetime import datetime, timedelta, timezone

from luna_ngo.demo.scenarios import passport
from luna_ngo.engine.passport import validate_food_passport


def test_valid_passport_from_brief(cfg):
    v = validate_food_passport(passport())
    assert v["valid"] and v["food"].quantity == 80
    assert v["food"].category == "cooked_meal"
    assert 119 < v["food"].remaining_minutes() <= 120


def test_missing_critical_fields_are_reported_not_guessed(cfg):
    p = passport()
    for k in ("quantity", "restaurant_location", "rescue_window", "food_category"):
        p.pop(k)
    v = validate_food_passport(p)
    assert not v["valid"] and v["food"] is None
    assert set(v["missing_fields"]) >= {"quantity", "restaurant_location", "rescue_window.remaining_minutes", "food_category"}


def test_not_eligible_passport_is_refused(cfg):
    p = passport()
    p["eligibility"]["decision"] = "REJECTED"
    v = validate_food_passport(p)
    assert not v["valid"] and any("not ELIGIBLE" in e for e in v["errors"])


def test_expired_window(cfg):
    p = passport()
    p["issued_at"] = (datetime.now(timezone.utc) - timedelta(hours=3)).isoformat()
    v = validate_food_passport(p)
    assert not v["valid"] and any("expired" in e for e in v["errors"])


def test_dietary_derivation_and_unknown_allergens(cfg):
    p = passport(ingredients=("rice", "chicken"))
    p.pop("allergens")
    v = validate_food_passport(p)
    assert v["valid"]
    assert "non_vegetarian" in v["food"].dietary_tags
    assert v["food"].allergens is None
    assert any("Allergen" in w for w in v["warnings"])


def test_malformed_field_types(cfg):
    p = passport()
    p["restaurant_location"] = {"latitude": "north", "longitude": 77}
    v = validate_food_passport(p)
    assert not v["valid"] and v["errors"]


def test_absolute_expires_at_preferred(cfg):
    p = passport()
    p["rescue_window"] = {"expires_at": (datetime.now(timezone.utc) + timedelta(minutes=30)).isoformat()}
    v = validate_food_passport(p)
    assert v["valid"] and 29 < v["food"].remaining_minutes() <= 30
