"""Vision-language inspection of the submitted food photo.

* LLMVision           - real VLM (llm.food_provider: Gemini by default; Claude / any OpenAI-compatible vision model). verified=True
* BasicImageInspector - used ONLY when no VLM is configured (or it failed in DEMO mode).
                        It cannot judge food; it just validates the file and says so
                        (verified=False, source="basic_image_check").
"""
from __future__ import annotations

import base64
import json
import re
from typing import Any, Callable, Optional

from ..agent.llm import LLMError, LLMProvider
from .models import FoodSubmission, sniff_image
from .tags import describe as tag_lines


class VisionError(RuntimeError):
    pass


VISION_SYSTEM = (
    "You are a careful food-safety visual inspector for a food-rescue charity network. "
    "You look at ONE photo of surplus food submitted by a restaurant and report only what is visible. "
    "Never invent details that are not visible. If the photo is unclear, say so and lower your confidence. "
    "Reply with a single JSON object and nothing else."
)

VISION_PROMPT = """The restaurant declared:
- food name: {food_name}
- category: {category}
- storage: {storage}
{tags}

Inspect the photo and answer with this JSON schema exactly:
{{
  "is_food": true | false,
  "food_visible": "short description of what you actually see",
  "matches_description": "yes" | "partly" | "no" | "unknown",
  "diet_seen": "veg" | "egg" | "nonveg" | "unclear",
  "tag_checks": [{{"tag": "diet" | "jain" | "spice" | "category" | "contains:<dairy|nuts|peanuts|gluten|egg|soy|sesame|seafood|onion_garlic>", "verdict": "wrong" | "maybe", "seen": "what in the photo shows it", "suggest": "the right value", "confidence": 0.0-1.0}}],
  "condition": "fresh" | "acceptable" | "questionable" | "spoiled" | "unknown",
  "spoilage_signs": ["visible signs such as mold, slime, discoloration, drying, separation - empty if none"],
  "contamination_signs": ["visible foreign objects, dirt, pests - empty if none"],
  "packaging": "sealed" | "covered" | "open" | "none" | "unknown",
  "image_quality": "good" | "poor",
  "confidence": 0.0-1.0,
  "notes": "one short sentence"
}}
tag_checks: list ONLY the declared tags the photo contradicts or casts doubt on; [] when everything fits. "wrong" when you can clearly see it (e.g. chicken in vegetarian food), "maybe" when it's likely but not visible for sure (e.g. a curry that usually has garlic, marked Jain). suggest: for diet "veg" | "egg" | "nonveg"; for jain "no"; for spice "mild" | "medium" | "hot"; for contains "add"; for category "cooked_meal" | "bakery" | "dairy" | "packaged" | "beverages" | "raw_produce". Never judge halal.
matches_description: does the photo show the named dish? "yes" if it plainly is that dish; "partly" if it shares the main ingredient but looks like a different preparation (e.g. paneer in a dark sauce named "paneer biryani"); "no" if it is clearly a different food; "unknown" if the photo is too unclear to tell.
diet_seen: "nonveg" if any meat, chicken, mutton, fish or seafood is visible; "egg" if egg is visible and no meat; "veg" if the dish is clearly vegetarian; "unclear" when you can't tell."""


def parse_vision_json(text: str) -> dict[str, Any]:
    if not text:
        raise VisionError("empty vision response")
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if not m:
        raise VisionError("vision response contained no JSON")
    try:
        return json.loads(m.group(0))
    except json.JSONDecodeError as e:
        raise VisionError(f"vision JSON invalid: {e}") from e


def _as_list(v: Any) -> list[str]:
    if isinstance(v, list):
        return [str(x).strip()[:80] for x in v if str(x).strip()][:10]
    if isinstance(v, str) and v.strip() and v.strip().lower() not in ("none", "n/a", "no"):
        return [v.strip()[:80]]
    return []


def normalise_vision(raw: dict[str, Any], verified: bool, source: str) -> dict[str, Any]:
    def pick(key, allowed, default):
        v = str(raw.get(key, default)).strip().lower()
        return v if v in allowed else default
    try:
        conf = max(0.0, min(1.0, float(raw.get("confidence", 0.0))))
    except (TypeError, ValueError):
        conf = 0.0
    is_food = raw.get("is_food")
    return {
        "is_food": is_food if isinstance(is_food, bool) else None,
        "food_visible": str(raw.get("food_visible") or "")[:160],
        "matches_description": pick("matches_description", ("yes", "partly", "no", "unknown"), "unknown"),
        "diet_seen": pick("diet_seen", ("veg", "egg", "nonveg", "unclear"), "unclear"),
        "tag_checks": [c for c in raw.get("tag_checks") or [] if isinstance(c, dict)][:12] if isinstance(raw.get("tag_checks"), list) else [],
        "condition": pick("condition", ("fresh", "acceptable", "questionable", "spoiled", "unknown"), "unknown"),
        "spoilage_signs": _as_list(raw.get("spoilage_signs")),
        "contamination_signs": _as_list(raw.get("contamination_signs")),
        "packaging": pick("packaging", ("sealed", "covered", "open", "none", "unknown"), "unknown"),
        "image_quality": pick("image_quality", ("good", "poor"), "good"),
        "confidence": round(conf, 2),
        "notes": str(raw.get("notes") or "")[:200],
        "verified": verified, "source": source,
    }


class LLMVision:
    def __init__(self, provider: LLMProvider):
        self.provider = provider
        self.label = f"VLM · {provider.label}"

    def inspect(self, image: bytes, mime: str, sub: FoodSubmission) -> dict[str, Any]:
        prompt = VISION_PROMPT.format(food_name=sub.food_name, category=sub.food_category.replace("_", " "),
                                      storage=sub.storage_method.replace("_", " "),
                                      tags=tag_lines(sub))
        try:
            text = self.provider.vision(VISION_SYSTEM, base64.b64encode(image).decode(), mime, prompt)
        except LLMError as e:
            raise VisionError(str(e)) from e
        # with a fallback chain, record the model that actually answered
        answered = getattr(self.provider, "last_label", self.provider.label)
        return normalise_vision(parse_vision_json(text), verified=True, source=f"VLM · {answered}")


class BasicImageInspector:
    """Honest stand-in when no VLM is configured: validates the file, judges nothing."""
    label = "basic image check (no VLM configured)"

    def inspect(self, image: bytes, mime: str, sub: FoodSubmission) -> dict[str, Any]:
        if sniff_image(image) is None:
            raise VisionError("unsupported or corrupt image")
        return normalise_vision({
            "is_food": None, "food_visible": "", "matches_description": "unknown", "condition": "unknown",
            "spoilage_signs": [], "contamination_signs": [], "packaging": "unknown", "image_quality": "good",
            "confidence": 0.0,
            "notes": "Image received and format-checked. No vision model is configured, so the food's visual condition was NOT assessed.",
        }, verified=False, source="basic_image_check")


def build_vision(cfg: dict[str, Any], provider_factory: Callable[[dict], Optional[LLMProvider]]):
    try:
        provider = provider_factory(cfg)
    except LLMError:
        provider = None
    return LLMVision(provider) if provider is not None else BasicImageInspector()
