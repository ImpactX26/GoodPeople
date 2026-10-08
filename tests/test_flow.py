"""Food Agent + orchestrator + /api/luna tests (Request 2: Food Agent -> NGO Agent)."""
import base64
import io
import tempfile
import time
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from luna_ngo.api import create_app
from luna_ngo.config import load_config, set_config
from luna_ngo.food.models import SubmissionError, parse_submission
from luna_ngo.food.policies import evaluate_safety, freshness
from luna_ngo.food.vision import normalise_vision, parse_vision_json
from luna_ngo.orchestrator import LunaOrchestrator
from luna_ngo.service import LunaService

RESTAURANT = {"restaurant_id": "R-1", "name": "Test Kitchen", "latitude": 12.97, "longitude": 77.59}
try:
    from PIL import Image, ImageDraw
    _im = Image.new("RGB", (640, 480), (200, 160, 90)); ImageDraw.Draw(_im).ellipse((100, 80, 540, 400), fill=(240, 230, 200))
    _b = io.BytesIO(); _im.save(_b, "JPEG")
    JPEG = _b.getvalue()
except Exception:  # minimal JPEG header is enough for sniffing
    JPEG = b"\xff\xd8\xff\xe0" + bytes(range(256)) * 40
URL = "data:image/jpeg;base64," + base64.b64encode(JPEG).decode()


def payload(**kw):
    p = {"food_name": "Vegetable Rice", "food_category": "cooked_meal", "quantity": 80,
         "prepared_at": (datetime.now(timezone.utc) - timedelta(minutes=95)).isoformat(),
         "storage_method": "refrigerated", "storage_temperature": 4, "ingredients": "rice, carrot, peas",
         "allergens": "", "image": URL}
    p.update(kw)
    return p


def sub_of(**kw):
    return parse_submission(payload(**kw), "SUB-T", RESTAURANT)


GOOD = {"is_food": True, "food_visible": "rice dish", "matches_description": "yes", "condition": "fresh", "packaging": "covered", "confidence": 0.9}
VISION_OK = normalise_vision(GOOD, True, "test")


def ev(sub, vision=VISION_OK, cfg=None, mode="DEMO", now=None):
    return evaluate_safety(sub, vision, cfg or load_config(), mode, now=now)


# ------------------------------------------------------------------ submission validation
def test_image_is_required():
    from luna_ngo.food.models import decode_image
    assert decode_image(None, 5_000_000)[2]


def test_bad_fields_reported_per_field():
    with pytest.raises(SubmissionError) as e:
        parse_submission(payload(food_name="", quantity=0, storage_temperature="abc"), "S", RESTAURANT)
    assert {"food_name", "quantity", "storage_temperature"} <= set(e.value.errors)


def test_non_image_rejected():
    bad = "data:image/jpeg;base64," + base64.b64encode(b"not an image at all").decode()
    from luna_ngo.food.models import decode_image
    assert decode_image(bad, 5_000_000)[2]


def test_valid_submission_parses():
    s = sub_of()
    assert s.quantity == 80 and s.allergens == []


# ------------------------------------------------------------------ food safety policy
def test_fresh_refrigerated_is_eligible():
    r = ev(sub_of())
    assert r["decision"] == "ELIGIBLE"


def test_too_warm_for_refrigerated_is_rejected():
    r = ev(sub_of(storage_temperature=12))
    assert r["decision"] == "INELIGIBLE" and r["hard_failures_user"]


def test_too_old_is_rejected():
    old = (datetime.now(timezone.utc) - timedelta(hours=30)).isoformat()
    assert ev(sub_of(prepared_at=old))["decision"] == "INELIGIBLE"


def test_future_prep_time_is_rejected():
    fut = (datetime.now(timezone.utc) + timedelta(hours=3)).isoformat()
    s = parse_submission(payload(prepared_at=fut), "S", RESTAURANT, now=datetime.now(timezone.utc) + timedelta(hours=4))
    assert evaluate_safety(s, VISION_OK, load_config(), "DEMO")["decision"] == "INELIGIBLE"


def test_visible_spoilage_blocks():
    v = normalise_vision({**GOOD, "condition": "spoiled", "spoilage_signs": ["mould"]}, True, "t")
    assert ev(sub_of(), vision=v)["decision"] == "INELIGIBLE"


def test_unverified_vision_live_needs_review_demo_proceeds():
    v = normalise_vision({}, False, "basic")
    assert ev(sub_of(), vision=v, mode="LIVE")["decision"] == "NEEDS_REVIEW"
    assert ev(sub_of(), vision=v, mode="DEMO")["decision"] == "ELIGIBLE"


# ------------------------------------------------------------------ freshness grade
def fresh(sub, vision=VISION_OK, mode="DEMO"):
    cfg = load_config()
    return freshness(ev(sub, vision=vision, cfg=cfg, mode=mode), vision, cfg)


def _ago(**kw):
    return (datetime.now(timezone.utc) - timedelta(**kw)).isoformat()


def test_just_cooked_and_fresh_looking_is_grade_a():
    f = fresh(sub_of(prepared_at=_ago(minutes=10)))
    assert f["grade"] == "A" and f["label"] == "Premium" and f["score"] >= 85
    assert f["photo_checked"] and not f["unsure"] and f["source"] == "model" and f["safe_until"]


def test_time_grade_follows_safe_hours_left():  # spec §8.6: A >= 6 h, B >= 3 h, C > 0
    room = dict(storage_method="room_temp", storage_temperature=25, food_category="bakery")  # bakery room: 24 h
    assert fresh(sub_of(prepared_at=_ago(hours=2), **room))["grade"] == "A"    # 22 h left
    assert fresh(sub_of(prepared_at=_ago(hours=19), **room))["grade"] == "B"   # 5 h left
    assert fresh(sub_of(prepared_at=_ago(hours=22), **room))["grade"] == "C"   # 2 h left


def test_photo_can_only_lower_the_grade():
    assert fresh(sub_of(), vision=normalise_vision({**GOOD, "condition": "acceptable"}, True, "t"))["grade"] == "B"
    assert fresh(sub_of(), vision=normalise_vision({**GOOD, "condition": "questionable"}, True, "t"))["grade"] == "C"
    old = fresh(sub_of(prepared_at=_ago(hours=14)))
    assert fresh(sub_of())["score"] > old["score"]


def test_failed_rule_or_severe_sign_is_grade_d():
    f = fresh(sub_of(storage_temperature=12))  # cold chain broken
    assert f["grade"] == "D" and f["label"] == "Not for people" and f["score"] <= 39 and f["safe_until"] is None
    spoiled = normalise_vision({**GOOD, "condition": "spoiled", "spoilage_signs": ["mould"]}, True, "t")
    assert fresh(sub_of(), vision=spoiled)["grade"] == "D"


def test_unjudged_or_low_confidence_photo_is_unsure():
    f = fresh(sub_of(), vision=normalise_vision({}, False, "basic"))
    assert f["unsure"] and f["source"] == "rules_only" and not f["photo_checked"] and set(f["components"]) == {"time"}
    shaky = normalise_vision({**GOOD, "confidence": 0.4}, True, "t")
    assert fresh(sub_of(), vision=shaky)["unsure"]


def test_parse_vision_json_tolerates_fences():
    assert parse_vision_json('```json\n{"food_visible": true}\n```')["food_visible"] is True


# ------------------------------------------------------------------ orchestrator + API
@pytest.fixture
def client():
    cfg = load_config(overrides={"demo": {"step_delay_seconds": 0, "default_response_delay_seconds": 0.05},
                                 "confirmation": {"demo_timeout_seconds": 3, "live_timeout_seconds": 3, "poll_interval_seconds": 0.02},
                                 "flow": {"demo_step_delay_seconds": 0, "mode": "DEMO"}})
    set_config(cfg)
    svc = LunaService(cfg, in_memory=True, provider_factory=lambda c: None)
    orch = LunaOrchestrator(svc, upload_dir=tempfile.mkdtemp(), food_brain="rules", ngo_brain="rules")
    return TestClient(create_app(svc, orch)), orch


def run(cl, body, timeout=20):
    r = cl.post("/api/luna/submissions", json=body)
    assert r.status_code == 202, r.text
    sid = r.json()["submission_id"]
    t = time.time()
    while time.time() - t < timeout:
        v = cl.get(f"/api/luna/submissions/{sid}").json()
        if v["done"]:
            return sid, v
        time.sleep(0.05)
    raise AssertionError("flow did not finish")


def test_missing_image_returns_422(client):
    cl, _ = client
    r = cl.post("/api/luna/submissions", json=payload(image=None))
    assert r.status_code == 422 and "image" in r.json()["errors"]


# ------------------------------------------------------------------ LIVE: listed NGOs, partner, pickup + drop codes
class FreshPhoto:
    label = "test vision"

    def inspect(self, image, mime, sub):
        return VISION_OK


@pytest.fixture
def live():
    cfg = load_config(overrides={"confirmation": {"live_timeout_seconds": 5, "poll_interval_seconds": 0.02},
                                 "flow": {"mode": "LIVE", "demo_step_delay_seconds": 0}})
    set_config(cfg)
    svc = LunaService(cfg, in_memory=True, provider_factory=lambda c: None)
    orch = LunaOrchestrator(svc, vision_factory=lambda c: FreshPhoto(), upload_dir=tempfile.mkdtemp(),
                            food_brain="rules", ngo_brain="rules")
    cl = TestClient(create_app(svc, orch))
    for nid, name, lat, need in [("NGO-9000000001", "Near Shelter", 12.936, 100), ("NGO-9000000002", "Far Home", 12.96, 100)]:
        ngo = {"ngo_id": nid, "name": name, "location": {"latitude": lat, "longitude": 77.625}, "service_area_km": 8,
               "capacity": {"daily_meal_capacity": 300, "available_capacity_today": 120},
               "current_demand": {"meals_needed": need, "urgency": "HIGH"}, "accepted_categories": ["cooked_meal"],
               "receiving_hours": {"start": "00:00", "end": "24:00"}, "reliability": {"source": "none"}, "data_source": "LIVE"}
        assert cl.post("/api/ngos?mode=LIVE", json=ngo).status_code == 200
    return cl


def _until(fn, timeout=10):
    t = time.time()
    while time.time() - t < timeout:
        v = fn()
        if v:
            return v
        time.sleep(0.05)
    raise AssertionError("timed out")


def _pending(cl, nid):
    return _until(lambda: next((o for o in cl.get(f"/api/portal/offers?mode=LIVE&ngo_id={nid}").json()
                                if o["status"] == "PENDING"), None))


def test_donor_food_goes_to_listed_ngos_then_partner_pickup_and_drop(live):
    cl = live
    sid = cl.post("/api/luna/submissions", json=payload(donor=DONOR)).json()["submission_id"]
    view = lambda: cl.get(f"/api/luna/submissions/{sid}").json()

    first = _pending(cl, "NGO-9000000001")  # highest priority listed NGO gets it first
    ranking = view()["ranking"]
    assert [r["name"] for r in ranking[:2]] == ["Near Shelter", "Far Home"] and ranking[0]["rank"] == 1
    cl.post(f"/api/ngo-agent/{first['match_id']}/confirmation", json={"ngo_id": "NGO-9000000001", "response": "REJECTED"})
    second = _pending(cl, "NGO-9000000002")  # declined -> next in line
    mid = second["match_id"]
    drop = cl.post(f"/api/ngo-agent/{mid}/confirmation",
                   json={"ngo_id": "NGO-9000000002", "response": "ACCEPTED", "delivery_notes": "Ladles"}).json()["otp"]
    _until(lambda: view()["stage"] == "MATCHED")
    v = view()
    assert v["status"]["next"] == "Far Home is sending a delivery partner" and not v["pickup"]

    # the NGO sends a partner -> the donor sees the pickup code; the NGO never does
    bad = cl.post(f"/api/ngo-agent/{mid}/partner", json={"ngo_id": "NGO-9000000002", "partner_name": "Arjun", "partner_phone": "123"})
    assert bad.status_code == 422
    assert cl.post(f"/api/ngo-agent/{mid}/partner",
                   json={"ngo_id": "NGO-9000000002", "partner_name": "Arjun", "partner_phone": "9876500000"}).json()["assigned"]
    v = view()
    code = v["pickup"][0]["code"]
    assert len(code) == 4 and "Arjun is coming" in v["status"]["now"]
    assert all("pickup_otp" not in o for o in cl.get("/api/portal/offers?mode=LIVE&ngo_id=NGO-9000000002").json())
    task = cl.get("/api/partner/tasks?phone=9876500000").json()[0]
    assert task["stage"] == "to_pickup" and task["drop"]["name"] == "Far Home" and task["bring"] == "Ladles"
    assert "otp" not in str(task).lower()

    # drop before pickup is refused; wrong pickup code refused; then pickup, then drop
    assert not cl.post(f"/api/ngo-agent/{mid}/verify-otp", json={"ngo_id": "NGO-9000000002", "otp": drop}).json()["verified"]
    assert not cl.post(f"/api/ngo-agent/{mid}/pickup", json={"partner_phone": "9876500000", "otp": "0000" if code != "0000" else "1111"}).json()["verified"]
    assert cl.post(f"/api/ngo-agent/{mid}/pickup", json={"partner_phone": "9876500000", "otp": code}).json()["verified"]
    v = view()
    assert not v["pickup"] and v["status"]["now"].startswith("Picked up")
    assert cl.get("/api/partner/tasks?phone=9876500000").json()[0]["stage"] == "to_drop"
    assert cl.post(f"/api/ngo-agent/{mid}/verify-otp", json={"ngo_id": "NGO-9000000002", "otp": drop}).json()["verified"]
    v = view()
    bar = {p["key"]: p["state"] for p in v["progress"]}
    assert set(bar.values()) == {"done"} and v["status"]["now"] == "Delivered to Far Home" and not v["open"]
    texts = [e["text"] for e in v["timeline"]]
    assert any("sent Arjun" in t for t in texts) and any(t.startswith("Picked up by Arjun") for t in texts)
    assert any(t.startswith("Delivered to Far Home") for t in texts)


def test_eligible_food_automatically_reaches_an_ngo(client):
    cl, _ = client
    sid, v = run(cl, payload())
    assert v["stage"] == "MATCHED"
    assert v["ngos"] and v["ngos"][0]["portions"] > 0 and v["rescue_score"] is not None
    ops = cl.get(f"/api/luna/submissions/{sid}/ops").json()
    assert ops["match_id"] and ops["ready_for_logistics"]
    assert ops["food_passport"]["issued_by"] == "FOOD_AGENT"
    assert ops["food_passport"]["eligibility"]["decision"] == "ELIGIBLE"


def test_public_view_leaks_no_internals(client):
    cl, _ = client
    _, v = run(cl, payload())
    text = str(v).lower()
    for bad in ("tool", "passport", "prompt", "iteration", "traceback", "match_id", "reasoning"):
        assert bad not in text, bad
    assert not ({"events", "food_passport", "match_id", "trace", "checks"} & set(v))


def test_ineligible_food_never_starts_ngo_agent(client):
    cl, orch = client
    sid, v = run(cl, payload(storage_temperature=12))
    assert v["stage"] == "NOT_ELIGIBLE" and not v["ngos"]
    ops = cl.get(f"/api/luna/submissions/{sid}/ops").json()
    assert not ops["match_id"] and not ops["ready_for_logistics"]
    assert orch.repo.list_matches(10) == []


def test_ngo_agent_replans_when_first_ngo_rejects(client):
    cl, orch = client
    orch.flow["demo_script"] = "first_rejects"
    sid, v = run(cl, payload(), timeout=40)
    assert v["stage"] in ("MATCHED", "PARTIAL")
    ops = cl.get(f"/api/luna/submissions/{sid}/ops").json()
    assert all(n["name"] != "Hope Foundation" or v["stage"] != "MATCHED" for n in v["ngos"]) or ops["match_id"]


DONOR = {"id": "DONOR-9876543210", "name": "Meghana Mess", "latitude": 12.9352, "longitude": 77.6245}


def test_donor_listing_gets_freshness_grade_and_own_history(client):
    cl, _ = client
    sid, v = run(cl, payload(donor=DONOR))
    assert v["freshness"]["grade"] in "ABC" and 0 <= v["freshness"]["score"] <= 100
    assert v["freshness"]["safe_until"]
    ops = cl.get(f"/api/luna/submissions/{sid}/ops").json()
    assert ops["food_passport"]["restaurant_name"] == "Meghana Mess"
    assert ops["food_passport"]["freshness"]["grade"] == v["freshness"]["grade"]
    run(cl, payload())  # someone else's submission
    mine = cl.get(f"/api/luna/submissions?donor_id={DONOR['id']}").json()
    assert [m["submission_id"] for m in mine] == [sid] and mine[0]["freshness"]


def test_rejected_donor_food_explains_why(client):
    cl, _ = client
    _, v = run(cl, payload(donor=DONOR, storage_temperature=12))
    assert v["stage"] == "NOT_ELIGIBLE" and v["freshness"]["grade"] == "D" and v["reasons"]


def test_decision_agent_status_bar_and_timeline_when_matched(client):
    cl, _ = client
    _, v = run(cl, payload(donor=DONOR))
    bar = {p["key"]: p["state"] for p in v["progress"]}
    assert bar == {"listed": "done", "checked": "done", "offered": "done", "accepted": "done",
                   "partner": "active", "picked_up": "pending", "delivered": "pending"}
    assert v["status"]["by"] == "Decision Agent" and "accepted" in v["status"]["now"] and v["open"]
    assert v["ranking"] and v["ranking"][0]["rank"] == 1
    texts = [e["text"] for e in v["timeline"]]
    assert texts[0].startswith("Listed") and texts[1].startswith("Checked · Grade")
    assert any(t.startswith("Offered to") for t in texts) and any(t.startswith("Accepted by") for t in texts)
    assert [e["at"] for e in v["timeline"]] == sorted(e["at"] for e in v["timeline"])


def test_no_ngo_is_said_plainly(client):
    cl, orch = client
    orch.svc.seed_flow_demo_ngos = lambda: 0  # an empty NGO database
    _, v = run(cl, payload(donor=DONOR))
    assert v["stage"] == "NO_NGO" and v["headline"] == "No NGO available"
    assert v["status"]["now"] == "No NGO available right now" and "Please don't keep it past" in v["status"]["next"]
    assert {p["key"]: p["state"] for p in v["progress"]}["offered"] == "failed" and not v["open"]


def test_listing_made_before_grading_gets_graded(client):
    cl, orch = client
    sid, _ = run(cl, payload(donor=DONOR))
    row = orch.repo.get_submission(sid)
    a = dict(row["assessment"]); a.pop("freshness")
    orch.repo.update_submission(sid, assessment=a)  # what an older server stored
    v = cl.get(f"/api/luna/submissions/{sid}").json()
    assert v["freshness"] and v["freshness"]["grade"] in "ABC"


def test_donor_without_location_is_refused(client):
    cl, _ = client
    r = cl.post("/api/luna/submissions", json=payload(donor={"id": "D1", "name": "X"}))
    assert r.status_code == 422 and "donor" in r.json()["errors"]


def test_list_submissions(client):
    cl, _ = client
    run(cl, payload())
    assert len(cl.get("/api/luna/submissions").json()) == 1
    assert cl.get("/api/luna/submissions/nope").status_code == 404


def test_pages_served(client):
    cl, _ = client
    assert "ANALYZE FOOD" in cl.get("/").text
    assert cl.get("/ops").status_code == 200
