"""Data contracts for the NGO Matching Agent.

* FoodPassport  - produced by the Food Agent (consumed, never re-evaluated here)
* NGO           - NGO profile + live operational state
* MatchResult   - returned to the Luna Orchestrator / Logistics Agent

Schema additions beyond the hackathon brief are marked `# EXT` and documented in
docs/ngo-agent-architecture.md.
"""
from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


# --------------------------------------------------------------------------- enums
class NGOStatus(str, Enum):
    """Global operational status of an NGO (owned by the NGO / ops team)."""
    ACTIVE = "ACTIVE"
    AT_CAPACITY = "AT_CAPACITY"
    CLOSED = "CLOSED"
    UNAVAILABLE = "UNAVAILABLE"


class CandidateStatus(str, Enum):
    """Per-match status of an NGO inside ONE matching run."""
    CANDIDATE = "CANDIDATE"
    EXCLUDED = "EXCLUDED"
    AWAITING_CONFIRMATION = "AWAITING_CONFIRMATION"
    ACCEPTED = "ACCEPTED"
    REJECTED = "REJECTED"
    NO_RESPONSE = "NO_RESPONSE"
    UNAVAILABLE = "UNAVAILABLE"


class ConfirmationResponse(str, Enum):
    ACCEPTED = "ACCEPTED"
    REJECTED = "REJECTED"
    NO_RESPONSE = "NO_RESPONSE"
    UNAVAILABLE = "UNAVAILABLE"


class MatchStatus(str, Enum):
    RECEIVED = "RECEIVED"
    VALIDATING = "VALIDATING"
    SEARCHING = "SEARCHING"
    EVALUATING = "EVALUATING"
    AWAITING_CONFIRMATION = "AWAITING_CONFIRMATION"
    REPLANNING = "REPLANNING"
    # terminal
    MATCHED = "MATCHED"
    PARTIALLY_MATCHED = "PARTIALLY_MATCHED"
    NO_FEASIBLE_MATCH = "NO_FEASIBLE_MATCH"
    NEEDS_INFORMATION = "NEEDS_INFORMATION"
    WINDOW_EXPIRED = "WINDOW_EXPIRED"
    FAILED = "FAILED"


TERMINAL_STATUSES = {
    MatchStatus.MATCHED, MatchStatus.PARTIALLY_MATCHED, MatchStatus.NO_FEASIBLE_MATCH,
    MatchStatus.NEEDS_INFORMATION, MatchStatus.WINDOW_EXPIRED, MatchStatus.FAILED,
}


class Strategy(str, Enum):
    SINGLE_NGO = "SINGLE_NGO"
    SPLIT_DONATION = "SPLIT_DONATION"
    NO_MATCH = "NO_MATCH"


class Mode(str, Enum):
    LIVE = "LIVE"
    DEMO = "DEMO"


# --------------------------------------------------------------------------- shared
class GeoPoint(BaseModel):
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)


# --------------------------------------------------------------------------- food passport
class RescueWindow(BaseModel):
    model_config = ConfigDict(extra="allow")
    remaining_minutes: Optional[float] = None
    expires_at: Optional[datetime] = None  # EXT: absolute deadline, preferred if present


class Eligibility(BaseModel):
    model_config = ConfigDict(extra="allow")
    decision: Optional[str] = None
    risk_level: Optional[str] = None
    risk_score: Optional[float] = None


class FoodPassport(BaseModel):
    """Tolerant parser: every field optional so that validation (not parsing)
    decides what is missing and the agent can ask for it instead of crashing."""
    model_config = ConfigDict(extra="allow")

    passport_id: Optional[str] = None
    food_id: Optional[str] = None
    restaurant_id: Optional[str] = None
    restaurant_name: Optional[str] = None          # EXT
    food_name: Optional[str] = None
    food_category: Optional[str] = None
    quantity: Optional[float] = None
    quantity_unit: Optional[str] = "meals"         # EXT
    prepared_at: Optional[datetime] = None
    issued_at: Optional[datetime] = None           # EXT: when the Food Agent issued the passport
    storage_method: Optional[str] = None
    storage_temperature: Optional[float] = None
    ingredients: Optional[list[str]] = None
    allergens: Optional[list[str]] = None
    dietary_tags: Optional[list[str]] = None       # EXT: e.g. ["vegetarian", "jain"]
    eligibility: Optional[Eligibility] = None
    rescue_window: Optional[RescueWindow] = None
    restaurant_location: Optional[GeoPoint] = None


# --------------------------------------------------------------------------- NGO
class Capacity(BaseModel):
    daily_meal_capacity: int = Field(ge=0)
    available_capacity_today: int = Field(ge=0)

    @model_validator(mode="after")
    def _available_le_daily(self):
        if self.available_capacity_today > self.daily_meal_capacity:
            raise ValueError("available_capacity_today cannot exceed daily_meal_capacity")
        return self


class Demand(BaseModel):
    meals_needed: int = Field(ge=0)
    urgency: Literal["LOW", "MEDIUM", "HIGH", "CRITICAL"] = "MEDIUM"
    updated_at: Optional[datetime] = None          # EXT


class ReceivingHours(BaseModel):
    start: str
    end: str

    @field_validator("start", "end")
    @classmethod
    def _hhmm(cls, v: str) -> str:
        parts = v.split(":")
        if len(parts) != 2 or not all(p.isdigit() for p in parts):
            raise ValueError(f"receiving hour '{v}' must be HH:MM")
        h, m = int(parts[0]), int(parts[1])
        if not (0 <= h <= 24 and 0 <= m < 60) or (h == 24 and m != 0):
            raise ValueError(f"receiving hour '{v}' out of range")
        return f"{h:02d}:{m:02d}"


class Reliability(BaseModel):
    acceptance_rate: Optional[float] = Field(default=None, ge=0, le=1)
    successful_distribution_rate: Optional[float] = Field(default=None, ge=0, le=1)
    average_confirmation_minutes: Optional[float] = Field(default=None, ge=0)   # EXT
    cancellation_rate: Optional[float] = Field(default=None, ge=0, le=1)        # EXT
    sample_size: int = 0                                                       # EXT
    source: Literal["synthetic", "reported", "observed", "none"] = "none"     # EXT


class CategoryStat(BaseModel):
    requests: int = Field(ge=0)
    accepted: int = Field(ge=0)


class NGOHistory(BaseModel):  # EXT: memory baseline
    typical_daily_distribution_min: Optional[int] = None
    typical_daily_distribution_max: Optional[int] = None
    category_stats: dict[str, CategoryStat] = Field(default_factory=dict)


class Contact(BaseModel):  # EXT
    phone: Optional[str] = None
    webhook_url: Optional[str] = None


class TodayPlan(BaseModel):
    """EXT: one day's changes to an NGO's default listing. Applies only on `date` (local), then lapses."""
    date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    meals_needed: Optional[int] = Field(default=None, ge=0)
    urgency: Optional[Literal["LOW", "MEDIUM", "HIGH", "CRITICAL"]] = None
    available_capacity_today: Optional[int] = Field(default=None, ge=0)
    receiving_hours: Optional[ReceivingHours] = None


class NGO(BaseModel):
    ngo_id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    location: GeoPoint
    address: Optional[str] = None                     # EXT
    service_area_km: float = Field(gt=0)
    capacity: Capacity
    current_demand: Demand
    food_preferences: list[str] = Field(default_factory=list)
    accepted_categories: list[str] = Field(default_factory=list)   # EXT: hard filter; empty = any
    dietary_constraints: list[str] = Field(default_factory=list)
    receiving_hours: ReceivingHours
    active_donations: int = Field(default=0, ge=0)
    donations_received_today: int = Field(default=0, ge=0)        # EXT
    population_served: Optional[int] = Field(default=None, ge=0)  # EXT
    reliability: Reliability = Field(default_factory=Reliability)
    history: NGOHistory = Field(default_factory=NGOHistory)       # EXT
    contact: Contact = Field(default_factory=Contact)             # EXT
    status: NGOStatus = NGOStatus.ACTIVE
    data_source: Literal["DEMO_SYNTHETIC", "LIVE"] = "LIVE"       # EXT
    today: Optional[TodayPlan] = None                             # EXT: today's listing, overrides the defaults above

    def effective(self, today: str) -> "NGO":
        """The listing the agent should use on `today` (YYYY-MM-DD): defaults with today's changes on top."""
        t = self.today
        if t is None or t.date != today:
            return self
        n = self.model_copy(deep=True)
        if t.meals_needed is not None:
            n.current_demand.meals_needed = t.meals_needed
        if t.urgency is not None:
            n.current_demand.urgency = t.urgency
        if t.available_capacity_today is not None:
            n.capacity.available_capacity_today = min(t.available_capacity_today, n.capacity.daily_meal_capacity)
        if t.receiving_hours is not None:
            n.receiving_hours = t.receiving_hours
        return n


# --------------------------------------------------------------------------- results
class SelectedNGO(BaseModel):
    ngo_id: str
    name: str
    allocated_quantity: int
    match_score: float
    confirmation: str
    location: GeoPoint
    estimated_travel_minutes: float
    distance_km: float


class MatchResult(BaseModel):
    match_id: str
    food_passport_id: Optional[str]
    mode: Mode
    strategy: Strategy
    status: MatchStatus
    selected_ngos: list[SelectedNGO] = Field(default_factory=list)
    total_quantity: Optional[float] = None
    allocated_quantity: int = 0
    unallocated_quantity: Optional[float] = None
    reasoning: list[str] = Field(default_factory=list)
    reasoning_source: str = ""
    attempts: list[dict[str, Any]] = Field(default_factory=list)
    missing_fields: list[str] = Field(default_factory=list)
    next_action: str
    logistics_handoff: Optional[dict[str, Any]] = None
    rescue_deadline: Optional[str] = None
    created_at: str
    finalized_at: Optional[str] = None
