"""Food Agent input contract: what a restaurant submits."""
from __future__ import annotations

import base64
import binascii
import math
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from ..engine.passport import KNOWN_CATEGORIES, normalise_category

STORAGE_METHODS = ("refrigerated", "hot_held", "room_temp", "frozen")
STORAGE_ALIASES = {
    "refrigerated": "refrigerated", "fridge": "refrigerated", "chilled": "refrigerated", "cold": "refrigerated",
    "hot_held": "hot_held", "hot": "hot_held", "hot_holding": "hot_held", "heated": "hot_held",
    "room_temp": "room_temp", "room_temperature": "room_temp", "ambient": "room_temp", "room": "room_temp",
    "frozen": "frozen", "freezer": "frozen",
}
ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp"}


class SubmissionError(Exception):
    def __init__(self, errors: dict[str, str]):
        super().__init__("; ".join(f"{k}: {v}" for k, v in errors.items()))
        self.errors = errors


@dataclass
class FoodSubmission:
    submission_id: str
    restaurant_id: str
    restaurant_name: str
    food_name: str
    food_category: str
    quantity: int
    quantity_unit: str
    prepared_at: datetime
    storage_method: str
    storage_temperature: Optional[float]
    ingredients: list[str]
    allergens: list[str]
    image_path: str = ""
    image_mime: str = "image/jpeg"
    submitted_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    declared_diet: Optional[str] = None   # "veg" | "egg" | "nonveg" as the donor tagged it
    declared_tags: dict[str, Any] = field(default_factory=dict)   # diet, jain, spice, contains as the donor promised

    def summary(self) -> dict[str, Any]:
        return {
            "food_name": self.food_name, "food_category": self.food_category, "quantity": self.quantity,
            "quantity_unit": self.quantity_unit, "prepared_at": self.prepared_at.isoformat(),
            "storage_method": self.storage_method, "storage_temperature": self.storage_temperature,
            "ingredients": self.ingredients, "allergens_declared": self.allergens,
        }

    def to_form(self) -> dict[str, Any]:
        return {**self.summary(), "submitted_at": self.submitted_at.isoformat()}


def sniff_image(data: bytes) -> Optional[str]:
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def decode_image(data_url_or_b64: Any, max_bytes: int) -> tuple[Optional[bytes], Optional[str], Optional[str]]:
    """Returns (bytes, mime, error). Accepts a data: URL or raw base64."""
    if not data_url_or_b64 or not isinstance(data_url_or_b64, str):
        return None, None, "Please add a photo of the food."
    b64 = data_url_or_b64.split(",", 1)[1] if data_url_or_b64.startswith("data:") and "," in data_url_or_b64 else data_url_or_b64
    try:
        raw = base64.b64decode(b64, validate=False)
    except (binascii.Error, ValueError):
        return None, None, "That image could not be read. Please try another photo."
    if len(raw) < 1500:
        return None, None, "That image looks empty or too small. Please try another photo."
    if len(raw) > max_bytes:
        return None, None, f"That image is too large (max {max_bytes // (1024 * 1024)} MB)."
    mime = sniff_image(raw)
    if mime not in ALLOWED_IMAGE_TYPES:
        return None, None, "Please upload a JPEG, PNG or WebP photo."
    return raw, mime, None


def _split_list(v: Any) -> list[str]:
    if v is None:
        return []
    if isinstance(v, list):
        items = v
    else:
        items = re.split(r"[,;\n]+", str(v))
    out = []
    for i in items:
        t = str(i).strip().lower()
        if t and t not in out:
            out.append(t[:60])
    return out[:40]


def _tags(v: Any) -> dict[str, Any]:
    if not isinstance(v, dict):
        return {}
    out: dict[str, Any] = {}
    if str(v.get("diet") or "").lower() in ("veg", "egg", "nonveg"):
        out["diet"] = str(v["diet"]).lower()
    if isinstance(v.get("jain"), bool):
        out["jain"] = v["jain"]
    if str(v.get("spice") or "").lower() in ("mild", "medium", "hot"):
        out["spice"] = str(v["spice"]).lower()
    if isinstance(v.get("contains"), list):
        out["contains"] = [str(a).lower() for a in v["contains"] if isinstance(a, str)][:12]
    return out


def _parse_dt(v: Any) -> Optional[datetime]:
    if not v or not isinstance(v, str):
        return None
    try:
        dt = datetime.fromisoformat(v.replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        from zoneinfo import ZoneInfo
        from ..config import get_config
        dt = dt.replace(tzinfo=ZoneInfo(get_config()["receiving_hours"]["timezone"]))
    return dt


def parse_submission(payload: dict[str, Any], submission_id: str, restaurant: dict[str, Any],
                     now: Optional[datetime] = None) -> FoodSubmission:
    """Validates the restaurant's form. Raises SubmissionError with per-field, user-friendly messages."""
    now = now or datetime.now(timezone.utc)
    errors: dict[str, str] = {}
    name = str(payload.get("food_name") or "").strip()
    if not name:
        errors["food_name"] = "Please tell us what the food is."
    elif len(name) > 120:
        errors["food_name"] = "Food name is too long."
    category = normalise_category(str(payload.get("food_category") or ""))
    if category not in KNOWN_CATEGORIES:
        errors["food_category"] = "Please choose a food category."
    qty = None
    try:
        qty = float(payload.get("quantity"))
        if not math.isfinite(qty) or qty < 1 or qty > 5000:
            raise ValueError
        qty = int(round(qty))
    except (TypeError, ValueError):
        errors["quantity"] = "Please enter how many portions (1–5000)."
    prepared = _parse_dt(payload.get("prepared_at"))
    if prepared is None:
        errors["prepared_at"] = "Please enter when the food was prepared."
    elif prepared > now.replace(microsecond=0) + timedelta(minutes=5):
        errors["prepared_at"] = "Preparation time can't be in the future."
    storage = STORAGE_ALIASES.get(str(payload.get("storage_method") or "").strip().lower().replace(" ", "_").replace("-", "_"))
    if storage is None:
        errors["storage_method"] = "Please choose how the food is stored."
    temp = None
    raw_t = payload.get("storage_temperature")
    if raw_t in (None, ""):
        errors["storage_temperature"] = "Please enter the storage temperature in °C."
    else:
        try:
            temp = float(raw_t)
            if not math.isfinite(temp) or temp < -60 or temp > 150:
                raise ValueError
        except (TypeError, ValueError):
            errors["storage_temperature"] = "Please enter a valid temperature in °C."
    if errors:
        raise SubmissionError(errors)
    return FoodSubmission(
        submission_id=submission_id, restaurant_id=restaurant["restaurant_id"], restaurant_name=restaurant["name"],
        food_name=name, food_category=category, quantity=qty, quantity_unit="portions", prepared_at=prepared,
        storage_method=storage, storage_temperature=temp, ingredients=_split_list(payload.get("ingredients")),
        allergens=_split_list(payload.get("allergens")), submitted_at=now,
        declared_diet=str(payload.get("diet")).lower() if str(payload.get("diet") or "").lower() in ("veg", "egg", "nonveg") else None,
        declared_tags=_tags(payload.get("tags")))
