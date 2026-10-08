"""LUNA ORCHESTRATOR: the only component that knows both agents.

    restaurant submission
        -> FOOD AGENT  (image + metadata + safety policy + rescue score)
        -> Food Passport   <== the ONLY thing passed between the agents
        -> NGO MATCHING AGENT  (started automatically, nobody clicks anything)
        -> Match Result  -> ready for the (future) Logistics Agent

The Food Agent never calls the NGO Agent and vice versa; the contract is the Food Passport
(in) and the Match Result (out). The restaurant-facing view exposes plain-language progress only.

In LUNA-SPEC terms this is the Decision Agent for the case (§13): it runs the agents in order and
keeps the donor updated with a status bar, a NOW / NEXT line and a timeline (§14.4).
"""
from __future__ import annotations

import threading
import time
import traceback
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Callable, Optional
from zoneinfo import ZoneInfo

from .agent.llm import LLMError
from .config import DATA_DIR
from .food import tags as food_tags
from .db import DatabaseError, Repository
from .food import policies as fp
from .food.agent import FoodAgent, FoodRuleBasedPolicy, food_llm_policy
from .food.models import SubmissionError, decode_image, parse_submission
from .food.vision import build_vision
from .models import TERMINAL_STATUSES
from .service import LunaService

STEP_DEFS = [("food", "Food checked"), ("approved", "Approved for rescue"),
             ("ngo_found", "NGO found"), ("ngo_confirmed", "NGO confirmed")]
# donor status bar (LUNA-SPEC §14.4)
PROGRESS = [("listed", "Listed"), ("checked", "Checked"), ("offered", "Offered"), ("accepted", "NGO accepted"),
            ("partner", "Partner coming"), ("picked_up", "Picked up"), ("delivered", "Delivered")]
RANK_STATE = {"AWAITING_CONFIRMATION": "Offered · waiting", "ACCEPTED": "Accepted", "REJECTED": "Declined",
              "NO_RESPONSE": "No reply", "UNAVAILABLE": "Went offline", "CANDIDATE": "In line", "EXCLUDED": "Can't take it"}
IST = ZoneInfo("Asia/Kolkata")


def _clock(iso: Optional[str]) -> Optional[str]:
    """'7:45 pm' in India time (spec §0.2: 12-hour clock in UI copy)."""
    if not iso:
        return None
    t = datetime.fromisoformat(iso).astimezone(IST)
    return f"{t.hour % 12 or 12}:{t.minute:02d} {'am' if t.hour < 12 else 'pm'}"


def _plus(iso: str, seconds: Optional[float]) -> str:
    return (datetime.fromisoformat(iso) + timedelta(seconds=seconds or 0)).isoformat()


def _ranking(snap: dict[str, Any]) -> list[dict[str, Any]]:
    """The listed NGOs as the NGO Agent ranked them for this food: priority order, what happened
    with each, and why an NGO couldn't take it. Plain values for the donor's screen."""
    out, rank = [], 0
    for c in snap.get("candidates") or []:  # already sorted: in-line/tried first, best score first
        m = c.get("metrics") or {}
        in_line = c["feasible"] or c["match_status"] in ("AWAITING_CONFIRMATION", "ACCEPTED", "REJECTED",
                                                          "NO_RESPONSE", "UNAVAILABLE")
        rank += 1 if in_line else 0
        out.append({
            "rank": rank if in_line else None, "name": c["name"], "priority": round(c.get("raw_score") or 0),
            "state": RANK_STATE.get(c["match_status"], c["match_status"]),
            "distance_km": m.get("distance_km"), "meals_needed": m.get("meals_needed"),
            "urgency": m.get("demand_urgency"),
            "why_not": None if in_line else ((c.get("exclusion_reasons") or [c.get("match_exclusion")])[0]),
        })
    return out[:12]

DEMO_SCRIPTS: dict[str, dict[str, dict]] = {
    "accept_all": {},
    # the top-ranked NGO rejects; the NGO Agent must replan on its own (shown only in /ops)
    "first_rejects": {"NGO-0042": {"response": "REJECTED", "delay_s": 3, "reason": "Kitchen volunteers unavailable tonight"}},
}


def parse_donor(d: Any) -> dict[str, Any]:
    """The signed-in donor (from the Luna app) stands in for the configured demo restaurant."""
    errors: dict[str, str] = {}
    if not isinstance(d, dict):
        raise SubmissionError({"donor": "Donor details are missing."})
    did = str(d.get("id") or "").strip()[:40]
    name = " ".join(str(d.get("name") or "").split())[:120]
    if not did:
        errors["donor"] = "Donor id is missing."
    if not name:
        errors["donor"] = "Please add your business or household name to your profile."
    try:
        lat, lng = float(d.get("latitude")), float(d.get("longitude"))
        if not (-90 <= lat <= 90 and -180 <= lng <= 180):
            raise ValueError
    except (TypeError, ValueError):
        errors["donor"] = "Pickup location is missing."
        lat = lng = 0.0
    if errors:
        raise SubmissionError(errors)
    return {"restaurant_id": did, "name": name, "latitude": lat, "longitude": lng}


class LunaOrchestrator:
    def __init__(self, svc: LunaService, vision_factory: Optional[Callable] = None, upload_dir: Optional[Path] = None,
                 food_brain: str = "auto", ngo_brain: str = "auto", in_memory_uploads: bool = False):
        self.svc = svc
        self.cfg = svc.cfg
        self.flow = self.cfg["flow"]
        self.mode = self.flow["mode"].upper()
        if self.mode not in ("LIVE", "DEMO"):
            raise ValueError("flow.mode must be LIVE or DEMO")
        self.repo: Repository = svc.repos[self.mode]
        self.upload_dir = Path(upload_dir or (DATA_DIR / "uploads"))
        self.vision_factory = vision_factory or (lambda cfg: build_vision(cfg, svc.food_provider_factory))
        self.food_brain, self.ngo_brain = food_brain, ngo_brain
        self.threads: dict[str, threading.Thread] = {}

    # ------------------------------------------------------------------ public API
    def info(self) -> dict[str, Any]:
        return {"mode": self.mode, "restaurant": self.flow["restaurant"]["name"]}

    def submit(self, payload: dict[str, Any], wait: bool = False) -> str:
        """Validates and stores the submission, then runs the whole flow in the background."""
        sid = "SUB-" + uuid.uuid4().hex[:8].upper()
        errors: dict[str, str] = {}
        raw, mime, img_err = decode_image(payload.get("image"), int(self.flow["max_image_mb"] * 1024 * 1024))
        if img_err:
            errors["image"] = img_err
        sub = None
        restaurant = self.flow["restaurant"]
        try:
            if payload.get("donor") is not None:
                restaurant = parse_donor(payload["donor"])
            sub = parse_submission(payload, sid, restaurant)
        except SubmissionError as e:
            errors.update(e.errors)
        if errors:
            raise SubmissionError(errors)
        sub.image_mime = mime
        self.upload_dir.mkdir(parents=True, exist_ok=True)
        path = self.upload_dir / f"{sid}.{ {'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp'}[mime] }"
        path.write_bytes(raw)
        sub.image_path = str(path)
        seq = self.repo.create_submission(sid, self.mode, sub.restaurant_id, sub.food_name, sub.to_form(), str(path))
        self.repo.add_event(sid, "system", "Food submission received from restaurant.", {"restaurant": sub.restaurant_id})
        t = threading.Thread(target=self._run, args=(sub, raw, seq, restaurant), name=f"luna-{sid}", daemon=True)
        self.threads[sid] = t
        t.start()
        if wait:
            t.join()
        return sid

    def check_food(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Food Agent only, synchronously: grade one listing's photo and details for the Luna app.

        The app owns NGO matching and delivery, so this never starts the NGO Matching Agent.
        Same validation, rules and vision as submit(); the run is stored for the audit trail."""
        sid = "CHK-" + uuid.uuid4().hex[:8].upper()
        errors: dict[str, str] = {}
        raw, mime, img_err = decode_image(payload.get("image"), int(self.flow["max_image_mb"] * 1024 * 1024))
        if img_err:
            errors["image"] = img_err
        sub = None
        restaurant = self.flow["restaurant"]
        try:
            if payload.get("donor") is not None:
                restaurant = parse_donor(payload["donor"])
            sub = parse_submission(payload, sid, restaurant)
        except SubmissionError as e:
            errors.update(e.errors)
        if errors:
            raise SubmissionError(errors)
        sub.image_mime = mime
        self.upload_dir.mkdir(parents=True, exist_ok=True)
        path = self.upload_dir / f"{sid}.{ {'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp'}[mime] }"
        path.write_bytes(raw)
        sub.image_path = str(path)
        seq = self.repo.create_submission(sid, self.mode, sub.restaurant_id, sub.food_name, sub.to_form(), str(path))
        self._stage(sid, "ANALYZING_FOOD")
        # One AI call per listing by default: the photo. The safety rules decide either way.
        policy = FoodRuleBasedPolicy() if self.cfg["llm"].get("food_check_reasoning", "rules") == "rules" else self._food_policy()
        agent = FoodAgent(self.repo, self.cfg, policy, self.vision_factory(self.cfg), self.mode)
        a = agent.run(sub, raw, seq, restaurant)
        self._stage(sid, {"ELIGIBLE": "CHECKED", "INELIGIBLE": "NOT_ELIGIBLE", "NEEDS_REVIEW": "NEEDS_REVIEW"}.get(a["decision"], "ERROR"),
                    assessment=a)
        v = a.get("vision") or {}
        tag_checks = food_tags.review(sub, v)
        # which models actually answered (the chain may have fallen back)
        prov = getattr(agent.policy, "provider", None)
        reasoning = getattr(prov, "last_label", None) or getattr(prov, "label", None) if prov else None
        photo_model = str(v.get("source") or "").removeprefix("VLM · ") if v.get("verified") else None
        return {
            "check_id": sid, "models": {"photo": photo_model, "reasoning": reasoning or "rules"}, "decision": a["decision"], "freshness": a.get("freshness"),
            "restaurant_message": a.get("restaurant_message"), "reasons": a.get("reasons_user") or [],
            "safe_minutes_remaining": a.get("safe_minutes_remaining"), "reasoning_source": a.get("reasoning_source"),
            "explanation": a.get("explanation"),
            "photo": {"checked": bool(v.get("verified")), "seen": v.get("food_visible") or "", "condition": v.get("condition"),
                      "matches": v.get("matches_description"), "diet_seen": v.get("diet_seen") or "unclear",
                      "tag_checks": tag_checks, "tags_verdict": food_tags.verdict(tag_checks), "signs": (v.get("spoilage_signs") or []) + (v.get("contamination_signs") or []),
                      "confidence": v.get("confidence"), "notes": v.get("notes") or "", "source": v.get("source")},
        }

    def public_view(self, sid: str) -> Optional[dict[str, Any]]:
        row = self.repo.get_submission(sid)
        return self._public(row) if row else None

    def ops_view(self, sid: str) -> Optional[dict[str, Any]]:
        row = self.repo.get_submission(sid)
        if not row:
            return None
        a = row["assessment"] or {}
        return {
            "submission_id": sid, "stage": row["stage"], "mode": row["mode"], "form": row["form"],
            "assessment": {k: v for k, v in a.items() if k != "passport"}, "food_passport": a.get("passport"),
            "match_id": row["match_id"], "match_result": row["match_result"], "error": row["error"],
            "ready_for_logistics": bool(row["match_result"] and row["match_result"].get("logistics_handoff")),
            "events": self.repo.list_events(sid),
        }

    # ------------------------------------------------------------------ the flow
    def _food_policy(self):
        try:
            provider = self.svc.food_provider_factory(self.cfg)
        except LLMError:
            provider = None
        if self.food_brain == "rules" or provider is None:
            if self.food_brain == "llm":
                raise LLMError("LLM requested but not configured")
            if self.food_brain != "rules" and not self.cfg["agent_limits"]["allow_rule_based_fallback"]:
                raise LLMError("No LLM configured and rule-based fallback is disabled.")
            return FoodRuleBasedPolicy()
        return food_llm_policy(provider, self.cfg["agent_limits"]["llm_max_retries"])

    def _stage(self, sid: str, stage: str, **extra: Any) -> None:
        self.repo.update_submission(sid, stage=stage, **extra)

    def _run(self, sub, raw: bytes, seq: int, restaurant: Optional[dict[str, Any]] = None) -> None:
        sid = sub.submission_id
        try:
            self._stage(sid, "ANALYZING_FOOD")
            agent = FoodAgent(self.repo, self.cfg, self._food_policy(), self.vision_factory(self.cfg), self.mode,
                              step_delay_s=self.flow["demo_step_delay_seconds"] if self.mode == "DEMO" else 0.0)
            assessment = agent.run(sub, raw, seq, restaurant or self.flow["restaurant"])
            passport = assessment.get("passport")
            decision = assessment["decision"]
            if decision != "ELIGIBLE" or not passport:
                stage = {"INELIGIBLE": "NOT_ELIGIBLE", "NEEDS_REVIEW": "NEEDS_REVIEW"}.get(decision, "ERROR")
                self._stage(sid, stage, assessment=assessment)
                return
            # ---- Food Passport -> NGO Agent, automatically
            self._stage(sid, "FINDING_NGO", assessment=assessment, passport_id=passport["passport_id"])
            self.repo.add_event(sid, "handoff", f"Food Passport {passport['passport_id']} issued; starting the NGO Matching Agent automatically.",
                                {"passport_id": passport["passport_id"]})
            responses = None
            if self.mode == "DEMO":
                self.svc.seed_flow_demo_ngos()
                responses = DEMO_SCRIPTS.get(self.flow.get("demo_script", "accept_all"), {})
            match_id = self.svc.start_match(passport, self.mode, scenario="flow" if self.mode == "DEMO" else None,
                                            brain=self.ngo_brain, responses=responses, wait=False)
            self.repo.update_submission(sid, match_id=match_id)
            self.repo.add_event(sid, "handoff", f"NGO Matching Agent running as {match_id}.", {"match_id": match_id})
            self._watch_match(sid, match_id)
        except LLMError as e:
            self._error(sid, f"LLM unavailable: {e}")
        except DatabaseError as e:
            self._error(sid, f"Database error: {e}", db=True)
        except Exception as e:
            traceback.print_exc()
            self._error(sid, f"Unexpected error: {e.__class__.__name__}: {e}")

    def _watch_match(self, sid: str, match_id: str) -> None:
        deadline = time.monotonic() + self.flow["ngo_wait_timeout_seconds"]
        last = None
        while time.monotonic() < deadline:
            v = self.svc.get_match_view(match_id)
            if v is None:
                time.sleep(0.2)
                continue
            status = v["status"]
            if not v["running"] and status in {s.value for s in TERMINAL_STATUSES}:
                stage = {"MATCHED": "MATCHED", "PARTIALLY_MATCHED": "PARTIAL", "NO_FEASIBLE_MATCH": "NO_NGO",
                         "WINDOW_EXPIRED": "NO_NGO"}.get(status, "ERROR")
                self._stage(sid, stage, match_result=v["result"])
                self.repo.add_event(sid, "result", f"NGO match finished: {status}.", {"match_id": match_id})
                return
            stage = "AWAITING_NGO" if status == "AWAITING_CONFIRMATION" else "FINDING_NGO"
            if stage != last:
                self._stage(sid, stage)
                last = stage
            time.sleep(0.25)
        self._error(sid, "Timed out waiting for the NGO Matching Agent")

    def _error(self, sid: str, why: str, db: bool = False) -> None:
        if db:
            return
        try:
            self._stage(sid, "ERROR", error=why)
            self.repo.add_event(sid, "error", why, None)
        except DatabaseError:
            pass

    # ------------------------------------------------------------------ restaurant-facing view
    def _freshness(self, row: dict[str, Any], a: dict[str, Any]) -> Optional[dict[str, Any]]:
        """The Food Agent's grade. Listings assessed before grading existed are graded now, as of
        the moment they were listed, from the same stored form and photo verdict (deterministic)."""
        if a.get("freshness") or not a or a.get("decision") == "ERROR":
            return a.get("freshness")
        try:
            form = dict(row["form"] or {})
            at = datetime.fromisoformat(form.get("submitted_at") or row["created_at"])
            form["allergens"] = form.get("allergens_declared")
            sub = parse_submission(form, row["submission_id"], self.flow["restaurant"], now=at)
            vision = a.get("vision") or {}
            safety = fp.evaluate_safety(sub, vision, self.cfg, row["mode"], now=at)
            return fp.freshness(safety, vision, self.cfg, now=at)
        except (SubmissionError, KeyError, TypeError, ValueError):
            return None

    def _case(self, row: dict[str, Any]) -> dict[str, Any]:
        """Decision Agent view of the case (LUNA-SPEC §13, §14.4): status bar, NOW / NEXT and the
        timeline, built from what the agents recorded. Plain language only, no internals."""
        stage = row["stage"]
        a = row["assessment"] or {}
        fresh = self._freshness(row, a)
        mv = self.svc.get_match_view(row["match_id"]) if row.get("match_id") else None
        snap = (mv or {}).get("state") or {}
        attempts = snap.get("attempts") or []
        confs = {c["confirmation_id"]: c for c in (mv or {}).get("confirmations", [])}
        accepted = [c for c in confs.values() if c["status"] == "ACCEPTED"]
        assigned = bool(accepted) and all(c.get("partner_name") for c in accepted)
        picked = bool(accepted) and all(c.get("picked_up_at") for c in accepted)
        delivered = bool(accepted) and all(c.get("otp_verified_at") for c in accepted)
        ngo_names = {t["ngo_id"]: t["name"] for t in attempts}
        timeout = self.cfg["confirmation"]["live_timeout_seconds" if row["mode"] == "LIVE" else "demo_timeout_seconds"]

        qty = (row["form"] or {}).get("quantity")
        tl: list[dict[str, Any]] = [{"at": row["created_at"], "text": f"Listed · {qty} portions of {row['food_name']}", "tone": "done"}]
        checked_at = next((e["ts"] for e in self.repo.list_events(row["submission_id"]) if e["kind"] == "result"), None)
        if fresh and checked_at:
            if fresh["grade"] == "D":
                tl.append({"at": checked_at, "text": "Checked · not safe for people", "tone": "bad"})
            else:
                tl.append({"at": checked_at, "tone": "done", "text": f"Checked · Grade {fresh['grade']} ({fresh['label']}) · "
                                                                      f"safe till {_clock(fresh['safe_until'])}"})
        elif stage == "NEEDS_REVIEW" and checked_at:
            tl.append({"at": checked_at, "text": "Checked · needs a person to look at it", "tone": "bad"})
        waiting = None
        for t in attempts:
            tl.append({"at": t["requested_at"], "text": f"Offered to {t['name']}", "tone": "done"})
            answered = _plus(t["requested_at"], t.get("responded_after_seconds"))
            if t["outcome"] == "AWAITING_CONFIRMATION":
                waiting = t
            elif t["outcome"] == "ACCEPTED":
                c = next((c for c in accepted if c["ngo_id"] == t["ngo_id"]), {})
                eta = f" · reaches them ~{_clock(c['eta_at'])}" if c.get("eta_at") else ""
                tl.append({"at": answered, "text": f"Accepted by {t['name']} · {t['quantity']} portions{eta}", "tone": "good"})
            else:
                why = {"REJECTED": "couldn't take it", "NO_RESPONSE": "didn't reply in time",
                       "UNAVAILABLE": "went offline"}.get(t["outcome"], "couldn't take it")
                tl.append({"at": answered, "text": f"{t['name']} {why}", "tone": "bad"})
        for c in accepted:
            ngo = ngo_names.get(c["ngo_id"], "The NGO")
            if c.get("assigned_at"):
                tl.append({"at": c["assigned_at"], "text": f"{ngo} sent {c['partner_name']} to collect it", "tone": "done"})
            if c.get("picked_up_at"):
                tl.append({"at": c["picked_up_at"], "text": f"Picked up by {c['partner_name']} · pickup code confirmed", "tone": "good"})
            if c.get("otp_verified_at"):
                tl.append({"at": c["otp_verified_at"], "text": f"Delivered to {ngo} · drop code confirmed", "tone": "good"})
        tl.sort(key=lambda e: e["at"] or "")  # all stored times are UTC ISO

        # status bar: listed → checked → offered → accepted → picked up → delivered
        bar = {k: "pending" for k, _ in PROGRESS}
        bar["listed"] = "done"
        if stage in ("RECEIVED", "ANALYZING_FOOD"):
            bar["checked"] = "active"
        elif stage in ("NOT_ELIGIBLE", "NEEDS_REVIEW") or (stage == "ERROR" and not a.get("passport")):
            bar["checked"] = "failed"
        else:
            bar["checked"] = "done"
            bar["offered"] = "done" if attempts else "active"
            if stage == "NO_NGO":
                bar["offered" if not attempts else "accepted"] = "failed"
            elif accepted:
                bar["accepted"] = "done"
                bar["partner"] = "done" if assigned else "active"
                if assigned:
                    bar["picked_up"] = "done" if picked else "active"
                if picked:
                    bar["delivered"] = "done" if delivered else "active"
            elif attempts:
                bar["accepted"] = "active"

        safe_till = _clock(fresh["safe_until"]) if fresh and fresh.get("safe_until") else None
        names = " and ".join(t["name"] for t in attempts if t["outcome"] == "ACCEPTED")
        if stage in ("RECEIVED", "ANALYZING_FOOD"):
            now, nxt, tone = "Checking your food", "Grade and safe-until time", "working"
        elif stage == "NOT_ELIGIBLE":
            now, nxt, tone = "Not safe for people", "Please discard it safely. Don't give it to anyone.", "bad"
        elif stage == "NEEDS_REVIEW":
            now, nxt, tone = "A Luna team member needs to check it", "We'll update you here", "bad"
        elif stage == "NO_NGO":
            now = "No NGO available right now"
            nxt = (f"Please don't keep it past {safe_till}." if safe_till else "Please discard it safely.")
            tone = "bad"
        elif delivered:
            now, nxt, tone = f"Delivered to {names}", None, "good"
        elif picked:
            now, nxt, tone = f"Picked up · on the way to {names}", f"Delivered when {names} confirms the drop code", "good"
        elif assigned:
            partners = " and ".join(c["partner_name"] for c in accepted)
            now = f"{partners} is coming to collect it"
            nxt, tone = "Give them the pickup code below when you hand over the food", "good"
        elif stage in ("MATCHED", "PARTIAL"):
            now = f"{names} accepted"
            nxt, tone = f"{names} is sending a delivery partner", "good"
        elif waiting:
            left = _plus(waiting["requested_at"], timeout)
            now = f"Waiting for {waiting['name']} to reply (until {_clock(left)})"
            nxt, tone = "If they can't take it, we ask the next NGO", "working"
        elif stage in ("FINDING_NGO", "AWAITING_NGO") and names:
            now, nxt, tone = f"{names} accepted", "Confirming the hand-off", "good"
        elif stage in ("FINDING_NGO", "AWAITING_NGO"):
            now = "Asking the next NGO" if attempts else "Finding the right NGO"
            nxt, tone = "Offer to the best NGO for your food", "working"
        else:
            now, nxt, tone = "Something went wrong", "Please try again in a moment", "bad"
        # the donor holds the pickup code until the partner has collected the food
        pickup = [{"code": c["pickup_otp"], "partner_name": c["partner_name"], "ngo_name": ngo_names.get(c["ngo_id"])}
                  for c in accepted if c.get("pickup_otp") and not c.get("picked_up_at")]
        return {"freshness": fresh, "timeline": tl, "progress": [{"key": k, "label": lbl, "state": bar[k]} for k, lbl in PROGRESS],
                "status": {"now": now, "next": nxt, "tone": tone, "by": "Decision Agent"},
                "open": stage in ("MATCHED", "PARTIAL") and not delivered, "safe_till": safe_till,
                "pickup": pickup, "ranking": _ranking(snap)}

    def _public(self, row: dict[str, Any]) -> dict[str, Any]:
        stage = row["stage"]
        a = row["assessment"] or {}
        m = row["match_result"] or {}
        form = row["form"] or {}
        eligible = a.get("decision") == "ELIGIBLE"
        case = self._case(row)
        states = {k: "pending" for k, _ in STEP_DEFS}
        if stage in ("RECEIVED", "ANALYZING_FOOD"):
            states["food"] = "active"
        else:
            states["food"] = "done" if a and a.get("decision") != "ERROR" else "failed"
            if stage in ("NOT_ELIGIBLE", "NEEDS_REVIEW"):
                states["approved"] = "failed"
            elif eligible:
                states["approved"] = "done"
                states["ngo_found"] = "active"
            if stage == "AWAITING_NGO":
                states.update(ngo_found="done", ngo_confirmed="active")
            elif stage in ("MATCHED", "PARTIAL"):
                states.update(ngo_found="done", ngo_confirmed="done")
            elif stage == "NO_NGO":
                states["ngo_found"] = "failed"
            elif stage == "ERROR" and eligible:
                states["ngo_found"] = "failed"
        ngos = [{"name": n["name"], "portions": n["allocated_quantity"], "eta_minutes": round(n["estimated_travel_minutes"])}
                for n in (m.get("selected_ngos") or []) if n.get("confirmation") == "ACCEPTED"]
        done = stage in ("MATCHED", "PARTIAL", "NOT_ELIGIBLE", "NEEDS_REVIEW", "NO_NGO", "ERROR")
        qty = form.get("quantity")
        if stage in ("RECEIVED", "ANALYZING_FOOD"):
            head, msg = "Analyzing your food…", "We're checking the photo and details."
        elif stage == "FINDING_NGO":
            head, msg = "Approved — finding the best NGO…", a.get("restaurant_message") or ""
        elif stage == "AWAITING_NGO":
            head, msg = "Waiting for the NGO to confirm…", "We've asked an NGO to accept your donation."
        elif stage == "MATCHED":
            head = "Your food has a home"
            who = " and ".join(f"{n['name']} ({n['portions']} portions)" for n in ngos)
            msg = f"{who} confirmed. Pickup will be arranged next."
        elif stage == "PARTIAL":
            head = "Part of your food has a home"
            who = " and ".join(f"{n['name']} ({n['portions']} portions)" for n in ngos)
            left = (m.get("unallocated_quantity") or 0)
            msg = f"{who} confirmed. We're still looking for a home for the remaining {left} portions."
        elif stage == "NOT_ELIGIBLE":
            head, msg = "This food can't be rescued", a.get("restaurant_message") or ""
        elif stage == "NEEDS_REVIEW":
            head, msg = "We need a closer look", a.get("restaurant_message") or ""
        elif stage == "NO_NGO":
            head = "No NGO available"
            tried = sum(1 for _ in case["timeline"] if _["text"].startswith("Offered to"))
            msg = (f"We couldn't place {qty} portions in time"
                   + (f" after asking {tried} NGO{'s' if tried != 1 else ''}" if tried else ": no NGO nearby can take it right now")
                   + (f". Please don't keep it past {case['safe_till']}." if case["safe_till"] else "."))
        else:
            head, msg = "Something went wrong", "We couldn't finish this right now. Please try again in a moment."
        return {
            "submission_id": row["submission_id"], "stage": stage, "done": done, "headline": head, "message": msg,
            "steps": [{"key": k, "label": lbl, "state": states[k]} for k, lbl in STEP_DEFS],
            "food": {"name": row["food_name"], "quantity": qty, "unit": form.get("quantity_unit", "portions"),
                     "category": form.get("food_category"), "prepared_at": form.get("prepared_at")},
            "created_at": row.get("created_at"),
            # the Food Agent's grade + the Decision Agent's live case status (plain values only)
            "freshness": case["freshness"],
            "status": case["status"], "progress": case["progress"], "timeline": case["timeline"],
            "open": case["open"], "pickup": case["pickup"], "ranking": case["ranking"],
            "reasons": (a.get("reasons_user") or []) if stage in ("NOT_ELIGIBLE", "NEEDS_REVIEW") else [],
            "rescue_score": round(a["rescue_score"]) if eligible and a.get("rescue_score") is not None else None,
            "ngos": ngos if stage in ("MATCHED", "PARTIAL") else [],
            "mode": row["mode"],
        }
