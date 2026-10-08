"""FOOD AGENT.

Receives a restaurant submission + mandatory photo and produces an eligibility
assessment and - only if ELIGIBLE - a Food Passport (the contract consumed by
the NGO Matching Agent).

   LLM   : chooses the order of tools, interprets the VLM/rule results, may raise
           extra concerns (stricter only), writes the message shown to the restaurant.
   VLM   : inspect_food_image (visual condition of the photo).
   RULES : check_submission_consistency, evaluate_food_safety, calculate_rescue_score,
           create_food_passport are deterministic (food/policies.py) and cannot be overridden.
   STATE : every step and the assessment are persisted (agent_events / submissions).
"""
from __future__ import annotations

import itertools
import time
import traceback
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Optional

from ..agent.llm import LLMError
from ..agent.policies import LLMPolicy, Policy
from ..db import DatabaseError, Repository
from . import policies as fp
from .models import FoodSubmission
from .vision import BasicImageInspector, VisionError


# =========================================================================== tool specs
def _obj(props: dict, required: list[str] | None = None) -> dict:
    return {"type": "object", "properties": props, "required": required or []}


FOOD_TOOL_SPECS: list[dict[str, Any]] = [
    {"name": "inspect_food_image",
     "description": "Vision model inspects the submitted photo: is it food, does it match the description, visible condition, "
                    "spoilage/contamination signs, packaging, photo quality, confidence.", "parameters": _obj({})},
    {"name": "check_submission_consistency",
     "description": "Deterministic cross-check of the photo analysis against the declared metadata (storage vs temperature, "
                    "photo vs food name). Requires inspect_food_image first.", "parameters": _obj({})},
    {"name": "evaluate_food_safety",
     "description": "Deterministic food-safety policy: time since preparation vs category/storage limits, temperature, visual "
                    "condition, risk score and decision (ELIGIBLE / NEEDS_REVIEW / INELIGIBLE). You may add concerns you noticed "
                    "(they can only make the outcome stricter).",
     "parameters": _obj({"additional_concerns": {"type": "array", "items": _obj({
         "concern": {"type": "string"}, "severity": {"type": "string", "enum": ["minor", "major"]}}, ["concern"])}})},
    {"name": "calculate_rescue_score",
     "description": "Luna Rescue Score (0-100) from safety, remaining time, quantity and image confidence.", "parameters": _obj({})},
    {"name": "finalize_assessment",
     "description": "Finish. Records the decision and, if ELIGIBLE, creates the Food Passport and hands it to the Luna "
                    "Orchestrator. Provide the short friendly message shown to the restaurant.",
     "parameters": _obj({"restaurant_message": {"type": "string",
                                                 "description": "1-2 warm, plain-English sentences for the restaurant. No jargon, no scores, no tool names."}},
                        ["restaurant_message"])},
]

FOOD_SYSTEM_PROMPT = """You are LUNA's Food Agent. A restaurant submitted surplus food with a photo. Decide whether it is safe and sensible to rescue, then hand an eligible Food Passport to the NGO Matching Agent.

HOW YOU WORK
- You act only through tools. Typical order: inspect_food_image -> check_submission_consistency -> evaluate_food_safety -> calculate_rescue_score -> finalize_assessment.
- The safety DECISION comes from the deterministic policy tool. You cannot override it or loosen it. You MAY pass additional_concerns to evaluate_food_safety when you notice something the rules miss (e.g. the photo and ingredients disagree, the food looks reheated, packaging looks damaged) - this can only make the outcome stricter. Use severity "major" only when a human should look at it.
- Never invent facts about the food. Use only tool results and the submission.
- Finish with finalize_assessment and a warm, short restaurant_message: if eligible, say it is being matched to an NGO; if not, say plainly why in everyday words and what they could do (e.g. retake a clearer photo). Do not mention scores, tools, models or policies.
- Before each tool call write ONE short plain sentence (max 20 words) saying what you are checking."""


# =========================================================================== state + context
@dataclass
class FoodState:
    sub: FoodSubmission
    mode: str
    image: bytes
    brain: str = ""
    vision: Optional[dict] = None
    consistency: Optional[dict] = None
    safety: Optional[dict] = None
    score: Optional[dict] = None
    assessment: Optional[dict] = None
    iterations: int = 0
    tool_calls: int = 0
    finalized: bool = False
    extra_concerns: list = field(default_factory=list)
    vision_notice: Optional[str] = None


@dataclass
class FoodContext:
    state: FoodState
    cfg: dict[str, Any]
    vision: Any
    emit: Callable[[str, str, Optional[dict]], None]
    seq: int
    restaurant: dict[str, Any]
    now: Callable[[], datetime] = field(default=lambda: datetime.now(timezone.utc))


class FoodToolError(Exception):
    pass


# =========================================================================== tools
def t_inspect_food_image(ctx: FoodContext, args: dict) -> dict:
    s = ctx.state
    ctx.emit("step", "Inspecting the food photo.", None)
    try:
        v = ctx.vision.inspect(s.image, s.sub.image_mime, s.sub)
    except VisionError as e:
        if s.mode == "DEMO":
            v = BasicImageInspector().inspect(s.image, s.sub.image_mime, s.sub)
            s.vision_notice = f"Vision model failed ({str(e)[:120]}); fell back to basic image check (DEMO only)."
            ctx.emit("warning", s.vision_notice, None)
        else:
            raise FoodToolError(f"Vision model unavailable: {e}")
    s.vision = v
    ctx.emit("step", "Photo analysed." if v["verified"] else "Photo received (no vision model configured - condition not assessed).", None)
    return {"vision": v}


def t_check_submission_consistency(ctx: FoodContext, args: dict) -> dict:
    s = ctx.state
    if s.vision is None:
        raise FoodToolError("Call inspect_food_image first.")
    s.consistency = fp.check_consistency(s.sub, s.vision, ctx.cfg)
    ctx.emit("step", "Cross-checking the photo against the submitted details.", None)
    return s.consistency


def t_evaluate_food_safety(ctx: FoodContext, args: dict) -> dict:
    s = ctx.state
    if s.vision is None:
        raise FoodToolError("Call inspect_food_image first.")
    concerns = args.get("additional_concerns") or []
    if not isinstance(concerns, list):
        raise FoodToolError("additional_concerns must be a list")
    s.extra_concerns = [c for c in concerns if isinstance(c, dict)]
    s.safety = fp.evaluate_safety(s.sub, s.vision, ctx.cfg, s.mode, ctx.now(), s.extra_concerns)
    s.score = None
    ctx.emit("step", "Applying food-safety rules (time, temperature, condition).", None)
    out = dict(s.safety)
    out["note"] = "Decision is final and cannot be overridden." if s.safety["decision"] != "ELIGIBLE" else \
        "Eligible under the safety policy."
    return out


def t_calculate_rescue_score(ctx: FoodContext, args: dict) -> dict:
    s = ctx.state
    if s.safety is None:
        raise FoodToolError("Call evaluate_food_safety first.")
    s.score = fp.rescue_score(s.safety, s.sub, s.vision, ctx.cfg)
    ctx.emit("step", "Calculating the Luna Rescue Score.", None)
    return s.score


def default_message(sub: FoodSubmission, safety: dict[str, Any]) -> str:
    d = safety["decision"]
    if d == "ELIGIBLE":
        return f"Great news — your {sub.food_name} can be rescued. We're finding the best NGO for it right now."
    if d == "NEEDS_REVIEW":
        why = (safety["review_reasons_user"] or ["We couldn't verify this food automatically."])[0]
        return f"{why} Please retake a clearer photo, or ask a team member to check it."
    why = (safety["hard_failures_user"] or ["It doesn't meet our food-safety rules."])[0]
    return f"Sorry, we can't rescue this one. {why}"


def build_passport(sub: FoodSubmission, safety: dict, score: dict, vision: dict, seq: int, restaurant: dict,
                   cfg: dict, now: datetime) -> dict[str, Any]:
    window = int(min(safety["safe_minutes_remaining"], cfg["food_safety"]["max_rescue_window_minutes"]))
    tags = fp.derive_dietary_tags(sub)
    return {
        "passport_id": f"PASS-LUNA-F{seq}", "food_id": f"LUNA-F{seq}",
        "restaurant_id": sub.restaurant_id, "restaurant_name": sub.restaurant_name,
        "food_name": sub.food_name, "food_category": sub.food_category,
        "quantity": sub.quantity, "quantity_unit": sub.quantity_unit,
        "prepared_at": sub.prepared_at.isoformat(), "issued_at": now.isoformat(),
        "storage_method": sub.storage_method, "storage_temperature": sub.storage_temperature,
        "ingredients": sub.ingredients or None, "allergens": sub.allergens,
        "dietary_tags": tags or None,
        "eligibility": {"decision": "ELIGIBLE", "risk_level": safety["risk_level"], "risk_score": safety["risk_score"]},
        "rescue_window": {"remaining_minutes": window},
        "restaurant_location": {"latitude": restaurant["latitude"], "longitude": restaurant["longitude"]},
        "luna_rescue_score": score["score"], "image_verified": bool(vision.get("verified")),
        "issued_by": "FOOD_AGENT",
    }


def t_finalize_assessment(ctx: FoodContext, args: dict) -> dict:
    s = ctx.state
    if s.safety is None:
        raise FoodToolError("Call evaluate_food_safety first.")
    if s.score is None:
        s.score = fp.rescue_score(s.safety, s.sub, s.vision, ctx.cfg)
    msg = " ".join(str(args.get("restaurant_message") or "").split())[:320]
    if len(msg) < 8:
        msg = default_message(s.sub, s.safety)
    # the message can never contradict the deterministic decision
    low = msg.lower()
    if s.safety["decision"] != "ELIGIBLE" and any(w in low for w in ("great news", "can be rescued", "approved", "finding the best ngo")):
        msg = default_message(s.sub, s.safety)
    passport = None
    d = s.safety["decision"]
    fresh = fp.freshness(s.safety, s.vision, ctx.cfg, ctx.now())
    ctx.emit("step", f"Freshness graded {fresh['grade']} ({fresh['score']}/100)"
                     + ("." if fresh["photo_checked"] else " from time and storage only (photo not judged by AI)."), None)
    if d == "ELIGIBLE":
        passport = build_passport(s.sub, s.safety, s.score, s.vision, ctx.seq, ctx.restaurant, ctx.cfg, ctx.now())
        passport["freshness"] = {"score": fresh["score"], "grade": fresh["grade"]}
    s.assessment = {
        "decision": d, "risk_level": s.safety["risk_level"], "risk_score": s.safety["risk_score"],
        "rescue_score": s.score["score"], "freshness": fresh, "restaurant_message": msg,
        "reasons": s.safety["hard_failures"] + s.safety["review_reasons"],
        "reasons_user": s.safety["hard_failures_user"] + s.safety["review_reasons_user"],
        "checks": (s.consistency or {}).get("checks", []) + s.safety["checks"],
        "vision": s.vision, "vision_notice": s.vision_notice, "score_detail": s.score,
        "safe_minutes_remaining": s.safety["safe_minutes_remaining"], "passport": passport,
        "explanation": fp.explain_grade(s.sub, s.safety, s.vision, fresh, ctx.cfg),
        "reasoning_source": s.brain,
    }
    s.finalized = True
    ctx.emit("result", {"ELIGIBLE": "Eligible - Food Passport created.", "NEEDS_REVIEW": "Needs a manual check.",
                        "INELIGIBLE": "Not eligible for rescue."}[d], {"decision": d})
    return {"decision": d, "passport_created": passport is not None,
            "passport_id": passport["passport_id"] if passport else None}


FOOD_TOOLS: dict[str, Callable[[FoodContext, dict], dict]] = {
    "inspect_food_image": t_inspect_food_image,
    "check_submission_consistency": t_check_submission_consistency,
    "evaluate_food_safety": t_evaluate_food_safety,
    "calculate_rescue_score": t_calculate_rescue_score,
    "finalize_assessment": t_finalize_assessment,
}


def execute_food_tool(ctx: FoodContext, name: str, args: dict) -> dict:
    fn = FOOD_TOOLS.get(name)
    if fn is None:
        return {"error": f"Unknown tool '{name}'. Available: {', '.join(FOOD_TOOLS)}"}
    if not isinstance(args, dict) or "__invalid_json__" in args:
        return {"error": "Tool arguments were not valid JSON."}
    try:
        return fn(ctx, args)
    except FoodToolError as e:
        return {"error": str(e)}
    except (KeyError, TypeError, ValueError) as e:
        return {"error": f"Invalid arguments for {name}: {e}"}


# =========================================================================== policies
class FoodRuleBasedPolicy(Policy):
    """Transparent fallback used only when no LLM is configured/available. Labelled everywhere."""
    kind = "rules"
    label = "Rule-based fallback (no LLM)"

    def __init__(self):
        self._ids = itertools.count(1)

    def _call(self, name, text, **args):
        return {"text": text, "tool_calls": [{"id": f"fr_{next(self._ids)}", "name": name, "arguments": args}]}

    def next_step(self, s: FoodState) -> dict[str, Any]:
        if s.vision is None:
            return self._call("inspect_food_image", "Inspecting the photo.")
        if s.consistency is None:
            return self._call("check_submission_consistency", "Cross-checking photo and details.")
        if s.safety is None:
            return self._call("evaluate_food_safety", "Applying the food-safety rules.")
        if s.score is None:
            return self._call("calculate_rescue_score", "Calculating the rescue score.")
        return self._call("finalize_assessment", "Recording the decision.",
                          restaurant_message=default_message(s.sub, s.safety))


def food_llm_policy(provider, max_retries: int) -> LLMPolicy:
    return LLMPolicy(provider, max_retries, system_prompt=FOOD_SYSTEM_PROMPT, tools=FOOD_TOOL_SPECS)


# =========================================================================== runner
class FoodAgent:
    def __init__(self, repo: Repository, cfg: dict[str, Any], policy: Policy, vision, mode: str,
                 allow_fallback: Optional[bool] = None, step_delay_s: float = 0.0):
        self.repo, self.cfg, self.policy, self.vision, self.mode = repo, cfg, policy, vision, mode
        self.allow_fallback = cfg["agent_limits"]["allow_rule_based_fallback"] if allow_fallback is None else allow_fallback
        self.step_delay_s = step_delay_s

    def run(self, sub: FoodSubmission, image: bytes, seq: int, restaurant: dict[str, Any]) -> dict[str, Any]:
        st = FoodState(sub=sub, mode=self.mode, image=image, brain=self.policy.label)
        sid = sub.submission_id

        def emit(kind, message, data=None):
            try:
                self.repo.add_event(sid, kind, message, data)
            except DatabaseError:
                pass
        ctx = FoodContext(st, self.cfg, self.vision, emit, seq, restaurant)
        emit("system", f"Food Agent started ({self.mode}). Reasoning engine: {self.policy.label}. Vision: {self.vision.label}.",
             {"brain": self.policy.label, "vision": self.vision.label})
        if isinstance(self.policy, LLMPolicy):
            import json
            self.policy.messages = [{"role": "user", "content": "A restaurant submitted surplus food with a photo. Assess it "
                                    "and finish with finalize_assessment. Submission: " + json.dumps(sub.summary())}]
        started = time.monotonic()
        max_iter, max_calls = 12, 16
        try:
            while not st.finalized:
                if st.iterations >= max_iter or st.tool_calls >= max_calls or time.monotonic() - started > 180:
                    emit("system", "Food Agent safety limit reached; stopping.", None)
                    return self._fail(st, "Safety limit reached")
                st.iterations += 1
                try:
                    step = self.policy.next_step(st)
                except LLMError as e:
                    if isinstance(self.policy, LLMPolicy) and self.allow_fallback:
                        emit("warning", "AI reasoning unavailable - continuing with the rule-based safety policy (not LLM reasoning).",
                             {"error": str(e)[:300]})
                        self.policy = FoodRuleBasedPolicy()
                        st.brain = self.policy.label + " (after LLM failure)"
                        continue
                    return self._fail(st, f"AI reasoning unavailable: {e}")
                if step.get("text"):
                    emit("thought", ("" if self.policy.kind == "llm" else "[Rule-based] ") + step["text"].strip()[:300], None)
                for call in step.get("tool_calls") or []:
                    st.tool_calls += 1
                    result = execute_food_tool(ctx, call["name"], call.get("arguments") or {})
                    if "error" in result:
                        emit("guardrail", f"Safety check: {result['error']}", {"tool": call["name"]})
                        if "Vision model unavailable" in result["error"]:
                            # live mode cannot judge the photo: do not guess
                            return self._fail(st, result["error"], decision="NEEDS_REVIEW")
                    self.policy.observe(call, _to_json(result))
                    if st.finalized:
                        break
                if self.step_delay_s and not st.finalized:
                    time.sleep(self.step_delay_s)
        except DatabaseError as e:
            return self._fail(st, f"Database error: {e}")
        except Exception as e:  # never crash the orchestrator thread
            traceback.print_exc()
            return self._fail(st, f"Unexpected error: {e.__class__.__name__}")
        st.assessment["reasoning_source"] = st.brain
        return st.assessment

    def _fail(self, st: FoodState, why: str, decision: str = "ERROR") -> dict[str, Any]:
        msg = {"NEEDS_REVIEW": "We couldn't check your photo automatically right now, so a team member needs to verify this food.",
               "ERROR": "We couldn't analyze this right now. Please try again in a moment."}[decision]
        a = {"decision": decision, "risk_level": None, "risk_score": None, "rescue_score": None, "freshness": None,
             "restaurant_message": msg, "reasons": [why], "reasons_user": [msg], "checks": [], "vision": st.vision,
             "vision_notice": st.vision_notice, "passport": None, "reasoning_source": st.brain}
        try:
            self.repo.add_event(st.sub.submission_id, "error", f"Food Agent stopped safely: {why}", None)
        except DatabaseError:
            pass
        return a


def _to_json(obj: Any, limit: int = 8000) -> str:
    import json
    s = json.dumps(obj, default=str, ensure_ascii=False)
    return s if len(s) <= limit else s[:limit] + '..."(truncated)"'
