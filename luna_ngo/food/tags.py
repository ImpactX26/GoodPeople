"""Tag check: does the photo agree with the tags the donor promised (diet, Jain, spice, allergens, kind)?

The vision model lists each tag that looks wrong with how confident it is. Here those answers are
cleaned against what the donor actually declared and sorted:
  - "sure"   (verdict wrong, confidence >= SURE): the listing is held until it's relisted.
  - "unsure" (anything else): the donor is warned and may relist or keep their tags.
Halal can't be judged from a photo, so it is never flagged."""
from __future__ import annotations

from typing import Any

from .models import FoodSubmission

SURE = 0.8
ALLERGENS = ("dairy", "nuts", "peanuts", "gluten", "egg", "soy", "sesame", "seafood", "onion_garlic")
CATEGORIES = ("cooked_meal", "bakery", "dairy", "packaged", "beverages", "raw_produce")
_DIET_RANK = {"veg": 0, "egg": 1, "nonveg": 2}


def declared(sub: FoodSubmission) -> dict[str, Any]:
    t = dict(sub.declared_tags or {})
    t.setdefault("diet", sub.declared_diet)
    t.setdefault("category", sub.food_category)
    return t


def describe(sub: FoodSubmission) -> str:
    """The donor's tags as prompt lines."""
    t = declared(sub)
    diet = {"veg": "vegetarian", "egg": "vegetarian with egg", "nonveg": "non-vegetarian"}.get(t.get("diet") or "", "not stated")
    lines = [f"- diet: {diet}"]
    if t.get("jain") is not None:
        lines.append(f"- Jain friendly (no onion, garlic, egg, seafood): {'yes' if t['jain'] else 'no'}")
    if t.get("spice"):
        lines.append(f"- spice: {t['spice']}")
    if "contains" in t:
        lines.append(f"- contains: {', '.join(a.replace('_', ' / ') for a in t['contains']) or 'nothing declared'}")
    return "\n".join(lines)


def _conf(v: Any) -> float:
    try:
        return max(0.0, min(1.0, float(v)))
    except (TypeError, ValueError):
        return 0.0


def review(sub: FoodSubmission, vision: dict[str, Any]) -> list[dict[str, Any]]:
    """Cleaned tag checks: [{tag, verdict, certainty, seen, suggest, confidence}], only for tags that disagree."""
    if not vision.get("verified"):
        return []
    t = declared(sub)
    out: dict[str, dict[str, Any]] = {}

    def add(tag: str, suggest: Any, seen: str, verdict: str, conf: float):
        certainty = "sure" if verdict == "wrong" and conf >= SURE else "unsure"
        cur = out.get(tag)
        if cur is None or (certainty == "sure" and cur["certainty"] != "sure"):
            out[tag] = {"tag": tag, "verdict": verdict, "certainty": certainty, "seen": seen[:140], "suggest": suggest, "confidence": round(conf, 2)}

    for c in vision.get("tag_checks") or []:
        if not isinstance(c, dict):
            continue
        tag = str(c.get("tag") or "").strip().lower()
        verdict = "wrong" if str(c.get("verdict") or "").lower() == "wrong" else "maybe"
        seen, conf = str(c.get("seen") or "").strip(), _conf(c.get("confidence"))
        suggest = str(c.get("suggest") or "").strip().lower()
        if tag == "diet" and suggest in _DIET_RANK and t.get("diet") in _DIET_RANK and _DIET_RANK[suggest] > _DIET_RANK[t["diet"]]:
            add("diet", suggest, seen, verdict, conf)
        elif tag == "jain" and t.get("jain"):
            add("jain", "no", seen, verdict, conf)
        elif tag == "spice" and suggest in ("mild", "medium", "hot") and t.get("spice") and suggest != t["spice"]:
            add("spice", suggest, seen, "maybe", min(conf, 0.6))       # spice from a photo is a hint at most
        elif tag.startswith("contains:"):
            a = tag.split(":", 1)[1].replace(" ", "_").replace("/", "_")
            a = "onion_garlic" if a in ("onion", "garlic", "onion_garlic", "onion__garlic") else a
            has = a in (t.get("contains") or [])
            if a in ALLERGENS and not has and suggest != "remove":
                add(f"contains:{a}", "add", seen, verdict, conf)
        elif tag == "category" and suggest in CATEGORIES and suggest != t.get("category"):
            add("category", suggest, seen, "maybe", min(conf, 0.6))

    # the dedicated diet answer backs up (or adds) the diet check
    seen_diet = vision.get("diet_seen")
    if seen_diet in _DIET_RANK and t.get("diet") in _DIET_RANK and _DIET_RANK[seen_diet] > _DIET_RANK[t["diet"]]:
        add("diet", seen_diet, vision.get("food_visible") or "", "wrong", _conf(vision.get("confidence")))
    # meat, fish or egg in "Jain friendly" food also breaks Jain
    if t.get("jain") and "diet" in out:
        d = out["diet"]
        add("jain", "no", d["seen"], d["verdict"], d["confidence"])
    return list(out.values())


def verdict(checks: list[dict[str, Any]]) -> str:
    """ok | unsure | wrong for the listing as a whole."""
    if any(c["certainty"] == "sure" for c in checks):
        return "wrong"
    return "unsure" if checks else "ok"


_TAG_WORDS = {"diet": "Diet", "jain": "Jain friendly", "spice": "Spice", "category": "Kind of food"}
_VALUE_WORDS = {"veg": "veg", "egg": "veg with egg", "nonveg": "non-veg", "no": "not Jain friendly"}


def sentence(c: dict[str, Any]) -> str:
    """One plain line for the reasoning list."""
    tag = c["tag"]
    if tag.startswith("contains:"):
        what = tag.split(":", 1)[1].replace("_", " / ")
        head = f"{'Contains' if c['certainty'] == 'sure' else 'Might contain'} {what}, which isn't in your tags"
    else:
        name = _TAG_WORDS.get(tag, tag)
        if tag == "jain":
            return f"{'Not' if c['certainty'] == 'sure' else 'Might not be'} Jain friendly{f' ({c["seen"].rstrip(".")})' if c.get('seen') else ''}."
        head = f"{name}: looks like {_VALUE_WORDS.get(c['suggest'], c['suggest'])}" if c["certainty"] == "sure" else f"{name}: might be {_VALUE_WORDS.get(c['suggest'], c['suggest'])}"
    seen = f" ({c['seen'].rstrip('.')})" if c.get("seen") else ""
    return f"{head}{seen}."
