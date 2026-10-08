"""Working state of one matching run (the agent's short-term memory).

Tools mutate this deterministically; policies (LLM or rule-based fallback)
read it. A snapshot is persisted to the `matches` table after every step so
the dashboard and API never depend on in-memory state.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Optional

from ..engine.passport import FoodContext
from ..models import CandidateStatus, MatchStatus


@dataclass
class AgentState:
    match_id: str
    mode: str
    scenario: Optional[str]
    raw_passport: dict[str, Any]
    received_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    # progress
    status: MatchStatus = MatchStatus.RECEIVED
    passport_loaded: bool = False
    validation: Optional[dict[str, Any]] = None
    food: Optional[FoodContext] = None
    candidate_pool: Optional[list[str]] = None           # ngo_ids found by search
    invalid_ngo_records: list[dict] = field(default_factory=list)
    ranking: Optional[dict[str, Any]] = None             # last rank output (compact)
    ranking_stale: bool = True
    evaluations: dict[str, dict] = field(default_factory=dict)   # latest full eval per ngo
    split_options: Optional[dict[str, Any]] = None

    # decisions
    proposal: Optional[dict[str, Any]] = None            # {strategy, allocations:[{ngo_id,name,quantity,status,score}], reasoning}
    candidate_status: dict[str, str] = field(default_factory=dict)
    excluded: dict[str, str] = field(default_factory=dict)       # match-level exclusions ngo_id -> reason
    accepted: list[dict[str, Any]] = field(default_factory=list)
    attempts: list[dict[str, Any]] = field(default_factory=list)
    needs_replan: bool = False
    replans: int = 0

    # bookkeeping
    iterations: int = 0
    tool_calls: int = 0
    finalize_warnings: int = 0
    finalized: bool = False
    result: Optional[dict[str, Any]] = None
    brain: str = ""
    brain_history: list[str] = field(default_factory=list)
    decision_reasoning: list[str] = field(default_factory=list)
    operator_messages: list[str] = field(default_factory=list)

    # ------------------------------------------------------------------ derived
    @property
    def total_quantity(self) -> int:
        return self.food.quantity if self.food else 0

    @property
    def accepted_quantity(self) -> int:
        return sum(a["quantity"] for a in self.accepted)

    @property
    def pending_quantity(self) -> int:
        if not self.proposal:
            return 0
        return sum(a["quantity"] for a in self.proposal["allocations"] if a["status"] == "AWAITING_CONFIRMATION")

    @property
    def unplaced_quantity(self) -> int:
        return max(0, self.total_quantity - self.accepted_quantity - self.pending_quantity)

    def set_candidate_status(self, ngo_id: str, status: CandidateStatus) -> None:
        self.candidate_status[ngo_id] = status.value

    def untried_feasible(self) -> list[dict]:
        if not self.ranking:
            return []
        return [r for r in self.ranking.get("ranked", [])
                if r["ngo_id"] not in self.excluded and self.candidate_status.get(r["ngo_id"]) not in
                ("ACCEPTED", "REJECTED", "NO_RESPONSE", "UNAVAILABLE", "AWAITING_CONFIRMATION")]

    # ------------------------------------------------------------------ UI / persistence snapshot
    def snapshot(self) -> dict[str, Any]:
        now = datetime.now(timezone.utc)
        cands = []
        for ngo_id, ev in self.evaluations.items():
            cands.append({
                "ngo_id": ngo_id, "name": ev["name"], "feasible": ev["feasible"], "match_score": ev["match_score"],
                "raw_score": ev["raw_score"], "factors": ev["factors"], "contributions": ev["contributions"],
                "metrics": ev["metrics"], "checks": ev["checks"], "strengths": ev["strengths"],
                "concerns": ev["concerns"], "exclusion_reasons": ev["exclusion_reasons"],
                "reliability": {k: ev["reliability"][k] for k in ("acceptance_rate", "successful_distribution_rate",
                                                                   "insufficient_history", "baseline_source", "notes")},
                "location": ev["location"], "ngo_status": ev["status"],
                "match_status": self.candidate_status.get(ngo_id, "CANDIDATE" if ev["feasible"] else "EXCLUDED"),
                "match_exclusion": self.excluded.get(ngo_id),
            })
        tried = ("REJECTED", "UNAVAILABLE", "NO_RESPONSE", "ACCEPTED", "AWAITING_CONFIRMATION")
        cands.sort(key=lambda c: (0 if (c["feasible"] or c["match_status"] in tried) else 1, -c["raw_score"]))
        return {
            "status": self.status.value,
            "food": self.food.summary(now) if self.food else None,
            "validation": {k: v for k, v in (self.validation or {}).items() if k != "food"} if self.validation else None,
            "candidates": cands,
            "funnel": (self.ranking or {}).get("funnel"),
            "candidates_found": len(self.candidate_pool or []),
            "proposal": self.proposal,
            "accepted": self.accepted,
            "attempts": self.attempts,
            "split_options": self.split_options,
            "decision_reasoning": self.decision_reasoning,
            "replans": self.replans,
            "brain": self.brain, "brain_history": self.brain_history,
            "iterations": self.iterations, "tool_calls": self.tool_calls,
            "accepted_quantity": self.accepted_quantity, "pending_quantity": self.pending_quantity,
            "unplaced_quantity": self.unplaced_quantity if self.food else None,
            "invalid_ngo_records": self.invalid_ngo_records,
        }
