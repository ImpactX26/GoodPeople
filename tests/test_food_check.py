"""POST /api/luna/food-check: Food Agent only, synchronous, never starts NGO matching."""
import base64
from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient

from luna_ngo.api import create_app
from luna_ngo.orchestrator import LunaOrchestrator
from luna_ngo.service import LunaService

# Smallest valid JPEG bytes padded past the 1.5 KB "empty image" guard.
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 2000 + b"\xff\xd9"


def _client(tmp_path, cfg):
    svc = LunaService(cfg, in_memory=True, provider_factory=lambda c: None, food_provider_factory=lambda c: None)
    orch = LunaOrchestrator(svc, upload_dir=tmp_path / "up", food_brain="rules", ngo_brain="rules")
    return TestClient(create_app(svc, orch)), orch


def _payload(hours_ago: float, storage="hot_held", temp=65):
    return {
        "food_name": "Veg biryani", "food_category": "cooked_meal", "quantity": 10,
        "prepared_at": (datetime.now(timezone.utc) - timedelta(hours=hours_ago)).isoformat(),
        "storage_method": storage, "storage_temperature": temp, "ingredients": ["rice", "vegetables"],
        "allergens": ["dairy"], "image": "data:image/jpeg;base64," + base64.b64encode(JPEG).decode(),
        "donor": {"id": "DONOR-9845012345", "name": "Test Kitchen", "latitude": 12.93, "longitude": 77.62},
    }


def test_fresh_food_is_graded_and_no_match_starts(tmp_path, cfg):
    client, orch = _client(tmp_path, cfg)
    r = client.post("/api/luna/food-check", json=_payload(0.5))
    assert r.status_code == 200, r.text
    body = r.json()
    # No vision model in tests: LIVE mode won't approve food nobody has seen, DEMO does.
    assert body["decision"] in {"ELIGIBLE", "NEEDS_REVIEW"}
    assert body["freshness"]["grade"] in {"A", "B", "C"}
    assert body["freshness"]["unsure"] is True          # no vision model in tests: photo not judged
    assert body["photo"]["checked"] is False
    assert body["models"] == {"photo": None, "reasoning": "rules"}   # says exactly what ran
    ex = body["explanation"]
    assert ex["summary"].startswith(f"Grade {body['freshness']['grade']}")
    titles = [s["title"] for s in ex["steps"]]
    assert titles[0] == "Time since cooking" and "Photo check" in titles and titles[-1] == "Final grade"
    row = orch.repo.get_submission(body["check_id"])
    assert row["stage"] in {"CHECKED", "NEEDS_REVIEW"} and not row["match_id"]   # NGO matching never started


def test_old_room_temperature_food_is_not_for_people(tmp_path, cfg):
    client, _ = _client(tmp_path, cfg)
    body = client.post("/api/luna/food-check", json=_payload(6, storage="room_temp", temp=28)).json()
    assert body["decision"] == "INELIGIBLE"
    assert body["freshness"]["grade"] == "D"
    assert body["reasons"]
    assert body["explanation"]["summary"].startswith("Grade D")
    assert any(s["status"] == "fail" for s in body["explanation"]["steps"])


def test_missing_fields_are_explained(tmp_path, cfg):
    client, _ = _client(tmp_path, cfg)
    bad = _payload(0.5)
    del bad["food_name"]
    r = client.post("/api/luna/food-check", json=bad)
    assert r.status_code == 422
    assert "food_name" in r.json()["errors"]


def test_diet_mismatch_rule():
    from luna_ngo.food.policies import diet_mismatch
    assert diet_mismatch("veg", "nonveg") and diet_mismatch("veg", "egg") and diet_mismatch("egg", "nonveg")
    assert not diet_mismatch("nonveg", "veg") and not diet_mismatch("veg", "unclear") and not diet_mismatch(None, "nonveg")


def test_vision_normalises_diet_seen():
    from luna_ngo.food.vision import normalise_vision
    assert normalise_vision({"diet_seen": "NonVeg"}, True, "x")["diet_seen"] == "nonveg"
    assert normalise_vision({"diet_seen": "chicken"}, True, "x")["diet_seen"] == "unclear"


def _sub(**tags):
    from datetime import datetime, timezone
    from luna_ngo.food.models import FoodSubmission
    return FoodSubmission("S", "R", "R", "Veg biryani", "cooked_meal", 10, "portions", datetime.now(timezone.utc), "hot_holding", 65.0, [], [],
                          declared_diet=tags.get("diet"), declared_tags=tags)


def test_tag_review_sorts_sure_and_unsure():
    from luna_ngo.food import tags
    sub = _sub(diet="veg", jain=True, spice="mild", contains=[])
    v = {"verified": True, "confidence": 0.9, "diet_seen": "nonveg", "food_visible": "rice with chicken", "tag_checks": [
        {"tag": "contains:garlic", "verdict": "maybe", "seen": "curry base usually has garlic", "suggest": "add", "confidence": 0.5},
        {"tag": "spice", "verdict": "wrong", "seen": "lots of red chilli", "suggest": "hot", "confidence": 0.95},
        {"tag": "halal", "verdict": "wrong", "suggest": "no", "confidence": 1},
    ]}
    got = {c["tag"]: c for c in tags.review(sub, v)}
    assert got["diet"]["certainty"] == "sure" and got["diet"]["suggest"] == "nonveg"
    assert got["jain"]["certainty"] == "sure"
    assert got["contains:onion_garlic"]["certainty"] == "unsure"
    assert got["spice"]["certainty"] == "unsure"          # spice is never a hard no
    assert "halal" not in got
    assert tags.verdict(list(got.values())) == "wrong"


def test_tag_review_only_unsure_and_unverified():
    from luna_ngo.food import tags
    sub = _sub(diet="veg", jain=True, contains=[])
    maybe = {"verified": True, "diet_seen": "veg", "tag_checks": [{"tag": "contains:onion_garlic", "verdict": "maybe", "seen": "gravy", "suggest": "add", "confidence": 0.6}]}
    assert tags.verdict(tags.review(sub, maybe)) == "unsure"
    assert tags.review(sub, {**maybe, "verified": False}) == []
    assert tags.review(_sub(diet="veg", contains=["onion_garlic"]), maybe) == []   # already declared


def test_today_listing_overrides_defaults_only_today(svc):
    from fastapi.testclient import TestClient
    from luna_ngo.api import create_app
    c = TestClient(create_app(svc))
    ngo = {"ngo_id": "NGO-T1", "name": "Today Test", "location": {"latitude": 12.97, "longitude": 77.59}, "service_area_km": 8,
           "capacity": {"daily_meal_capacity": 200, "available_capacity_today": 200}, "current_demand": {"meals_needed": 80, "urgency": "MEDIUM"},
           "receiving_hours": {"start": "08:00", "end": "21:00"}, "data_source": "LIVE"}
    assert c.post("/api/ngos?mode=LIVE", json=ngo).status_code == 200
    r = c.put("/api/ngos/NGO-T1/today?mode=LIVE", json={"meals_needed": 30, "available_capacity_today": 40, "receiving_hours": {"start": "12:00", "end": "15:00"}})
    assert r.status_code == 200
    raw = c.get("/api/ngos/NGO-T1?mode=LIVE").json()
    assert raw["current_demand"]["meals_needed"] == 80 and raw["today_active"] and raw["today"]["meals_needed"] == 30
    eff = next(n for n in c.get("/api/ngos?mode=LIVE").json()["ngos"] if n["ngo_id"] == "NGO-T1")
    assert eff["current_demand"]["meals_needed"] == 30 and eff["capacity"]["available_capacity_today"] == 40 and eff["receiving_hours"]["start"] == "12:00"
    # a stale plan from another day is ignored
    from luna_ngo.models import NGO
    n = NGO.model_validate({**ngo, "today": {"date": "2000-01-01", "meals_needed": 1}})
    assert n.effective("2026-10-07").current_demand.meals_needed == 80
    assert c.delete("/api/ngos/NGO-T1/today?mode=LIVE").json()["today"] is None
    assert c.get("/api/ngos/NGO-T1?mode=LIVE").json()["today_active"] is False
