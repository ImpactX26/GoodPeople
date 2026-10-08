"""The autonomous agent loop.

OBSERVE -> VALIDATE -> PLAN -> SEARCH -> EVALUATE -> ACT -> OBSERVE RESULT
-> UPDATE STATE -> REPLAN IF NECESSARY -> FINALIZE

The policy (LLM) picks the next tool; tools act + compute; the runner enforces
hard limits (iterations, tool calls, wall clock, rescue deadline) so the loop
can never run forever, and fails safely on LLM / database errors.
"""
from __future__ import annotations

import threading
import time
import traceback
import uuid
from datetime import datetime, timezone
from typing import Any, Callable, Optional

from ..db import DatabaseError, Repository, utcnow
from ..engine.passport import validate_food_passport
from ..models import MatchStatus, TERMINAL_STATUSES
from .confirmation import ConfirmationChannel
from .llm import LLMError
from .policies import LLMPolicy, Policy, RuleBasedPolicy
from .result import build_result
from .state import AgentState
from .tools import ToolContext, execute_tool, t_finalize_match, to_json


class NGOMatchingAgent:
    def __init__(self, repo: Repository, cfg: dict[str, Any], channel: ConfirmationChannel, policy: Policy,
                 allow_fallback: Optional[bool] = None, step_delay_s: float = 0.0,
                 on_finalized: Optional[Callable[[dict], None]] = None):
        self.repo, self.cfg, self.channel, self.policy = repo, cfg, channel, policy
        lim = cfg["agent_limits"]
        self.allow_fallback = lim["allow_rule_based_fallback"] if allow_fallback is None else allow_fallback
        self.step_delay_s = step_delay_s
        self.on_finalized = on_finalized
        self._stop = threading.Event()
        self.state: Optional[AgentState] = None

    # ------------------------------------------------------------------ helpers
    def stop(self) -> None:
        self._stop.set()

    def _emit(self, kind: str, message: str, data: Optional[dict] = None) -> None:
        try:
            self.repo.add_event(self.state.match_id, kind, message, data)
        except DatabaseError:
            pass  # events are best-effort; state persistence failures are handled in run()

    def _switch_brain(self, policy: Policy, why: str) -> None:
        self.policy = policy
        s = self.state
        s.brain = policy.label
        s.brain_history.append(f"{policy.label} ({why})")

    # ------------------------------------------------------------------ main loop
    def run(self, state: AgentState) -> dict[str, Any]:
        self.state = s = state
        lim = self.cfg["agent_limits"]
        ctx = ToolContext(state=s, repo=self.repo, cfg=self.cfg, channel=self.channel, emit=self._emit,
                          should_stop=self._stop.is_set)
        started = time.monotonic()
        s.brain = self.policy.label
        s.brain_history.append(self.policy.label)
        self._emit("system", f"NGO Matching Agent started in {s.mode} mode. Reasoning engine: {self.policy.label}.",
                   {"brain": self.policy.label, "mode": s.mode})
        try:
            self.policy.start(s)
            while not s.finalized:
                # ---- guardrails
                if self._stop.is_set():
                    self._force_finalize(ctx, "Run stopped by operator.")
                    break
                if s.iterations >= lim["max_iterations"]:
                    self._force_finalize(ctx, f"Safety limit reached ({lim['max_iterations']} reasoning steps).")
                    break
                if s.tool_calls >= lim["max_tool_calls"]:
                    self._force_finalize(ctx, f"Safety limit reached ({lim['max_tool_calls']} tool calls).")
                    break
                if time.monotonic() - started > lim["wall_clock_timeout_seconds"]:
                    self._force_finalize(ctx, "Agent run timed out.")
                    break
                if s.food and s.food.remaining_minutes() <= 0:
                    self._emit("warning", "Rescue window has closed.", None)
                    self._force_finalize(ctx, "The rescue window closed before a full match was confirmed.")
                    break
                while s.operator_messages:
                    msg = s.operator_messages.pop(0)
                    self.policy.add_operator_message(msg)
                    self._emit("system", f"Operator: {msg}", None)

                # ---- decide
                s.iterations += 1
                try:
                    step = self.policy.next_step(s)
                except LLMError as e:
                    if isinstance(self.policy, LLMPolicy) and self.allow_fallback:
                        self._emit("warning", "AI reasoning service unavailable — continuing with Luna's transparent "
                                              "rule-based safety policy (not LLM reasoning).", {"error": str(e)[:300]})
                        self._switch_brain(RuleBasedPolicy(), "LLM failure")
                        continue
                    self._fail(f"AI reasoning unavailable and fallback disabled: {e}")
                    break
                if step.get("text"):
                    prefix = "" if self.policy.kind == "llm" else "[Rule-based] "
                    self._emit("thought", prefix + step["text"].strip()[:400], None)

                # ---- act + observe
                for call in step.get("tool_calls") or []:
                    if s.tool_calls >= lim["max_tool_calls"]:
                        break
                    s.tool_calls += 1
                    result = execute_tool(ctx, call["name"], call.get("arguments") or {})
                    if "error" in result:
                        self._emit("guardrail", f"Safety check: {result['error']}", {"tool": call["name"]})
                    self.policy.observe(call, to_json(result))
                    if s.finalized:
                        break
                if self.step_delay_s and not s.finalized:
                    time.sleep(self.step_delay_s)
        except DatabaseError as e:
            self._fail(f"Database error: {e}", db_down=True)
        except Exception as e:  # never crash the server thread
            self._fail(f"Unexpected agent error: {e.__class__.__name__}: {e}")
            traceback.print_exc()
        finally:
            if hasattr(self.channel, "cancel_all"):
                self.channel.cancel_all()
        if s.result and self.on_finalized:
            try:
                self.on_finalized(s.result)
            except Exception:
                pass
        return s.result or build_result(s, final=True)

    def _force_finalize(self, ctx: ToolContext, reason: str) -> None:
        s = self.state
        self._emit("system", reason, None)
        out = execute_tool(ctx, "finalize_match", {"reasoning": [reason], "force_reason": reason})
        if "error" in out:
            self._fail(f"Could not finalize safely: {out['error']}")

    def _fail(self, message: str, db_down: bool = False) -> None:
        s = self.state
        s.status = MatchStatus.FAILED
        s.finalized = True
        s.decision_reasoning = s.decision_reasoning + [message]
        s.result = build_result(s, final=True)
        s.result["status"] = "FAILED"
        s.result["next_action"] = "MANUAL_REVIEW"
        self._emit("error", f"Agent stopped safely: {message}", None)
        if not db_down:
            try:
                self.repo.update_match(s.match_id, status="FAILED", state=s.snapshot(), result=s.result,
                                       finalized_at=utcnow().isoformat())
            except DatabaseError:
                pass


# =========================================================================== orchestration helpers
def new_match_id(raw_passport: dict) -> str:
    base = (raw_passport or {}).get("food_id") or (raw_passport or {}).get("passport_id") or "UNKNOWN"
    return f"MATCH-{base}-{uuid.uuid4().hex[:5].upper()}"


def prepare_match(repo: Repository, raw_passport: dict, mode: str, scenario: Optional[str] = None,
                  match_id: Optional[str] = None) -> AgentState:
    match_id = match_id or new_match_id(raw_passport)
    state = AgentState(match_id=match_id, mode=mode, scenario=scenario, raw_passport=raw_passport or {})
    pre = validate_food_passport(raw_passport or {}, state.received_at)
    deadline = pre["food"].deadline if pre["food"] else None
    repo.create_match(match_id, (raw_passport or {}).get("passport_id"), mode, scenario, deadline)
    repo.save_passport((raw_passport or {}).get("passport_id"), match_id, raw_passport or {})
    repo.add_event(match_id, "system", "Food Passport received from Food Agent.",
                   {"passport_id": (raw_passport or {}).get("passport_id")})
    repo.update_match(match_id, state=state.snapshot(), result=build_result(state, final=False))
    return state
