"""Deterministic construction of the MatchResult returned to the Orchestrator.
Outcome/status is computed from recorded facts (confirmations in the DB),
never taken from the LLM's word."""
from __future__ import annotations

from collections import Counter
from datetime import datetime, timezone
from typing import Any, Optional

from ..models import MatchResult, MatchStatus, Mode, SelectedNGO, Strategy, TERMINAL_STATUSES
from .state import AgentState


def compute_outcome(state: AgentState, now: Optional[datetime] = None) -> MatchStatus:
    now = now or datetime.now(timezone.utc)
    v = state.validation
    if v is not None and not v.get("valid"):
        if v.get("missing_fields"):
            return MatchStatus.NEEDS_INFORMATION
        if any("expired" in e for e in v.get("errors", [])):
            return MatchStatus.WINDOW_EXPIRED
        return MatchStatus.NO_FEASIBLE_MATCH
    if not state.food:
        return MatchStatus.FAILED
    if state.accepted_quantity >= state.total_quantity:
        return MatchStatus.MATCHED
    if state.accepted_quantity > 0:
        return MatchStatus.PARTIALLY_MATCHED
    if state.food.remaining_minutes(now) <= 0:
        return MatchStatus.WINDOW_EXPIRED
    return MatchStatus.NO_FEASIBLE_MATCH


NEXT_ACTION = {
    MatchStatus.MATCHED: "HANDOFF_TO_LOGISTICS",
    MatchStatus.PARTIALLY_MATCHED: "HANDOFF_TO_LOGISTICS_AND_ESCALATE_REMAINDER",
    MatchStatus.NO_FEASIBLE_MATCH: "ESCALATE_TO_ORCHESTRATOR",
    MatchStatus.WINDOW_EXPIRED: "ESCALATE_TO_ORCHESTRATOR",
    MatchStatus.NEEDS_INFORMATION: "REQUEST_MISSING_PASSPORT_DATA",
    MatchStatus.FAILED: "MANUAL_REVIEW",
    MatchStatus.AWAITING_CONFIRMATION: "AWAITING_NGO_CONFIRMATION",
}


def exclusion_summary(state: AgentState) -> list[str]:
    lines = []
    stage_counter = Counter()
    for ev in state.evaluations.values():
        if not ev["feasible"]:
            stage_counter[ev["first_failed_stage"]] += 1
    labels = {"status": "closed, unavailable or at capacity", "distance": "too far / outside service area",
              "compatibility": "incompatible with this food", "capacity": "insufficient capacity or demand",
              "receiving_hours": "not receiving at arrival time", "rescue_window": "cannot be reached within the rescue window"}
    for stage, n in stage_counter.most_common():
        lines.append(f"{n} NGO(s) {labels.get(stage, stage)}")
    shown = 0
    for ev in sorted(state.evaluations.values(), key=lambda e: -e["raw_score"]):
        if not ev["feasible"] and ev["ngo_id"] not in state.excluded and shown < 8:
            lines.append(f"{ev['name']}: {ev['exclusion_reasons'][0]}")
            shown += 1
    for ngo_id, reason in state.excluded.items():
        name = state.evaluations.get(ngo_id, {}).get("name", ngo_id)
        lines.append(f"{name}: {reason}")
    return lines


def build_result(state: AgentState, final: bool, now: Optional[datetime] = None) -> dict[str, Any]:
    now = now or datetime.now(timezone.utc)
    status = compute_outcome(state, now) if final else state.status
    if final and state.status == MatchStatus.FAILED:
        status = MatchStatus.FAILED
    n_acc = len(state.accepted)
    strategy = Strategy.SINGLE_NGO if n_acc == 1 else Strategy.SPLIT_DONATION if n_acc > 1 else Strategy.NO_MATCH
    if not final and state.proposal and n_acc == 0:
        strategy = Strategy(state.proposal.get("strategy", "SINGLE_NGO"))

    selected = []
    source = state.accepted if (final or n_acc) else []
    if not final and state.proposal:
        source = [a for a in state.proposal["allocations"] if a["status"] in ("AWAITING_CONFIRMATION", "ACCEPTED", "PROPOSED")]
    for a in source:
        ev = state.evaluations.get(a["ngo_id"], {})
        selected.append(SelectedNGO(
            ngo_id=a["ngo_id"], name=a.get("name") or ev.get("name", a["ngo_id"]),
            allocated_quantity=a["quantity"], match_score=a.get("match_score") or ev.get("match_score", 0),
            confirmation=a.get("status", "ACCEPTED"),
            location=ev.get("location") or {"latitude": 0, "longitude": 0},
            estimated_travel_minutes=ev.get("metrics", {}).get("travel_minutes", 0),
            distance_km=ev.get("metrics", {}).get("distance_km", 0)))

    reasoning = list(state.decision_reasoning)
    missing = (state.validation or {}).get("missing_fields", []) if state.validation else []
    if final and status in (MatchStatus.NO_FEASIBLE_MATCH, MatchStatus.WINDOW_EXPIRED, MatchStatus.PARTIALLY_MATCHED):
        reasoning += [f"Evidence: {l}" for l in exclusion_summary(state)]
    if final and state.validation and not state.validation.get("valid"):
        reasoning += [f"Passport issue: {e}" for e in state.validation.get("errors", [])]
        reasoning += [f"Missing required field: {m}" for m in missing]

    handoff = None
    if final and state.accepted and state.food:
        f = state.food
        handoff = {
            "for_agent": "LOGISTICS_AGENT",
            "pickup": {"restaurant_id": f.restaurant_id, "restaurant_name": f.restaurant_name,
                       "location": {"latitude": f.latitude, "longitude": f.longitude},
                       "food_name": f.food_name, "food_category": f.category, "total_quantity": state.accepted_quantity},
            "dropoffs": [{
                "ngo_id": a["ngo_id"], "name": a["name"], "quantity": a["quantity"],
                "location": state.evaluations.get(a["ngo_id"], {}).get("location"),
                "receiving_hours": a.get("receiving_hours"), "confirmation_id": a.get("confirmation_id"),
                "estimated_travel_minutes": state.evaluations.get(a["ngo_id"], {}).get("metrics", {}).get("travel_minutes"),
                "food_eta_at": a.get("eta_at"),
                # what the NGO asked the delivery partner to bring (utensils, containers...)
                "delivery_notes": a.get("delivery_notes"),
                # the NGO holds the OTP; the delivery partner must collect it at hand-over
                "otp_required": True,
            } for a in state.accepted],
            "deliver_by": f.deadline.isoformat(),
            "remaining_rescue_minutes": round(f.remaining_minutes(now), 1),
        }

    unalloc = (state.total_quantity - state.accepted_quantity) if state.food else None
    result = MatchResult(
        match_id=state.match_id,
        food_passport_id=(state.raw_passport or {}).get("passport_id"),
        mode=Mode(state.mode), strategy=strategy, status=status, selected_ngos=selected,
        total_quantity=state.total_quantity if state.food else (state.raw_passport or {}).get("quantity"),
        allocated_quantity=state.accepted_quantity, unallocated_quantity=unalloc,
        reasoning=reasoning, reasoning_source=state.brain,
        attempts=state.attempts, missing_fields=missing,
        next_action=NEXT_ACTION.get(status, "MATCHING_IN_PROGRESS" if status not in TERMINAL_STATUSES else "MANUAL_REVIEW"),
        logistics_handoff=handoff,
        rescue_deadline=state.food.deadline.isoformat() if state.food else None,
        created_at=state.received_at.isoformat(),
        finalized_at=now.isoformat() if final else None,
    )
    return result.model_dump(mode="json")
