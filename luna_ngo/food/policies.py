"""Deterministic food-safety policy + Luna Rescue Score.

Every threshold lives in config (`food_safety`). The LLM/VLM may only make
the outcome STRICTER (extra concerns, NEEDS_REVIEW); a hard failure can never
be overridden. Same inputs -> same decision (unit-tested).
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from ..engine.passport import NON_VEG_KEYWORDS, ONION_GARLIC
from .models import FoodSubmission
from . import tags as food_tags


def _words(items: list[str]) -> set[str]:
    out: set[str] = set()
    for i in items:
        out.update(i.replace("-", " ").replace("_", " ").split())
    return out


def is_non_veg(sub: FoodSubmission) -> bool:
    return bool(_words(sub.ingredients + [sub.food_name.lower()]) & NON_VEG_KEYWORDS)


def derive_dietary_tags(sub: FoodSubmission) -> list[str]:
    """Deterministic dietary tags from what the restaurant declared (ingredients + food name)."""
    if not sub.ingredients and not sub.food_name:
        return []
    w = _words(sub.ingredients + [sub.food_name.lower()])
    if w & NON_VEG_KEYWORDS:
        return ["non_vegetarian"]
    tags = ["vegetarian"]
    if sub.ingredients and not (w & ONION_GARLIC):
        tags.append("no_onion_garlic")
    return tags


def _check(name: str, status: str, detail: str, user_text: str = "") -> dict[str, str]:
    return {"name": name, "status": status, "detail": detail, "user_text": user_text or detail}


def check_consistency(sub: FoodSubmission, vision: dict[str, Any], cfg: dict[str, Any]) -> dict[str, Any]:
    """IMAGE + METADATA analysis: does what we see fit what was declared?"""
    fs = cfg["food_safety"]
    checks: list[dict[str, str]] = []
    mismatches: list[str] = []
    t = sub.storage_temperature
    tc = fs["temperature"]
    # storage method vs temperature plausibility
    if sub.storage_method == "refrigerated" and t is not None and t > 20:
        mismatches.append("Declared 'refrigerated' but temperature reads room temperature")
    if sub.storage_method == "hot_held" and t is not None and t < 30:
        mismatches.append("Declared 'hot-held' but temperature is not hot")
    if sub.storage_method == "frozen" and t is not None and t > 5:
        mismatches.append("Declared 'frozen' but temperature is above freezing")
    checks.append(_check("storage_vs_temperature", "warn" if mismatches else "pass",
                         mismatches[0] if mismatches else "Storage method matches the reported temperature"))
    # photo vs description
    if vision.get("verified"):
        m = vision["matches_description"]
        if vision["is_food"] is False:
            checks.append(_check("photo_is_food", "fail", "Photo does not appear to show food",
                                 "The photo doesn't appear to show food."))
        elif m == "no":
            mismatches.append(f"Photo shows '{vision['food_visible']}', which does not match '{sub.food_name}'")
            checks.append(_check("photo_matches_description", "warn", mismatches[-1],
                                 "The photo doesn't seem to match the food you described."))
        elif m == "partly":
            checks.append(_check("photo_matches_description", "warn", "Photo only partly matches the description"))
        else:
            checks.append(_check("photo_matches_description", "pass", f"Photo consistent with '{sub.food_name}'"))
    else:
        checks.append(_check("photo_matches_description", "warn",
                             "Visual condition not assessed by an AI model (no vision model available)"))
    return {"checks": checks, "mismatches": mismatches}


def _window_hours(sub: FoodSubmission, fs: dict[str, Any]) -> tuple[float, str, list[str]]:
    """Maximum safe hours since preparation for this category + storage (and why)."""
    method = sub.storage_method
    notes: list[str] = []
    t = sub.storage_temperature
    tc = fs["temperature"]
    hours_tbl = fs["max_hours"][sub.food_category]
    effective = method
    if method == "hot_held" and t is not None and t < tc["hot_held_min_c"]:
        effective = "room_temp"
        notes.append("Hot-holding temperature is below 57°C, so the room-temperature time limit applies")
    if method == "frozen" and t is not None and t > 0:
        effective = "room_temp"
        notes.append("Not actually frozen, so the room-temperature time limit applies")
    hours = float(hours_tbl[effective])
    if effective == "room_temp" and t is not None and t > tc["room_temp_hot_c"]:
        hours *= 0.5
        notes.append("Warm ambient temperature halves the safe time")
    if sub.food_category == "cooked_meal" and is_non_veg(sub):
        hours *= fs["non_veg_cooked_time_factor"]
        notes.append("Cooked meat/egg/fish dishes get a shorter safe time")
    return hours, effective, notes


def evaluate_safety(sub: FoodSubmission, vision: dict[str, Any], cfg: dict[str, Any], mode: str,
                    now: Optional[datetime] = None, extra_concerns: Optional[list[dict]] = None) -> dict[str, Any]:
    now = now or datetime.now(timezone.utc)
    fs = cfg["food_safety"]
    rw = fs["risk_weights"]
    tc = fs["temperature"]
    checks: list[dict[str, str]] = []
    hard: list[str] = []          # internal reasons
    hard_user: list[str] = []     # plain-language reasons shown to the restaurant
    review: list[str] = []
    review_user: list[str] = []
    risk = 0.0

    # ---- time since preparation (the core rule)
    elapsed_min = (now - sub.prepared_at).total_seconds() / 60.0
    max_h, effective, notes = _window_hours(sub, fs)
    max_min = max_h * 60
    safe_left = max_min - elapsed_min
    if elapsed_min < -5:
        hard.append("Preparation time is in the future")
        hard_user.append("The preparation time looks wrong (it's in the future).")
    age_frac = max(0.0, min(1.0, elapsed_min / max_min)) if max_min > 0 else 1.0
    risk += rw["age_fraction"] * age_frac
    if safe_left <= 0:
        hard.append(f"Prepared {elapsed_min / 60:.1f} h ago; safe limit is {max_h:g} h for {effective.replace('_', ' ')} storage")
        hard_user.append(f"It was prepared too long ago ({elapsed_min / 60:.1f} h) to be safely rescued.")
        checks.append(_check("time_since_preparation", "fail", hard[-1], hard_user[-1]))
    elif safe_left < fs["min_rescue_minutes"]:
        hard.append(f"Only {safe_left:.0f} min of safe time left (minimum {fs['min_rescue_minutes']} min needed to deliver)")
        hard_user.append("There isn't enough safe time left to get it to an NGO.")
        checks.append(_check("time_since_preparation", "fail", hard[-1], hard_user[-1]))
    else:
        checks.append(_check("time_since_preparation", "pass",
                             f"{elapsed_min / 60:.1f} h since preparation; {safe_left / 60:.1f} h of safe time left "
                             f"(limit {max_h:g} h, {effective.replace('_', ' ')})"))
    for n in notes:
        checks.append(_check("storage_rule", "warn", n))

    # ---- temperature
    t = sub.storage_temperature
    if sub.storage_method == "refrigerated" and t is not None:
        if t > tc["refrigerated_fail_c"]:
            hard.append(f"Refrigerated food at {t:g}°C (limit {tc['refrigerated_fail_c']:g}°C): cold chain broken")
            hard_user.append(f"The food was stored too warm ({t:g}°C) for refrigerated food.")
            checks.append(_check("temperature", "fail", hard[-1], hard_user[-1]))
        elif t > tc["refrigerated_ok_max_c"]:
            risk += rw["temp_warning"]
            checks.append(_check("temperature", "warn", f"{t:g}°C is above the {tc['refrigerated_ok_max_c']:g}°C target"))
        else:
            checks.append(_check("temperature", "pass", f"{t:g}°C is within the refrigerated range"))
    elif sub.storage_method == "hot_held" and t is not None:
        if t < tc["hot_held_ok_min_c"]:
            risk += rw["temp_warning"]
            checks.append(_check("temperature", "warn", f"{t:g}°C is below the {tc['hot_held_ok_min_c']:g}°C hot-holding target"))
        else:
            checks.append(_check("temperature", "pass", f"{t:g}°C hot-holding is adequate"))
    elif sub.storage_method == "frozen" and t is not None:
        if t > tc["frozen_warn_max_c"]:
            risk += rw["temp_warning"]
            checks.append(_check("temperature", "warn", f"{t:g}°C is warmer than expected for frozen food"))
        else:
            checks.append(_check("temperature", "pass", f"{t:g}°C is within the frozen range"))
    else:
        checks.append(_check("temperature", "pass", "Room-temperature storage; time limit applies"))

    # ---- category risk
    if sub.food_category in fs["high_risk_categories"]:
        risk += rw["high_risk_category"]
        checks.append(_check("category_risk", "warn", f"{sub.food_category.replace('_', ' ').title()} is a higher-risk category"))
    if sub.food_category == "cooked_meal" and is_non_veg(sub):
        risk += rw["non_veg_cooked"]

    # ---- vision
    verified = bool(vision.get("verified"))
    vcfg = fs["vision"]
    if verified:
        if vision["is_food"] is False:
            hard.append("Photo does not show food")
            hard_user.append("The photo doesn't appear to show food.")
        signs = [s.lower() for s in vision["spoilage_signs"]]
        hard_words = [w for w in vcfg["hard_spoilage_words"] if any(w in s for s in signs)]
        if vision["condition"] == "spoiled" or hard_words:
            why = ", ".join(vision["spoilage_signs"]) or "spoiled appearance"
            hard.append(f"Visible spoilage: {why}")
            hard_user.append("The photo shows signs of spoilage, so this food can't be rescued.")
            checks.append(_check("visual_condition", "fail", hard[-1], hard_user[-1]))
        elif vision["contamination_signs"]:
            hard.append("Visible contamination: " + ", ".join(vision["contamination_signs"]))
            hard_user.append("The photo shows possible contamination, so this food can't be rescued.")
            checks.append(_check("visual_condition", "fail", hard[-1], hard_user[-1]))
        elif vision["condition"] == "questionable":
            risk += rw["vision_questionable"]
            checks.append(_check("visual_condition", "warn", "Food looks questionable: " + ", ".join(vision["spoilage_signs"] or ["unclear"])))
        elif vision["condition"] == "acceptable":
            risk += rw["vision_acceptable"]
            checks.append(_check("visual_condition", "pass", "Food looks acceptable"))
        elif vision["condition"] == "fresh":
            checks.append(_check("visual_condition", "pass", "Food looks fresh"))
        else:
            risk += rw["vision_unverified"]
            checks.append(_check("visual_condition", "warn", "Visual condition could not be determined"))
        if vision["packaging"] == "open":
            risk += rw["open_packaging"]
        if vision["image_quality"] == "poor":
            review.append("Photo quality too poor to judge")
            review_user.append("The photo is too unclear for us to judge the food. A clearer photo would help.")
        if vision["confidence"] < vcfg["min_confidence"]:
            risk += rw["low_confidence"]
            review.append(f"Low visual confidence ({vision['confidence']:.2f})")
            review_user.append("We couldn't confidently verify the food from the photo.")
        if vision["matches_description"] == "no":
            review.append("Photo does not match the declared food")
            review_user.append("The photo doesn't seem to match the food you described.")
        elif vision["matches_description"] == "partly":
            risk += rw["description_partial"]
    else:
        risk += rw["vision_unverified"]
        if mode == "LIVE":
            review.append("Visual inspection unavailable (no vision model) - cannot auto-approve in LIVE mode")
            review_user.append("We couldn't check the photo automatically right now, so a team member needs to verify it.")

    # ---- LLM concerns can only tighten
    minor_total = 0.0
    for c in (extra_concerns or [])[:6]:
        text = str(c.get("concern") or "").strip()[:160]
        if not text:
            continue
        if str(c.get("severity", "minor")).lower() == "major":
            review.append(f"Agent concern: {text}")
            review_user.append("We spotted something that needs a quick manual check.")
        else:
            minor_total = min(rw["llm_minor_cap"], minor_total + rw["llm_minor_concern"])
            checks.append(_check("agent_concern", "warn", text))
    risk += minor_total
    risk = round(min(100.0, risk), 1)

    # ---- decision (deterministic precedence: hard fail > review > risk threshold)
    if hard:
        decision = "INELIGIBLE"
    elif review:
        decision = "NEEDS_REVIEW"
    elif risk > fs["approve_max_risk_score"]:
        decision = "INELIGIBLE"
        hard.append(f"Overall risk score {risk:.0f} is above the approval limit {fs['approve_max_risk_score']}")
        hard_user.append("Taken together, the storage time, temperature and condition make this too risky to rescue.")
    else:
        decision = "ELIGIBLE"
    if decision == "INELIGIBLE" or risk > fs["approve_max_risk_score"]:
        level = "HIGH"   # a hard failure is never "low risk"
    elif risk >= fs["medium_risk_from"]:
        level = "MEDIUM"
    else:
        level = "LOW"
    return {
        "decision": decision, "risk_level": level, "risk_score": risk,
        "hard_failures": hard, "hard_failures_user": hard_user,
        "review_reasons": review, "review_reasons_user": review_user,
        "checks": checks, "elapsed_minutes": round(elapsed_min, 1),
        "max_safe_hours": round(max_h, 2), "safe_minutes_remaining": round(max(0.0, safe_left), 1),
        "vision_verified": verified, "storage_basis": effective,
    }


GRADE_ORDER = "ABCD"


def freshness(safety: dict[str, Any], vision: dict[str, Any], cfg: dict[str, Any],
              now: Optional[datetime] = None) -> dict[str, Any]:
    """Grade A/B/C/D + Unsure flag (LUNA-SPEC §8.6) and a 0-100 freshness score, from the same
    evidence as the safety decision. Rules first: the photo can only lower the grade, and a
    failed safety rule or a severe sign (spoilage, contamination, not food) always means D."""
    now = now or datetime.now(timezone.utc)
    fr = cfg["food_safety"]["freshness"]
    hours_left = safety["safe_minutes_remaining"] / 60
    time_grade = ("A" if hours_left >= fr["grade_a_min_hours"] else "B" if hours_left >= fr["grade_b_min_hours"]
                  else "C" if hours_left > 0 else "D")

    photo_checked = bool(vision.get("verified")) and vision.get("condition") in fr["quality_points"]
    quality = float(fr["quality_points"][vision["condition"]]) if photo_checked else None
    cap = next(g for g, floor in fr["quality_cap"] if quality >= floor) if quality is not None else "A"
    grade = max(time_grade, cap, key=GRADE_ORDER.index)
    severe = bool(vision.get("verified")) and (vision.get("is_food") is False or vision.get("condition") == "spoiled"
                                               or bool(vision.get("contamination_signs")))
    if severe or safety["decision"] == "INELIGIBLE":
        grade = "D"
    unsure = not photo_checked or float(vision.get("confidence") or 0) < fr["unsure_below_confidence"]

    # freshness score: share of the safe time left, blended with the photo when it was judged
    max_min = safety["max_safe_hours"] * 60
    time_left = max(0.0, min(100.0, (1 - safety["elapsed_minutes"] / max_min) * 100)) if max_min > 0 else 0.0
    comp: dict[str, float] = {"time": round(time_left, 1)}
    score = time_left
    if quality is not None:
        comp["appearance"] = quality
        score = fr["time_weight"] * time_left + (1 - fr["time_weight"]) * quality
    if any(c["name"] == "temperature" and c["status"] == "warn" for c in safety["checks"]):
        score -= fr["temperature_warning_penalty"]
    if grade == "D":
        score = min(score, 39.0)  # never looks better than "not for people"
    score = max(0.0, min(100.0, score))

    safe_until = now + timedelta(minutes=safety["safe_minutes_remaining"])
    return {"score": round(score), "grade": grade, "label": fr["labels"][grade], "meaning": fr["meaning"][grade],
            "unsure": unsure, "components": comp, "photo_checked": photo_checked,
            "condition": vision.get("condition") if photo_checked else None,
            "source": "model" if photo_checked else "rules_only",
            "safe_until": safe_until.isoformat() if grade != "D" else None}


def rescue_score(safety: dict[str, Any], sub: FoodSubmission, vision: dict[str, Any], cfg: dict[str, Any]) -> dict[str, Any]:
    """Luna Rescue Score 0-100: how worthwhile and safe this rescue is."""
    fs = cfg["food_safety"]
    w, ref = fs["rescue_score_weights"], fs["rescue_score_refs"]
    comp = {
        "safety": max(0.0, 100.0 - safety["risk_score"]),
        "time": min(100.0, safety["safe_minutes_remaining"] / ref["time_minutes"] * 100),
        "quantity": min(100.0, sub.quantity / ref["quantity"] * 100),
        "image": (vision["confidence"] * 100) if vision.get("verified") else 50.0,
    }
    score = sum(w[k] * comp[k] for k in comp)
    if safety["decision"] != "ELIGIBLE":
        score = min(score, 39.0)
    return {"score": round(score, 1), "components": {k: round(v, 1) for k, v in comp.items()}, "weights": w}


_STORAGE_WORDS = {"hot_held": "kept hot", "room_temp": "at room temperature", "refrigerated": "in a fridge", "frozen": "frozen"}
_CATEGORY_WORDS = {"cooked_meal": "Cooked meals", "bakery": "Bakery items", "raw_produce": "Raw produce", "packaged": "Packaged food",
                   "dairy": "Dairy and sweets", "beverages": "Drinks"}


_DIET_WORDS = {"veg": "vegetarian", "egg": "egg", "nonveg": "non-vegetarian"}
_DIET_RANK = {"veg": 0, "egg": 1, "nonveg": 2}


def diet_mismatch(declared: str | None, seen: str | None) -> bool:
    """True when the photo shows food stricter diets can't eat (meat or egg) that the label doesn't admit."""
    return declared in _DIET_RANK and seen in _DIET_RANK and _DIET_RANK[seen] > _DIET_RANK[declared]


def explain_grade(sub: FoodSubmission, safety: dict[str, Any], vision: dict[str, Any], fresh: dict[str, Any],
                  cfg: dict[str, Any]) -> dict[str, Any]:
    """Plain-language reasoning behind the grade, step by step, for the donor's "Show reasoning".
    Mirrors freshness(): time grade, photo cap, hard failures, and the final (stricter) grade."""
    fr = cfg["food_safety"]["freshness"]
    steps: list[dict[str, str]] = []
    left_h = safety["safe_minutes_remaining"] / 60
    elapsed_h = safety["elapsed_minutes"] / 60
    max_h = safety["max_safe_hours"]
    time_grade = ("A" if left_h >= fr["grade_a_min_hours"] else "B" if left_h >= fr["grade_b_min_hours"] else "C" if left_h > 0 else "D")
    storage = _STORAGE_WORDS.get(safety.get("effective_storage") or sub.storage_method, sub.storage_method.replace("_", " "))
    steps.append({
        "title": "Time since cooking",
        "detail": (f"Cooked {elapsed_h:.1f} h ago and {_STORAGE_WORDS.get(sub.storage_method, sub.storage_method)}. "
                   f"{_CATEGORY_WORDS.get(sub.food_category, 'This food')} {storage} stay safe for up to {max_h:g} h, "
                   f"so about {max(0.0, left_h):.1f} h are left."),
        "effect": (f"Time alone gives Grade {time_grade} (A needs {fr['grade_a_min_hours']} h or more, "
                   f"B {fr['grade_b_min_hours']}–{fr['grade_a_min_hours']} h, C less than {fr['grade_b_min_hours']} h)."),
        "status": "pass" if time_grade in ("A", "B") else "warn" if time_grade == "C" else "fail",
    })
    for c in safety["checks"]:
        if c["name"] == "storage_rule":
            steps.append({"title": "Storage adjustment", "detail": c["detail"], "effect": "Shortens the safe time.", "status": "warn"})
        elif c["name"] == "temperature":
            steps.append({"title": "Temperature", "detail": c.get("user_text") or c["detail"], "effect": "",
                          "status": {"pass": "pass", "warn": "warn", "fail": "fail"}.get(c["status"], "info")})

    cap = "A"
    if vision.get("verified") and vision.get("condition") in fr["quality_points"]:
        quality = float(fr["quality_points"][vision["condition"]])
        seen = (vision.get("food_visible") or "the food").strip().rstrip(".")
        seen = vision.get("food_visible") or "the food"
        signs = (vision.get("spoilage_signs") or []) + (vision.get("contamination_signs") or [])
        detail = (f"The photo shows {seen}. It looks {vision['condition']} "
                  f"({round(float(vision.get('confidence') or 0) * 100)}% sure).")
        if signs:
            detail += " Signs noticed: " + ", ".join(signs) + "."
        if vision.get("matches_description") == "no":
            detail += f" It doesn't look like the “{sub.food_name}” described."
        steps.append({"title": "Photo check", "detail": detail,
                      "effect": "No limit from the photo." if cap == "A" else f"The photo limits the grade to {cap} at best.",
                      "status": "pass" if cap == "A" else "warn" if cap in ("B", "C") else "fail"})
    else:
        steps.append({"title": "Photo check", "detail": "No AI model judged the photo this time, so the grade uses time, storage and temperature only.",
                      "effect": "Marked Unsure: the delivery partner checks the food at pickup.", "status": "info"})

    failures = safety.get("hard_failures_user") or []
    for f in failures:
        steps.append({"title": "Safety rule failed", "detail": f, "effect": "Not safe for people (Grade D).", "status": "fail"})

    g = fresh["grade"]
    if g == "D":
        summary = "Grade D, not for people: " + (failures[0] if failures else "the photo shows spoilage or contamination.")
    elif cap == "A" or cap == time_grade:
        summary = f"Grade {g} ({fr['labels'][g]}): set by the time left ({max(0.0, left_h):.1f} h)."
    else:
        summary = f"Grade {g} ({fr['labels'][g]}): the stricter of time (Grade {time_grade}) and the photo (at best {cap})."
    if fresh.get("unsure") and g != "D":
        summary += " Marked Unsure, so the delivery partner checks it at pickup."
    checks = food_tags.review(sub, vision)
    if checks:
        sure = food_tags.verdict(checks) == "wrong"
        steps.append({"title": "Your tags vs the photo",
                      "detail": " ".join(food_tags.sentence(c) for c in checks),
                      "effect": ("Held back from NGOs until it's relisted with the right tags. The grade itself is unchanged." if sure
                                 else "Please double-check. You can relist, or keep your tags if they're right."),
                      "status": "fail" if sure else "warn"})
        summary += " Held back: the photo doesn't match your tags." if sure else " Some tags may not match the photo."
    elif vision.get("verified"):
        steps.append({"title": "Your tags vs the photo", "detail": "Nothing in the photo contradicts your tags.", "effect": "", "status": "pass"})
    steps.append({"title": "Final grade", "detail": f"{g} · {fr['labels'][g]}. {fr['meaning'][g]}", "effect": "", "status": "fail" if g == "D" else "pass"})
    return {"summary": summary, "steps": steps}
